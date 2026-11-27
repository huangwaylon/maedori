// 前撮り メモ — reference clips and photos with notes, stored in our own Cloudflare Worker (D1 + R2).
// View mode (default) is read-only and needs nothing. Edit mode asks once for the passcode, then lets you
// write notes, drag rows by the grip (or ↑/↓ on a focused grip) to reorder, and upload photos/videos.
"use strict";

(() => {
  const API = window.MAEDORI_API; // set in index.html
  const ASSET_V = "11"; // keep in step with ?v= in index.html so phones fetch updated repo files
  const CACHE_KEY = "maedori:cache";
  const PASS_KEY = "maedori:passcode";
  const COLLAPSED_KEY = "maedori:collapsed";
  const POLL_MS = 15000;
  const SAVE_DELAY_MS = 800;
  const EDGE_PX = 100;
  const MAX_IMAGE_PX = 2048;
  const MAX_UPLOAD_BYTES = 95 * 1024 * 1024; // the Worker's limit
  const GRIP_SVG =
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  const CHEVRON_SVG =
    '<svg class="chev" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 7.5l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const main = document.getElementById("sections");
  const statusEl = document.getElementById("status");
  const modeBtn = document.getElementById("mode");
  const addBtn = document.getElementById("add");
  const fileInput = document.getElementById("file");
  const passDialog = document.getElementById("pass-dialog");
  const uploadDialog = document.getElementById("upload-dialog");
  const emptyEl = document.getElementById("empty");

  // null-prototype maps, so names like "constructor" are safe as section/item keys
  const cards = Object.create(null); // item id -> card element
  const lists = Object.create(null); // section -> list element
  const sectionEls = Object.create(null); // section -> <section>
  const UNSYNCED_KEY = "maedori:unsynced";
  const unsynced = Object.assign(Object.create(null), readJSON(UNSYNCED_KEY) || {}); // notes typed here, not saved yet
  let data = loadCache(); // { sections: [names], items: [{ id, kind, section, note, w, h, start, end, media, poster }] }
  let orderDirty = false;
  let editing = false;
  let drag = null;
  let writing = Promise.resolve();
  let writeGen = 0; // bumped by every write, so an older poll can't overwrite newer data
  let saveTimer, statusTimer;
  const collapsed = new Set(readJSON(COLLAPSED_KEY) || []);

  // ---------- small helpers ----------
  function readJSON(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  }

  const saveUnsynced = () => localStorage.setItem(UNSYNCED_KEY, JSON.stringify(unsynced));

  function loadCache() {
    const d = readJSON(CACHE_KEY);
    return d && Array.isArray(d.sections) && Array.isArray(d.items) ? d : { sections: [], items: [] };
  }

  // uploads live in the Worker (KV); the original clips/photos are files in this repo
  const mediaUrl = (key) => (key.startsWith("uploads/") ? `${API}/media/${key}` : `${key}?v=${ASSET_V}`);
  const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;

  function setStatus(text, { warn = false, fade = false } = {}) {
    clearTimeout(statusTimer);
    statusEl.textContent = text;
    statusEl.classList.toggle("warn", warn);
    if (fade) statusTimer = setTimeout(() => (statusEl.textContent = ""), 2000);
  }

  async function api(path, { method = "GET", body, pass = localStorage.getItem(PASS_KEY) } = {}) {
    const headers = {};
    if (method !== "GET" && pass) headers.authorization = `Bearer ${pass}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${API}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, cache: "no-store" });
    if (res.status === 401) {
      localStorage.removeItem(PASS_KEY);
      throw Object.assign(new Error("passcode"), { auth: true });
    }
    if (!res.ok) throw Object.assign(new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`), { status: res.status });
    return res.json();
  }

  // ---------- render ----------
  function ensureSection(name) {
    if (sectionEls[name]) return;
    const el = document.createElement("section");
    el.innerHTML =
      `<h2 class="section-head"><button class="section-toggle" type="button">` +
      `${CHEVRON_SVG}<span class="name"></span><span class="count"></span></button></h2><div class="list"></div>`;
    el.querySelector(".name").textContent = name;
    const list = el.querySelector(".list");
    list.dataset.section = name;
    list.id = `list-${Object.keys(sectionEls).length}`;
    const btn = el.querySelector(".section-toggle");
    btn.setAttribute("aria-controls", list.id);
    btn.addEventListener("click", () => setCollapsed(name, !collapsed.has(name), true));
    lists[name] = list;
    sectionEls[name] = el;
    setCollapsed(name, collapsed.has(name), false);
  }

  function setCollapsed(section, on, jump) {
    on ? collapsed.add(section) : collapsed.delete(section);
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
    lists[section].hidden = on;
    sectionEls[section].classList.toggle("collapsed", on);
    sectionEls[section].querySelector(".section-toggle").setAttribute("aria-expanded", String(!on));
    if (!jump) return;
    // bring the heading to the top: collapsing from deep inside a section, or opening one to jump there
    const barBottom = document.querySelector(".bar").getBoundingClientRect().bottom;
    const top = sectionEls[section].getBoundingClientRect().top;
    if (!on || top < barBottom) scrollTo({ top: top + scrollY - barBottom, behavior: on ? "auto" : "smooth" });
  }

  function makeCard(item) {
    const card = document.createElement("article");
    card.className = "card";
    card.dataset.id = item.id;
    const media =
      item.kind === "video"
        ? `<video muted loop playsinline preload="none"></video>`
        : `<img class="still" alt="" loading="lazy" decoding="async">`;
    card.innerHTML =
      `<div class="photo">${media}<img class="thumb" alt="" loading="lazy" decoding="async"></div>` +
      `<div class="caption"><span class="num"></span><p class="note"></p>` +
      `<textarea rows="1" placeholder="メモを追加" aria-label="メモ"></textarea>` +
      `<span class="time"></span>` +
      (item.id.startsWith("u") ? `<button class="remove" type="button">削除</button>` : "") +
      `</div><button class="grip" type="button" aria-label="並べ替え（ドラッグ、または↑↓キー）">${GRIP_SVG}</button>`;
    const still = item.poster || (item.kind === "image" ? item.media : "");
    card.dataset.poster = still;
    if (still) card.querySelector(".thumb").src = mediaUrl(still);
    if (item.kind === "video") {
      const video = card.querySelector("video");
      video.src = mediaUrl(item.media); // preload="none": nothing is fetched until it plays
      sizeMedia(video, item);
      video.addEventListener("click", () => {
        // remember a deliberate pause, so scrolling back doesn't restart it
        if (video.paused) {
          delete video.dataset.userPaused;
          video.play().catch(() => {});
        } else {
          video.dataset.userPaused = "1";
          video.pause();
        }
      });
      observer.observe(video);
      nearby.observe(video);
    } else {
      const img = card.querySelector(".still");
      img.src = mediaUrl(item.media);
      sizeMedia(img, item);
    }
    if (item.start != null) card.querySelector(".time").textContent = `元動画 ${fmt(item.start)}–${fmt(item.end)}`;

    const box = card.querySelector("textarea");
    box.addEventListener("input", () => {
      unsynced[item.id] = box.value;
      saveUnsynced();
      setNote(card, box.value.trim() ? box.value : "");
      grow(box);
      setStatus("保存中…");
      clearTimeout(saveTimer);
      saveTimer = setTimeout(flush, SAVE_DELAY_MS);
    });
    box.addEventListener("blur", flush);

    card.querySelector(".remove")?.addEventListener("click", () => removeItem(item.id));

    const grip = card.querySelector(".grip");
    // touch: the most reliable way to drag on iPhone Safari (preventDefault stops the page scrolling)
    grip.addEventListener("touchstart", (e) => startDrag(card, e.changedTouches[0].clientY, e, e.changedTouches[0].identifier), { passive: false });
    grip.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch") startDrag(card, e.clientY, e, `p${e.pointerId}`);
    });
    grip.addEventListener("keydown", (e) => {
      const step = { ArrowUp: -1, ArrowDown: 1 }[e.key];
      if (!step) return;
      e.preventDefault();
      moveBy(card, step);
      grip.focus();
    });
    return card;
  }

  // Show a note with any web links tappable (built with DOM nodes, so note text is never parsed as HTML)
  function setNote(card, text) {
    const el = card.querySelector(".note");
    if (el.dataset.text === text) return;
    el.dataset.text = text;
    el.replaceChildren();
    for (const part of text.split(/(https?:\/\/[^\s]+)/)) {
      if (!part) continue;
      if (/^https?:\/\//.test(part)) {
        const a = document.createElement("a");
        a.href = part;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = part.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
        el.append(a);
      } else el.append(part);
    }
  }

  function sizeMedia(el, item) {
    if (!el || !item.w || !item.h) return;
    el.style.aspectRatio = `${item.w} / ${item.h}`;
    el.style.width = `min(100%, calc(72vh * ${(item.w / item.h).toFixed(4)}))`;
  }

  function refreshMedia(card, item) {
    const still = item.poster || (item.kind === "image" ? item.media : "");
    if (card.dataset.poster === still) return;
    card.dataset.poster = still;
    if (still) card.querySelector(".thumb").src = mediaUrl(still);
    const v = card.querySelector("video");
    if (v && still && v.dataset.near) v.poster = mediaUrl(still); // otherwise set when it comes near
    sizeMedia(v || card.querySelector(".still"), item);
  }

  function grow(box) {
    if (!editing) return;
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight}px`;
  }

  function renumber() {
    for (const [name, list] of Object.entries(lists)) {
      const children = [...list.children];
      children.forEach((card, i) => (card.querySelector(".num").textContent = String(i + 1).padStart(2, "0")));
      sectionEls[name].querySelector(".count").textContent = `${children.length}枚`;
    }
  }

  // Build/refresh the page from `data`, never clobbering what is being typed or dragged here
  function render() {
    for (const name of data.sections) ensureSection(name);
    data.sections.forEach((name) => main.append(sectionEls[name])); // keeps section order
    const ids = new Set(data.items.map((i) => i.id));
    for (const [id, card] of Object.entries(cards)) {
      if (ids.has(id) || drag?.card === card) continue; // never pull the card out from under a finger
      const v = card.querySelector("video");
      if (v) {
        observer.unobserve(v);
        nearby.unobserve(v);
        visible.delete(v);
        v.pause();
      }
      card.remove();
      delete cards[id];
    }
    for (const item of data.items) {
      if (!cards[item.id]) cards[item.id] = makeCard(item);
      else refreshMedia(cards[item.id], item); // e.g. a video's poster arrived after the card was made
    }
    if (!drag && !orderDirty) {
      for (const name of data.sections) {
        const list = lists[name];
        data.items
          .filter((i) => i.section === name)
          .forEach((item, i) => {
            if (list.children[i] !== cards[item.id]) list.insertBefore(cards[item.id], list.children[i] || null);
          });
      }
    }
    for (const item of data.items) {
      const card = cards[item.id];
      const box = card.querySelector("textarea");
      if (item.id in unsynced || document.activeElement === box) continue;
      setNote(card, item.note);
      if (box.value !== item.note) {
        box.value = item.note;
        grow(box);
      }
    }
    renumber();
    syncPlayback();
    emptyEl.hidden = data.items.length > 0;
  }

  function domOrder() {
    const order = {};
    for (const name of data.sections) order[name] = [...lists[name].children].map((c) => c.dataset.id);
    return order;
  }

  function commitOrder() {
    renumber();
    orderDirty = true;
    setStatus("保存中…");
    flush();
  }

  // ---------- playback: only clips on screen, only in view mode ----------
  const visible = new Set();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target);
        else {
          visible.delete(e.target);
          e.target.pause();
        }
      }
      syncPlayback();
    },
    { threshold: 0.6 }
  );
  // Load a video's poster only when it is within about a screen of view (55 posters is ~2.5 MB)
  const nearby = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const v = e.target;
        v.dataset.near = "1";
        const still = v.closest(".card")?.dataset.poster;
        if (still) v.poster = mediaUrl(still);
        nearby.unobserve(v);
      }
    },
    { rootMargin: "100% 0px" }
  );

  function syncPlayback() {
    for (const v of visible) {
      if (editing || drag || v.dataset.userPaused) v.pause();
      else if (v.paused) v.play().catch(() => {}); // autoplay can be refused (Low Power Mode); tap plays
    }
  }

  // ---------- modes ----------
  function askPasscode() {
    const input = passDialog.querySelector("input");
    const error = passDialog.querySelector(".error");
    input.value = "";
    error.textContent = "";
    passDialog.returnValue = ""; // Escape leaves returnValue untouched; start clean so Escape means cancel
    passDialog.showModal();
    return new Promise((resolve) => {
      passDialog.onclose = async () => {
        const pass = input.value.trim();
        if (passDialog.returnValue !== "ok" || !pass) return resolve(false);
        try {
          await api("/api/check", { method: "POST", pass });
          localStorage.setItem(PASS_KEY, pass); // only keep a passcode the server accepted
          resolve(true);
        } catch (err) {
          error.textContent = err.auth ? "パスコードが違います" : "接続できません";
          passDialog.returnValue = "";
          passDialog.showModal(); // try again; onclose fires again
        }
      };
    });
  }

  async function setEditing(on, { save = true } = {}) {
    if (on && !localStorage.getItem(PASS_KEY) && !(await askPasscode())) return;
    editing = on;
    document.body.classList.toggle("editing", on);
    modeBtn.textContent = on ? "完了" : "編集";
    modeBtn.setAttribute("aria-pressed", String(on));
    syncPlayback();
    if (on) for (const card of Object.values(cards)) grow(card.querySelector("textarea"));
    else {
      document.activeElement?.blur();
      if (save) flush();
    }
    if (on && hasPending()) flush(); // edits kept from before (e.g. passcode had expired)
  }
  modeBtn.addEventListener("click", () => setEditing(!editing));

  // ---------- reorder ----------
  function moveBy(card, step) {
    const list = card.parentElement;
    const names = data.sections;
    const i = names.indexOf(list.dataset.section);
    if (step < 0) {
      const prev = card.previousElementSibling;
      if (prev) list.insertBefore(card, prev);
      else if (i > 0) {
        lists[names[i - 1]].append(card);
        setCollapsed(names[i - 1], false, false);
      } else return;
    } else {
      const next = card.nextElementSibling;
      if (next) list.insertBefore(card, next.nextElementSibling);
      else if (i < names.length - 1) {
        lists[names[i + 1]].prepend(card);
        setCollapsed(names[i + 1], false, false);
      } else return;
    }
    card.scrollIntoView({ block: "nearest" });
    commitOrder();
  }

  function startDrag(card, y, e, pointer) {
    if (!editing || drag) return;
    e.preventDefault();
    document.activeElement?.blur();
    drag = { card, pointer, y, before: JSON.stringify(domOrder()), raf: 0 };
    card.classList.add("dragging");
    document.body.classList.add("dragging");
    // listen on window: the card moves around the DOM while dragging
    addEventListener("touchmove", onTouchMove, { passive: false });
    addEventListener("touchend", onTouchEnd);
    addEventListener("touchcancel", onTouchEnd);
    addEventListener("pointermove", onPointerMove);
    addEventListener("pointerup", onPointerEnd);
    addEventListener("pointercancel", onPointerEnd);
    drag.raf = requestAnimationFrame(autoScroll);
  }

  const findTouch = (e) => [...e.changedTouches].find((t) => t.identifier === drag?.pointer);
  function onTouchMove(e) {
    const t = findTouch(e);
    if (!t) return;
    e.preventDefault();
    drag.y = t.clientY;
    place();
  }
  function onTouchEnd(e) {
    if (findTouch(e)) endDrag();
  }
  function onPointerMove(e) {
    if (!drag || drag.pointer !== `p${e.pointerId}`) return;
    drag.y = e.clientY;
    place();
  }
  function onPointerEnd(e) {
    if (drag && drag.pointer === `p${e.pointerId}`) endDrag();
  }

  // Move the dragged card to wherever the finger is now
  function place() {
    const y = drag.y;
    const all = Object.values(lists).filter((l) => !l.hidden); // can't drop into a collapsed section
    if (!all.length) return;
    let list = all.find((l) => {
      const r = l.getBoundingClientRect();
      return y >= r.top && y <= r.bottom;
    });
    if (!list) {
      list = all.reduce((best, l) => {
        const r = l.getBoundingClientRect();
        const d = Math.min(Math.abs(y - r.top), Math.abs(y - r.bottom));
        return !best || d < best.d ? { l, d } : best;
      }, null).l;
    }
    const next = [...list.children].find((c) => {
      if (c === drag.card) return false;
      const r = c.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    if (next) {
      if (next.previousElementSibling !== drag.card) list.insertBefore(drag.card, next);
    } else if (list.lastElementChild !== drag.card) {
      list.append(drag.card);
    }
  }

  function autoScroll() {
    if (!drag) return;
    const top = EDGE_PX + statusEl.getBoundingClientRect().bottom;
    const bottom = innerHeight - EDGE_PX;
    const speed = drag.y < top ? -(top - drag.y) / 5 : drag.y > bottom ? (drag.y - bottom) / 5 : 0;
    if (speed) {
      scrollBy(0, speed);
      place();
    }
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function endDrag() {
    removeEventListener("touchmove", onTouchMove);
    removeEventListener("touchend", onTouchEnd);
    removeEventListener("touchcancel", onTouchEnd);
    removeEventListener("pointermove", onPointerMove);
    removeEventListener("pointerup", onPointerEnd);
    removeEventListener("pointercancel", onPointerEnd);
    cancelAnimationFrame(drag.raf);
    drag.card.classList.remove("dragging");
    document.body.classList.remove("dragging");
    const changed = JSON.stringify(domOrder()) !== drag.before;
    drag = null;
    if (changed) commitOrder();
  }

  // ---------- sync ----------
  function show(remote) {
    data = remote;
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    render();
  }

  const hasPending = () => Object.keys(unsynced).length > 0 || orderDirty;

  async function writeUnsynced() {
    if (!localStorage.getItem(PASS_KEY)) return; // nothing can be saved until the passcode is entered again
    const batch = { ...unsynced };
    const sendOrder = orderDirty && !drag ? domOrder() : null;
    if (!Object.keys(batch).length && !sendOrder) return;
    writeGen++;
    try {
      let rejected = false;
      for (const [id, note] of Object.entries(batch)) {
        try {
          await api(`/api/notes/${encodeURIComponent(id)}`, { method: "PUT", body: { note } });
        } catch (err) {
          if (err.auth || !err.status || err.status >= 500) throw err; // offline / server trouble: retry later
          rejected = true; // e.g. the item was deleted on another phone: drop this note, keep syncing
        }
        if (unsynced[id] === note) delete unsynced[id]; // typed more meanwhile? the next flush sends it
      }
      saveUnsynced();
      if (sendOrder) {
        await api("/api/order", { method: "PUT", body: { order: sendOrder } });
        if (!drag && JSON.stringify(domOrder()) === JSON.stringify(sendOrder)) orderDirty = false;
      }
      writeGen++;
      if (!hasPending()) {
        if (rejected) setStatus("一部のメモは保存できませんでした（項目が削除されています）", { warn: true });
        else setStatus("保存しました", { fade: true });
        show(await api("/api/data"));
      }
    } catch (err) {
      if (err.auth) {
        setStatus("パスコードが変わりました。編集でもう一度入力してください", { warn: true });
        if (editing) setEditing(false, { save: false }); // keep the edits; they are sent after re-entry
      } else setStatus("オフライン・つながり次第保存します", { warn: true });
    }
  }

  function flush() {
    clearTimeout(saveTimer);
    writing = writing.then(writeUnsynced);
    return writing;
  }

  async function pull() {
    if (document.hidden || drag) return;
    if (hasPending() && localStorage.getItem(PASS_KEY)) return flush(); // retry failed writes first
    const gen = writeGen;
    try {
      const remote = await api("/api/data");
      if (gen === writeGen && !hasPending() && !drag) show(remote);
      if (statusEl.classList.contains("warn") && !hasPending()) setStatus("");
    } catch {
      setStatus("オフライン・最新の内容を読み込めません", { warn: true });
      if (!data.items.length) {
        emptyEl.querySelector(".msg").textContent = "読み込めませんでした。電波の良い場所でもう一度お試しください。";
        emptyEl.querySelector(".retry").hidden = false;
      }
    }
  }

  // ---------- uploads ----------
  addBtn.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async () => {
    const files = [...fileInput.files];
    fileInput.value = "";
    if (!files.length) return;
    const section = await pickSection(files.length);
    if (!section) return;
    for (const [i, file] of files.entries()) {
      try {
        await uploadOne(file, section, (p) => setStatus(`アップロード中 ${i + 1}/${files.length}… ${Math.round(p * 100)}%`));
      } catch (err) {
        setStatus(err.auth ? "パスコードをもう一度入力してください" : `アップロード失敗: ${err.message}`, { warn: true });
        return;
      }
    }
    setStatus("追加しました", { fade: true });
    show(await api("/api/data"));
    setCollapsed(section, false, false);
    const last = data.items.filter((x) => x.section === section).at(-1);
    if (last) cards[last.id]?.scrollIntoView({ block: "center", behavior: "smooth" });
  });

  // Ask which section the new files go in (or create one)
  function pickSection(count) {
    const select = uploadDialog.querySelector("select");
    const input = uploadDialog.querySelector("input");
    uploadDialog.querySelector(".what").textContent = `${count}件`;
    select.innerHTML = "";
    for (const name of data.sections) select.add(new Option(name, name));
    select.add(new Option("＋ 新しいセクション…", "__new"));
    const last = localStorage.getItem("maedori:lastSection");
    select.value = data.sections.includes(last) ? last : data.sections.at(-1) || "__new";
    input.value = "";
    const sync = () => (input.hidden = select.value !== "__new");
    select.onchange = sync;
    sync();
    uploadDialog.returnValue = "";
    uploadDialog.showModal();
    return new Promise((resolve) => {
      uploadDialog.onclose = async () => {
        if (uploadDialog.returnValue !== "ok") return resolve(null);
        let name = select.value;
        if (name === "__new") {
          name = input.value.trim();
          if (!name) return resolve(null);
          try {
            name = (await api("/api/sections", { method: "POST", body: { name } })).name;
            if (!data.sections.includes(name)) data.sections.push(name);
            render();
          } catch (err) {
            setStatus(err.auth ? "パスコードをもう一度入力してください" : "セクションを作れませんでした", { warn: true });
            return resolve(null);
          }
        }
        localStorage.setItem("maedori:lastSection", name);
        resolve(name);
      };
    });
  }

  async function uploadOne(file, section, onProgress) {
    let body, w, h, poster;
    if (file.type === "image/gif") {
      body = file; // keep animation
    } else if (file.type.startsWith("image/")) {
      ({ blob: body, w, h } = await shrinkImage(file));
    } else if (file.type.startsWith("video/")) {
      body = file;
      ({ poster, w, h } = await videoPoster(file).catch(() => ({})));
    } else throw new Error("写真か動画を選んでください");
    if (body.size > MAX_UPLOAD_BYTES) throw new Error(`ファイルが大きすぎます（${Math.round(body.size / 1048576)}MB・上限95MB）`);
    const qs = new URLSearchParams({ section });
    if (w) qs.set("w", w);
    if (h) qs.set("h", h);
    const { id } = await send("POST", `/api/upload?${qs}`, body, onProgress);
    if (poster) await send("PUT", `/api/poster/${id}`, poster).catch(() => {}); // a missing poster is fine
  }

  // Raw-body upload with progress (XHR, since fetch can't report upload progress)
  function send(method, path, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, `${API}${path}`);
      xhr.setRequestHeader("authorization", `Bearer ${localStorage.getItem(PASS_KEY) || ""}`);
      xhr.setRequestHeader("content-type", blob.type || "application/octet-stream");
      if (onProgress) xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        let res = {};
        try {
          res = JSON.parse(xhr.responseText || "{}");
        } catch {}
        if (xhr.status === 401) {
          localStorage.removeItem(PASS_KEY);
          reject(Object.assign(new Error("passcode"), { auth: true }));
        } else if (xhr.status >= 200 && xhr.status < 300) resolve(res);
        else reject(new Error(res.error || `HTTP ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error("接続できません"));
      xhr.onabort = () => reject(new Error("中断されました"));
      xhr.ontimeout = () => reject(new Error("時間切れです"));
      xhr.timeout = 10 * 60 * 1000;
      xhr.send(blob);
    });
  }

  // Photos from the camera are huge; send a 2048px JPEG instead
  async function shrinkImage(file) {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); // honour the photo's rotation
    const scale = Math.min(1, MAX_IMAGE_PX / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; // transparent PNGs would turn black as JPEG
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close(); // a 48 MP photo holds ~190 MB until released
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.86));
    canvas.width = canvas.height = 0;
    if (!blob) throw new Error("写真を読み込めませんでした");
    return { blob, w, h };
  }

  // Grab a still from the video (shown before it plays, and as the edit-mode thumbnail)
  function videoPoster(file) {
    return new Promise((resolve, reject) => {
      const v = document.createElement("video");
      const url = URL.createObjectURL(file);
      let settled = false;
      const done = (fn, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        v.removeAttribute("src");
        v.load(); // release the decoder
        URL.revokeObjectURL(url);
        fn(val);
      };
      const timer = setTimeout(() => done(reject, new Error("timeout")), 15000);
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      v.onloadeddata = () => (v.currentTime = Math.min(0.5, (v.duration || 1) / 2));
      v.onseeked = () => {
        const scale = Math.min(1, 1280 / Math.max(v.videoWidth, v.videoHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(v.videoWidth * scale);
        canvas.height = Math.round(v.videoHeight * scale);
        canvas.getContext("2d").drawImage(v, 0, 0, canvas.width, canvas.height);
        const w = v.videoWidth, h = v.videoHeight;
        canvas.toBlob((poster) => done(resolve, { poster, w, h }), "image/jpeg", 0.85);
      };
      v.onerror = () => done(reject, new Error("video"));
      v.src = url;
      v.load(); // iOS won't start loading a detached <video> on its own
    });
  }

  async function removeItem(id) {
    if (!confirm("この項目を削除しますか？")) return;
    try {
      await api(`/api/items/${encodeURIComponent(id)}`, { method: "DELETE" });
      show(await api("/api/data"));
    } catch (err) {
      setStatus(err.auth ? "パスコードをもう一度入力してください" : "削除できませんでした", { warn: true });
    }
  }

  emptyEl.querySelector(".retry").addEventListener("click", () => {
    emptyEl.querySelector(".msg").textContent = "読み込み中…";
    emptyEl.querySelector(".retry").hidden = true;
    pull();
  });

  // tapping the dimmed area outside a dialog cancels it
  for (const dlg of [passDialog, uploadDialog]) {
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) {
        dlg.returnValue = "";
        dlg.close();
      }
    });
  }

  // ---------- start ----------
  render();
  pull();
  setInterval(pull, POLL_MS);
  document.addEventListener("visibilitychange", pull);
})();
