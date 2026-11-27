// 前撮り メモ — reference clips and photos with notes, stored in our own Cloudflare Worker (D1 + R2).
// View mode (default) is read-only and needs nothing. Edit mode asks once for the passcode, then lets you
// write notes, drag rows by the grip (or ↑/↓ on a focused grip) to reorder, and upload photos/videos.
"use strict";

(() => {
  const API = window.MAEDORI_API; // set in index.html
  const ASSET_V = "10"; // keep in step with ?v= in index.html so phones fetch updated repo files
  const CACHE_KEY = "maedori:cache";
  const PASS_KEY = "maedori:passcode";
  const COLLAPSED_KEY = "maedori:collapsed";
  const POLL_MS = 15000;
  const SAVE_DELAY_MS = 800;
  const EDGE_PX = 100;
  const MAX_IMAGE_PX = 2048;
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

  const cards = {}; // item id -> card element
  const lists = {}; // section -> list element
  const sectionEls = {}; // section -> <section>
  const unsynced = {}; // item id -> note typed here but not saved yet
  let data = loadCache(); // { sections: [names], items: [{ id, kind, section, note, w, h, start, end, media, poster }] }
  let orderDirty = false;
  let editing = false;
  let drag = null;
  let writing = Promise.resolve();
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

  async function api(path, { method = "GET", body } = {}) {
    const headers = {};
    const pass = localStorage.getItem(PASS_KEY);
    if (method !== "GET" && pass) headers.authorization = `Bearer ${pass}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${API}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, cache: "no-store" });
    if (res.status === 401) {
      localStorage.removeItem(PASS_KEY);
      throw Object.assign(new Error("passcode"), { auth: true });
    }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
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
    const ratio = item.w && item.h ? `${item.w} / ${item.h}` : "";
    card.querySelector(".thumb").src = mediaUrl(item.poster || item.media);
    if (item.kind === "video") {
      const video = card.querySelector("video");
      if (item.poster) video.poster = mediaUrl(item.poster);
      video.src = mediaUrl(item.media);
      if (ratio) video.style.aspectRatio = ratio;
      video.addEventListener("click", () => (video.paused ? video.play() : video.pause()));
      observer.observe(video);
    } else {
      const img = card.querySelector(".still");
      img.src = mediaUrl(item.media);
      if (ratio) img.style.aspectRatio = ratio;
    }
    if (item.start != null) card.querySelector(".time").textContent = `元動画 ${fmt(item.start)}–${fmt(item.end)}`;

    const box = card.querySelector("textarea");
    box.addEventListener("input", () => {
      unsynced[item.id] = box.value;
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
      if (!ids.has(id)) {
        card.remove();
        delete cards[id];
      }
    }
    for (const item of data.items) if (!cards[item.id]) cards[item.id] = makeCard(item);
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
  function syncPlayback() {
    for (const v of visible) {
      if (editing || drag) v.pause();
      else if (v.paused) v.play().catch(() => {}); // autoplay can be refused (Low Power Mode); tap plays
    }
  }

  // ---------- modes ----------
  function askPasscode() {
    const input = passDialog.querySelector("input");
    const error = passDialog.querySelector(".error");
    input.value = "";
    error.textContent = "";
    passDialog.showModal();
    return new Promise((resolve) => {
      passDialog.onclose = async () => {
        if (passDialog.returnValue !== "ok" || !input.value.trim()) return resolve(false);
        localStorage.setItem(PASS_KEY, input.value.trim());
        try {
          await api("/api/check", { method: "POST" });
          resolve(true);
        } catch (err) {
          error.textContent = err.auth ? "パスコードが違います" : "接続できません";
          passDialog.showModal(); // try again; onclose fires again
        }
      };
    });
  }

  async function setEditing(on) {
    if (on && !localStorage.getItem(PASS_KEY) && !(await askPasscode())) return;
    editing = on;
    document.body.classList.toggle("editing", on);
    modeBtn.textContent = on ? "完了" : "編集";
    modeBtn.setAttribute("aria-pressed", String(on));
    syncPlayback();
    if (on) for (const card of Object.values(cards)) grow(card.querySelector("textarea"));
    else {
      document.activeElement?.blur();
      flush();
    }
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

  async function writeUnsynced() {
    const batch = { ...unsynced };
    const sendOrder = orderDirty && !drag ? domOrder() : null;
    if (!Object.keys(batch).length && !sendOrder) return;
    try {
      for (const [id, note] of Object.entries(batch)) {
        await api(`/api/notes/${encodeURIComponent(id)}`, { method: "PUT", body: { note } });
        if (unsynced[id] === note) delete unsynced[id]; // typed more meanwhile? the next flush sends it
      }
      if (sendOrder) {
        await api("/api/order", { method: "PUT", body: { order: sendOrder } });
        if (!drag && JSON.stringify(domOrder()) === JSON.stringify(sendOrder)) orderDirty = false;
      }
      if (!Object.keys(unsynced).length && !orderDirty) {
        setStatus("保存しました", { fade: true });
        show(await api("/api/data"));
      }
    } catch (err) {
      if (err.auth) {
        setStatus("パスコードをもう一度入力してください", { warn: true });
        setEditing(false);
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
    if (Object.keys(unsynced).length || orderDirty) return flush(); // retry failed writes first
    try {
      const remote = await api("/api/data");
      if (!Object.keys(unsynced).length && !orderDirty && !drag) show(remote);
      if (statusEl.classList.contains("warn")) setStatus("");
    } catch {
      setStatus("オフライン・最新の内容を読み込めません", { warn: true });
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
    if (file.type.startsWith("image/")) {
      ({ blob: body, w, h } = await shrinkImage(file));
    } else if (file.type.startsWith("video/")) {
      body = file;
      ({ poster, w, h } = await videoPoster(file).catch(() => ({})));
    } else throw new Error("写真か動画を選んでください");
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
      xhr.send(blob);
    });
  }

  // Photos from the camera are huge; send a 2048px JPEG instead
  async function shrinkImage(file) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_IMAGE_PX / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.86));
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
        URL.revokeObjectURL(url);
        fn(val);
      };
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      v.src = url;
      v.onloadeddata = () => (v.currentTime = Math.min(0.5, (v.duration || 1) / 2));
      v.onseeked = () => {
        const scale = Math.min(1, 1280 / Math.max(v.videoWidth, v.videoHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(v.videoWidth * scale);
        canvas.height = Math.round(v.videoHeight * scale);
        canvas.getContext("2d").drawImage(v, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((poster) => done(resolve, { poster, w: v.videoWidth, h: v.videoHeight }), "image/jpeg", 0.85);
      };
      v.onerror = () => done(reject, new Error("video"));
      setTimeout(() => done(reject, new Error("timeout")), 15000);
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

  // ---------- start ----------
  render();
  pull();
  setInterval(pull, POLL_MS);
  document.addEventListener("visibilitychange", pull);
})();
