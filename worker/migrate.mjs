// HISTORICAL — ran once on 2026-11-27; the /api/import endpoint it used has since been removed.
// One-time migration: existing clips/photos (files stay in the repo) + notes/order saved on textdb.online -> maedori-api (D1).
// usage: API=https://… PASSCODE=… SAVED=saved.json node migrate.mjs
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const API = process.env.API;
const PASSCODE = process.env.PASSCODE;
if (!API || !PASSCODE) throw new Error("set API and PASSCODE");
const ROOT = new URL("../", import.meta.url);

// clips.js defines window.CLIPS / SECTIONS / LEGACY
const ctx = { window: {} };
vm.runInNewContext(await readFile(new URL("clips.js", import.meta.url), "utf8"), ctx);
const { CLIPS, SECTIONS, LEGACY } = ctx.window;

// what people saved so far (old format: notes/order may use screenshot ids)
// SAVED = path to a JSON snapshot of textdb (curl https://textdb.online/maedori-1pjFiUY4LO1nVLHUuZoMAOY2 > saved.json)
const saved = process.env.SAVED ? JSON.parse(await readFile(process.env.SAVED, "utf8") || "{}") : {};
const toClip = (id) => (CLIPS[id] ? id : LEGACY[id]);
const notes = {};
for (const src of [saved.notes || {}, saved]) {
  for (const [id, note] of Object.entries(src)) {
    const clip = toClip(id);
    if (clip && typeof note === "string" && note.trim() && !notes[clip]) notes[clip] = note;
  }
}
// notes given directly (not yet typed on the site)
Object.assign(notes, { w03: "https://www.instagram.com/p/DXwuCNmRMwg/" });
const seen = new Set();
const order = {};
for (const section of Object.keys(SECTIONS)) {
  const ids = Array.isArray(saved.order?.[section]) ? saved.order[section] : [];
  order[section] = ids.map(toClip).filter((id) => id && !seen.has(id) && seen.add(id));
}
for (const [section, ids] of Object.entries(SECTIONS)) for (const id of ids) if (!seen.has(id)) order[section].push(id);

// sections first (in page order)
for (const name of Object.keys(SECTIONS)) await call("/api/sections", { method: "POST", json: { name } });

let pos = 0;
const jobs = [];
for (const [section, ids] of Object.entries(order)) {
  for (const id of ids) {
    const c = CLIPS[id];
    const kind = c.image ? "image" : "video";
    const meta = {
      id, kind, section, pos: pos++, note: notes[id] || "", w: c.w, h: c.h, start: c.start ?? null, end: c.end ?? null,
      media: kind === "video" ? `clips/${id}.mp4` : `clips/${id}.jpg`,
      poster: `clips/${id}.jpg`,
    };
    jobs.push(async () => {
      await call("/api/import", { method: "PUT", json: meta });
      process.stdout.write(".");
    });
  }
}
// a few at a time
const queue = [...jobs];
await Promise.all(Array.from({ length: 6 }, async () => { while (queue.length) await queue.shift()(); }));
console.log(`\nimported ${jobs.length} items; notes: ${Object.keys(notes).length}`);

async function call(path, { method, json, form }) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${PASSCODE}`, ...(json ? { "content-type": "application/json" } : {}) },
    body: json ? JSON.stringify(json) : form,
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}
