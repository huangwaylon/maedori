// 前撮り メモ — photos with notes. View mode (default) is read-only; edit mode lets you
// write notes and drag rows by their ≡ handle to reorder (also across sections).
// Shared by everyone through textdb.online (no account) as { notes, order }, cached in localStorage.
"use strict";

(() => {
  const TEXTDB = "https://textdb.online";
  const SHARED_KEY = "maedori-1pjFiUY4LO1nVLHUuZoMAOY2"; // one textdb value shared by everyone
  const STORAGE_KEY = "maedori:data";
  const POLL_MS = 15000;
  const SAVE_DELAY_MS = 800;
  const EDGE_PX = 90; // auto-scroll when dragging this close to the top/bottom
  const SECTIONS = Object.keys(window.PHOTOS);

  const main = document.getElementById("sections");
  const status = document.getElementById("status");
  const modeBtn = document.getElementById("mode");
  const cards = {}; // photo id ("folder/file") -> card element
  const lists = {}; // section -> list element
  const unsynced = {}; // photo id -> note typed here but not saved yet
  let orderDirty = false; // local order changed but not saved yet
  let data = clean(loadLocal());
  let editing = false;
  let drag = null;
  let writing = Promise.resolve();
  let saveTimer;

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
    const notes = {};
    if (src.notes && typeof src.notes === "object") {
      for (const [id, note] of Object.entries(src.notes)) if (typeof note === "string" && note.trim()) notes[id] = note;
    }
    const known = new Set(SECTIONS.flatMap((s) => window.PHOTOS[s].map((f) => `${s}/${f}`)));
    const seen = new Set();
    const order = {};
    for (const section of SECTIONS) {
      const ids = Array.isArray(src.order?.[section]) ? src.order[section] : [];
      order[section] = ids.filter((id) => known.has(id) && !seen.has(id) && seen.add(id));
    }
    for (const section of SECTIONS) {
      for (const file of window.PHOTOS[section]) {
        const id = `${section}/${file}`;
        if (!seen.has(id)) order[section].push(id); // new photos land at the end of their own folder
      }
    }
    return { notes, order };
  }

  function setStatus(text) {
    status.textContent = text;
  }

  // ---- Render ----
  function makeCard(id) {
    const [folder, file] = id.split("/");
    const src = `${encodeURIComponent(folder)}/${encodeURIComponent(file)}`;
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.id = id;
    card.innerHTML =
      `<div class="handle" aria-label="ドラッグで並べ替え">≡</div>` +
      `<a class="photo" target="_blank" rel="noopener"><img loading="lazy" alt=""><span class="num"></span></a>` +
      `<p class="note"></p>` +
      `<textarea rows="2" placeholder="メモ…"></textarea>`;
    card.querySelector(".photo").href = src;
    const img = card.querySelector("img");
    img.addEventListener("load", () => cropBorders(img), { once: true });
    img.src = src;
    const box = card.querySelector("textarea");
    box.addEventListener("input", () => {
      unsynced[id] = box.value;
      box.classList.add("dirty");
      card.querySelector(".note").textContent = box.value.trim() ? box.value : "";
      grow(box);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(flush, SAVE_DELAY_MS);
    });
    box.addEventListener("blur", flush);
    card.querySelector(".handle").addEventListener("pointerdown", (e) => startDrag(e, card));
    return card;
  }

  // The photos are screenshots of videos with black bars; swap in a copy with the bars cut off
  function cropBorders(img) {
    const W = img.naturalWidth, H = img.naturalHeight;
    const sw = 240, sh = Math.round((sw * H) / W); // scan a small copy
    const scan = document.createElement("canvas");
    scan.width = sw;
    scan.height = sh;
    const sctx = scan.getContext("2d", { willReadFrequently: true });
    sctx.drawImage(img, 0, 0, sw, sh);
    const px = sctx.getImageData(0, 0, sw, sh).data;
    const lit = (x, y) => {
      const i = (y * sw + x) * 4;
      return Math.max(px[i], px[i + 1], px[i + 2]) > 40;
    };
    const rowLit = (y) => { let n = 0; for (let x = 0; x < sw; x++) n += lit(x, y); return n > sw * 0.05; };
    const colLit = (x) => { let n = 0; for (let y = 0; y < sh; y++) n += lit(x, y); return n > sh * 0.05; };
    let top = 0, bottom = sh - 1, left = 0, right = sw - 1;
    while (top < bottom && !rowLit(top)) top++;
    while (bottom > top && !rowLit(bottom)) bottom--;
    while (left < right && !colLit(left)) left++;
    while (right > left && !colLit(right)) right--;
    const k = W / sw;
    const x = Math.floor(left * k), y = Math.floor(top * k);
    const w = Math.ceil((right - left + 1) * k), h = Math.ceil((bottom - top + 1) * k);
    if (w < W * 0.2 || h < H * 0.2 || (w > W * 0.97 && h > H * 0.97)) return; // nothing sensible to crop
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    out.getContext("2d").drawImage(img, x, y, w, h, 0, 0, w, h);
    out.toBlob((blob) => {
      if (!blob) return;
      img.src = URL.createObjectURL(blob);
      img.classList.add("cropped");
    }, "image/jpeg", 0.9);
  }

  for (const section of SECTIONS) {
    const h2 = document.createElement("h2");
    h2.textContent = section;
    const list = document.createElement("div");
    list.className = "list";
    list.dataset.section = section;
    lists[section] = list;
    main.append(h2, list);
  }
  for (const id of SECTIONS.flatMap((s) => data.order[s])) cards[id] = makeCard(id);

  function grow(box) {
    if (!editing) return;
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight + 2}px`;
  }

  function renumber() {
    for (const list of Object.values(lists)) {
      [...list.children].forEach((card, i) => (card.querySelector(".num").textContent = `#${i + 1}`));
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

  // ---- Modes ----
  function setEditing(on) {
    editing = on;
    document.body.classList.toggle("editing", on);
    modeBtn.textContent = on ? "完了" : "編集";
    if (on) for (const card of Object.values(cards)) grow(card.querySelector("textarea"));
    else {
      document.activeElement?.blur();
      flush();
    }
  }
  modeBtn.addEventListener("click", () => setEditing(!editing));

  // ---- Drag to reorder (pointer events, so it works with a finger on iPhone) ----
  function startDrag(e, card) {
    if (!editing || drag) return;
    e.preventDefault();
    document.activeElement?.blur();
    drag = { card, pointerId: e.pointerId, y: e.clientY, before: JSON.stringify(domOrder()), raf: 0 };
    card.classList.add("dragging");
    document.body.classList.add("dragging");
    // listen on window: moving the card in the DOM would drop pointer capture on the handle
    addEventListener("pointermove", onDragMove);
    addEventListener("pointerup", endDrag);
    addEventListener("pointercancel", endDrag);
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function onDragMove(e) {
    if (e.pointerId !== drag.pointerId) return;
    drag.y = e.clientY;
    place();
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
    const others = [...list.children].filter((c) => c !== drag.card);
    const next = others.find((c) => {
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
    const speed =
      drag.y < EDGE_PX ? -(EDGE_PX - drag.y) / 4 :
      drag.y > innerHeight - EDGE_PX ? (drag.y - (innerHeight - EDGE_PX)) / 4 : 0;
    if (speed) {
      scrollBy(0, speed);
      place();
    }
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    removeEventListener("pointermove", onDragMove);
    removeEventListener("pointerup", endDrag);
    removeEventListener("pointercancel", endDrag);
    cancelAnimationFrame(drag.raf);
    drag.card.classList.remove("dragging");
    document.body.classList.remove("dragging");
    const order = domOrder();
    const changed = JSON.stringify(order) !== drag.before;
    drag = null;
    renumber();
    if (changed) {
      data.order = order;
      orderDirty = true;
      saveLocal();
      flush();
    }
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
      for (const [id, note] of Object.entries(batch)) {
        if (unsynced[id] !== note) continue; // typed more meanwhile; next flush sends it
        delete unsynced[id];
        cards[id]?.querySelector("textarea").classList.remove("dirty");
      }
      if (sendOrder && !drag && JSON.stringify(domOrder()) === JSON.stringify(sendOrder)) orderDirty = false;
      show(remote);
      setStatus("");
    } catch {
      setStatus("オフライン：変更はこの端末に残っています。つながり次第保存します");
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
      if (!Object.keys(unsynced).length && !orderDirty) show(remote);
      setStatus("");
    } catch {
      setStatus("オフライン：最新の内容を読み込めません");
    }
  }

  render();
  pull();
  setInterval(pull, POLL_MS);
  document.addEventListener("visibilitychange", pull);
})();
