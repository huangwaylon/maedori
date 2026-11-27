// 前撮り メモ — reference clips (one per scene of the sample video) with notes.
// View mode (default) is read-only. Edit mode: write notes, drag rows by the grip to reorder
// (also between sections), or focus the grip and use ↑/↓.
// Shared by everyone through textdb.online (no account) as { notes, order }, cached in localStorage.
"use strict";

(() => {
  const TEXTDB = "https://textdb.online";
  const SHARED_KEY = "maedori-1pjFiUY4LO1nVLHUuZoMAOY2"; // one textdb value shared by everyone
  const STORAGE_KEY = "maedori:data";
  const POLL_MS = 15000;
  const SAVE_DELAY_MS = 800;
  const EDGE_PX = 100; // auto-scroll when dragging this close to the top/bottom
  const SECTIONS = Object.keys(window.SECTIONS);
  const CLIPS = window.CLIPS; // id -> { start, end, w, h }
  const LEGACY = window.LEGACY || {}; // old screenshot id -> clip id
  const GRIP_SVG =
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

  const main = document.getElementById("sections");
  const statusEl = document.getElementById("status");
  const modeBtn = document.getElementById("mode");
  const cards = {}; // clip id ("s01") -> card element
  const lists = {}; // section -> list element
  const counts = {}; // section -> count element
  const unsynced = {}; // photo id -> note typed here but not saved yet
  let orderDirty = false; // local order changed but not saved yet
  let data = clean(loadLocal());
  let editing = false;
  let drag = null;
  let writing = Promise.resolve();
  let saveTimer, statusTimer;

  // ---- Data ----
  function loadLocal() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch {
      return null;
    }
  }

  function saveLocal() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  // Turn untrusted data into { notes: {id: text}, order: {section: [ids]} } covering every photo once
  function clean(raw) {
    const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const known = new Set(Object.keys(CLIPS));
    const toClip = (id) => (known.has(id) ? id : LEGACY[id]); // screenshots were replaced by clips
    const notes = {};
    const addNote = (id, note) => {
      const clip = toClip(id);
      if (clip && typeof note === "string" && note.trim() && !notes[clip]) notes[clip] = note;
    };
    if (src.notes && typeof src.notes === "object") for (const [id, note] of Object.entries(src.notes)) addNote(id, note);
    // the first version stored notes flat at the top level ({ id: note }); keep reading those
    for (const [id, note] of Object.entries(src)) addNote(id, note);
    const seen = new Set();
    const order = {};
    for (const section of SECTIONS) {
      const ids = Array.isArray(src.order?.[section]) ? src.order[section] : [];
      order[section] = ids.map(toClip).filter((id) => id && !seen.has(id) && seen.add(id));
    }
    for (const section of SECTIONS) {
      for (const id of window.SECTIONS[section]) {
        if (!seen.has(id)) order[section].push(id); // new clips land in their default section
      }
    }
    return { notes, order };
  }

  function setStatus(text, { warn = false, fade = false } = {}) {
    clearTimeout(statusTimer);
    statusEl.textContent = text;
    statusEl.classList.toggle("warn", warn);
    if (fade) statusTimer = setTimeout(() => (statusEl.textContent = ""), 2000);
  }

  // ---- Render ----
  const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;

  function makeCard(id) {
    const clip = CLIPS[id];
    const card = document.createElement("article");
    card.className = "card";
    card.dataset.id = id;
    card.innerHTML =
      `<div class="photo"><video muted loop playsinline preload="none"></video><img class="thumb" alt="" loading="lazy" decoding="async"></div>` +
      `<div class="caption"><span class="num"></span><p class="note"></p>` +
      `<textarea rows="1" placeholder="メモを追加" aria-label="メモ"></textarea>` +
      `<span class="time"></span></div>` +
      `<button class="grip" type="button" aria-label="並べ替え（ドラッグ、または↑↓キー）">${GRIP_SVG}</button>`;
    const video = card.querySelector("video");
    video.poster = `clips/${id}.jpg`;
    video.src = `clips/${id}.mp4`;
    video.style.aspectRatio = `${clip.w} / ${clip.h}`;
    video.setAttribute("aria-label", `${fmt(clip.start)}–${fmt(clip.end)}`);
    video.addEventListener("click", () => (video.paused ? video.play() : video.pause()));
    card.querySelector(".thumb").src = `clips/${id}.jpg`;
    card.querySelector(".time").textContent = `元動画 ${fmt(clip.start)}–${fmt(clip.end)}`;
    watch(video);

    const box = card.querySelector("textarea");
    box.addEventListener("input", () => {
      unsynced[id] = box.value;
      card.querySelector(".note").textContent = box.value.trim() ? box.value : "";
      grow(box);
      setStatus("保存中…");
      clearTimeout(saveTimer);
      saveTimer = setTimeout(flush, SAVE_DELAY_MS);
    });
    box.addEventListener("blur", flush);

    const grip = card.querySelector(".grip");
    // touch: the most reliable way to drag on iPhone Safari (preventDefault stops the page scrolling)
    grip.addEventListener("touchstart", (e) => startDrag(card, e.changedTouches[0].clientY, e, e.changedTouches[0].identifier), { passive: false });
    // mouse / pen
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

  // Play clips only while they are on screen (and only in view mode)
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
  function watch(video) {
    observer.observe(video);
  }
  function syncPlayback() {
    for (const v of visible) {
      if (editing || drag) v.pause();
      else if (v.paused) v.play().catch(() => {}); // autoplay can be refused (e.g. Low Power Mode); tap plays
    }
  }

  for (const section of SECTIONS) {
    const head = document.createElement("div");
    head.className = "section-head";
    head.innerHTML = `<h2></h2><span class="count"></span>`;
    head.querySelector("h2").textContent = section;
    counts[section] = head.querySelector(".count");
    const list = document.createElement("div");
    list.className = "list";
    list.dataset.section = section;
    lists[section] = list;
    main.append(head, list);
  }
  for (const id of SECTIONS.flatMap((s) => data.order[s])) cards[id] = makeCard(id);

  function grow(box) {
    if (!editing) return;
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight}px`;
  }

  function renumber() {
    for (const section of SECTIONS) {
      const children = [...lists[section].children];
      children.forEach((card, i) => (card.querySelector(".num").textContent = String(i + 1).padStart(2, "0")));
      counts[section].textContent = `${children.length}枚`;
    }
  }

  // Lay cards out by data.order and fill in notes, never clobbering what is being typed or dragged here
  function render() {
    if (!drag && !orderDirty) {
      for (const section of SECTIONS) {
        const list = lists[section];
        data.order[section].forEach((id, i) => {
          if (list.children[i] !== cards[id]) list.insertBefore(cards[id], list.children[i] || null);
        });
      }
    }
    for (const [id, card] of Object.entries(cards)) {
      const box = card.querySelector("textarea");
      if (id in unsynced || document.activeElement === box) continue;
      const note = data.notes[id] || "";
      card.querySelector(".note").textContent = note;
      if (box.value !== note) {
        box.value = note;
        grow(box);
      }
    }
    renumber();
  }

  function domOrder() {
    const order = {};
    for (const section of SECTIONS) order[section] = [...lists[section].children].map((c) => c.dataset.id);
    return order;
  }

  function commitOrder() {
    renumber();
    data.order = domOrder();
    orderDirty = true;
    saveLocal();
    setStatus("保存中…");
    flush();
  }

  // ---- Modes ----
  function setEditing(on) {
    editing = on;
    document.body.classList.toggle("editing", on);
    modeBtn.textContent = on ? "完了" : "編集";
    modeBtn.setAttribute("aria-pressed", String(on));
    syncPlayback();
    if (on) {
      for (const card of Object.values(cards)) grow(card.querySelector("textarea"));
    } else {
      document.activeElement?.blur();
      flush();
    }
  }
  modeBtn.addEventListener("click", () => setEditing(!editing));

  // ---- Reorder ----
  // Keyboard: move one step, crossing into the neighbouring section at the ends
  function moveBy(card, step) {
    const list = card.parentElement;
    const i = SECTIONS.indexOf(list.dataset.section);
    if (step < 0) {
      const prev = card.previousElementSibling;
      if (prev) list.insertBefore(card, prev);
      else if (i > 0) lists[SECTIONS[i - 1]].append(card);
      else return;
    } else {
      const next = card.nextElementSibling;
      if (next) list.insertBefore(card, next.nextElementSibling);
      else if (i < SECTIONS.length - 1) lists[SECTIONS[i + 1]].prepend(card);
      else return;
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
    const all = Object.values(lists);
    // the section under the finger, else the nearest one
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

  // ---- Sync ----
  async function fetchRemote() {
    const res = await fetch(`${TEXTDB}/${SHARED_KEY}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`GET ${res.status}`);
    const text = await res.text();
    const raw = text ? JSON.parse(text) : {}; // an unused key reads as empty
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("unexpected shared data");
    return clean(raw); // malformed data throws, so it is never overwritten
  }

  function show(remote) {
    data = remote;
    if (orderDirty) data.order = domOrder(); // keep the local order until it's saved
    saveLocal();
    render();
  }

  async function writeUnsynced() {
    const batch = { ...unsynced };
    const sendOrder = orderDirty ? domOrder() : null;
    if (!Object.keys(batch).length && !sendOrder) return;
    try {
      const remote = await fetchRemote(); // re-read so other people's changes are kept
      for (const [id, note] of Object.entries(batch)) {
        if (note.trim()) remote.notes[id] = note;
        else delete remote.notes[id];
      }
      if (sendOrder) remote.order = sendOrder;
      const res = await fetch(`${TEXTDB}/update`, {
        method: "POST",
        body: new URLSearchParams({ key: SHARED_KEY, value: JSON.stringify(remote) }),
      });
      if (!res.ok || (await res.json()).status !== 1) throw new Error("write failed");
      for (const [id, note] of Object.entries(batch)) if (unsynced[id] === note) delete unsynced[id];
      if (sendOrder && !drag && JSON.stringify(domOrder()) === JSON.stringify(sendOrder)) orderDirty = false;
      show(remote);
      if (!Object.keys(unsynced).length && !orderDirty) setStatus("保存しました", { fade: true });
    } catch {
      setStatus("オフライン・つながり次第保存します", { warn: true });
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
      const remote = await fetchRemote();
      if (!Object.keys(unsynced).length && !orderDirty && !drag) show(remote);
      if (statusEl.classList.contains("warn")) setStatus("");
    } catch {
      setStatus("オフライン・最新の内容を読み込めません", { warn: true });
    }
  }

  render();
  pull();
  setInterval(pull, POLL_MS);
  document.addEventListener("visibilitychange", pull);
})();
