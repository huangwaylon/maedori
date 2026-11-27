// 前撮り メモ — one notes box per photo.
// Notes are shared by everyone through textdb.online (no account) and cached in localStorage.
"use strict";

(() => {
  const TEXTDB = "https://textdb.online";
  const SHARED_KEY = "maedori-1pjFiUY4LO1nVLHUuZoMAOY2"; // one textdb value shared by everyone
  const STORAGE_KEY = "maedori:notes";
  const POLL_MS = 15000;
  const SAVE_DELAY_MS = 800;

  const sections = document.getElementById("sections");
  const status = document.getElementById("status");
  const boxes = {}; // photo id ("folder/file") -> textarea
  const unsynced = {}; // photo id -> note typed here but not saved yet
  let notes = loadLocal(); // photo id -> note
  let writing = Promise.resolve();
  let saveTimer;

  function loadLocal() {
    try {
      return onlyNotes(JSON.parse(localStorage.getItem(STORAGE_KEY)));
    } catch {
      return {};
    }
  }

  // Keep only string notes from untrusted data
  function onlyNotes(data) {
    const out = {};
    if (data && typeof data === "object" && !Array.isArray(data)) {
      for (const [id, note] of Object.entries(data)) if (typeof note === "string" && note) out[id] = note;
    }
    return out;
  }

  function setStatus(text) {
    status.textContent = text;
  }

  // ---- Render ----
  for (const [folder, files] of Object.entries(window.PHOTOS)) {
    const h2 = document.createElement("h2");
    h2.textContent = folder;
    const grid = document.createElement("div");
    grid.className = "grid";
    files.forEach((file, i) => {
      const id = `${folder}/${file}`;
      const src = `${encodeURIComponent(folder)}/${encodeURIComponent(file)}`;
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `<a target="_blank" rel="noopener"><img loading="lazy" alt=""></a><div class="num"></div><textarea placeholder="メモを書く…"></textarea>`;
      card.querySelector("a").href = src;
      card.querySelector("img").src = src;
      card.querySelector("img").alt = `${folder} ${i + 1}`;
      card.querySelector(".num").textContent = `${folder} #${i + 1}`;
      const box = card.querySelector("textarea");
      box.value = notes[id] || "";
      box.addEventListener("input", () => {
        unsynced[id] = box.value;
        box.classList.add("dirty");
        clearTimeout(saveTimer);
        saveTimer = setTimeout(flush, SAVE_DELAY_MS);
      });
      box.addEventListener("blur", flush);
      boxes[id] = box;
      grid.append(card);
    });
    sections.append(h2, grid);
  }

  // Show shared notes, but never clobber what someone is typing here
  function show(data) {
    notes = onlyNotes(data);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
    for (const [id, box] of Object.entries(boxes)) {
      if (id in unsynced || document.activeElement === box) continue;
      const value = notes[id] || "";
      if (box.value !== value) box.value = value;
    }
  }

  // ---- Sync ----
  async function fetchRemote() {
    const res = await fetch(`${TEXTDB}/${SHARED_KEY}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`GET ${res.status}`);
    const text = await res.text();
    const data = text ? JSON.parse(text) : {}; // an unused key reads as empty
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("unexpected shared data");
    return data; // malformed data throws, so it is never overwritten
  }

  async function writeUnsynced() {
    const batch = { ...unsynced };
    if (!Object.keys(batch).length) return;
    try {
      const data = onlyNotes(await fetchRemote()); // re-read so other people's notes are kept
      for (const [id, note] of Object.entries(batch)) {
        if (note.trim()) data[id] = note;
        else delete data[id];
      }
      const res = await fetch(`${TEXTDB}/update`, {
        method: "POST",
        body: new URLSearchParams({ key: SHARED_KEY, value: JSON.stringify(data) }),
      });
      if (!res.ok || (await res.json()).status !== 1) throw new Error("write failed");
      for (const [id, note] of Object.entries(batch)) {
        if (unsynced[id] !== note) continue; // typed more meanwhile; next flush sends it
        delete unsynced[id];
        boxes[id]?.classList.remove("dirty");
      }
      show(data);
      setStatus("");
    } catch {
      setStatus("オフライン：メモはこの端末に残っています。つながり次第保存します");
    }
  }

  function flush() {
    clearTimeout(saveTimer);
    writing = writing.then(writeUnsynced);
    return writing;
  }

  async function pull() {
    if (document.hidden) return;
    if (Object.keys(unsynced).length) return flush(); // retry failed writes first
    try {
      const data = await fetchRemote();
      if (!Object.keys(unsynced).length) show(data);
      setStatus("");
    } catch {
      setStatus("オフライン：最新のメモを読み込めません");
    }
  }

  pull();
  setInterval(pull, POLL_MS);
  document.addEventListener("visibilitychange", pull);
})();
