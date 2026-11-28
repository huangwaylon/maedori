// maedori-api — shared storage for the 前撮り メモ site (GitHub Pages frontend).
// D1 holds sections, items (clips/photos), their order and notes.
// Media: the original clips/photos live in the GitHub repo (served by Pages, key "clips/…");
// photos/videos uploaded from phones live in KV (key "uploads/…"), split into 5 MB chunks.
// Reads are public. Every write needs the passcode (Bearer token), set as the PASSCODE secret.

const MAX_UPLOAD = 95 * 1024 * 1024; // Workers accept request bodies up to 100 MB
const CHUNK = 5 * 1024 * 1024; // KV values max out at 25 MiB; small chunks keep each video seek cheap
const KV_CACHE = { cacheTtl: 86400 }; // upload chunks never change, so let the edge cache KV reads
const MEDIA_TYPES = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|quicktime|webm))$/;
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      const res = await route(request, env, url);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      return json({ error: err.expose ? err.message : "server error" }, status, cors);
    }
  },
};

async function route(request, env, url) {
  const { pathname } = url;
  const tail = (prefix) => {
    try {
      return decodeURIComponent(pathname.slice(prefix.length));
    } catch {
      throw fail(400, "bad path");
    }
  };
  const method = request.method;

  if (method === "GET" && pathname === "/api/data") return json(await readAll(env));
  if ((method === "GET" || method === "HEAD") && pathname.startsWith("/media/")) return media(request, env, tail("/media/"));

  // ---- writes ----
  if (!(await authorized(request, env))) throw fail(401, "passcode required");
  if (method === "POST" && pathname === "/api/check") return json({ ok: true });
  if (method === "PUT" && pathname.startsWith("/api/notes/")) return setNote(request, env, tail("/api/notes/"));
  if (method === "PUT" && pathname === "/api/order") return setOrder(request, env);
  if (method === "PUT" && pathname.startsWith("/api/done/")) return setDone(request, env, tail("/api/done/"));
  if (method === "POST" && pathname === "/api/tags") return addTag(request, env);
  if (method === "PUT" && pathname.startsWith("/api/tags/")) return renameTag(request, env, tail("/api/tags/"));
  if (method === "DELETE" && pathname.startsWith("/api/tags/")) return removeTag(env, tail("/api/tags/"));
  if (method === "PUT" && /^\/api\/items\/[^/]+\/tags$/.test(pathname)) return setItemTags(request, env, tail("/api/items/").slice(0, -"/tags".length));
  if (method === "POST" && pathname === "/api/sections") return addSection(request, env);
  if (method === "POST" && pathname === "/api/upload") return upload(request, env, url);
  if (method === "PUT" && pathname.startsWith("/api/poster/")) return setPoster(request, env, tail("/api/poster/"));
  if (method === "DELETE" && pathname.startsWith("/api/items/")) return removeItem(env, tail("/api/items/"));
  throw fail(404, "not found");
}

// ---------- reads ----------
async function readAll(env) {
  const [sections, items, tags, links] = await env.DB.batch([
    env.DB.prepare("SELECT name FROM sections ORDER BY pos"),
    env.DB.prepare("SELECT id, kind, section, pos, note, done, w, h, src_start, src_end, media, poster FROM items ORDER BY pos"),
    env.DB.prepare("SELECT id, name FROM tags ORDER BY pos, id"),
    env.DB.prepare("SELECT it.item_id, it.tag_id FROM item_tags it JOIN tags t ON t.id = it.tag_id ORDER BY t.pos, t.id"),
  ]);
  const tagsOf = {};
  for (const r of links.results) (tagsOf[r.item_id] ||= []).push(r.tag_id);
  return {
    sections: sections.results.map((r) => r.name),
    tags: tags.results.map((r) => ({ id: r.id, name: r.name })),
    items: items.results.map((r) => ({
      id: r.id,
      kind: r.kind,
      section: r.section,
      note: r.note || "",
      done: !!r.done,
      tags: tagsOf[r.id] || [],
      w: r.w,
      h: r.h,
      start: r.src_start,
      end: r.src_end,
      media: r.media,
      poster: r.poster,
    })),
  };
}

async function media(request, env, key) {
  if (!key.startsWith("uploads/")) throw fail(404, "not found");
  const meta = await env.MEDIA.get(`m:${key}`, { type: "json", ...KV_CACHE });
  if (!meta) throw fail(404, "not found");
  const size = meta.chunk || CHUNK; // chunk size this file was stored with
  const headers = new Headers({
    "content-type": meta.type,
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=31536000, immutable", // keys never change content
    etag: `"${key}"`,
  });
  let start = 0, end = meta.size - 1, status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") || "");
  if (m && (m[1] || m[2])) {
    if (m[1]) {
      start = Number(m[1]);
      if (m[2]) end = Math.min(Number(m[2]), meta.size - 1);
    } else start = Math.max(0, meta.size - Number(m[2])); // suffix range: last N bytes
    if (start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${meta.size}` } });
    status = 206; // Safari needs ranges to play video
    headers.set("content-range", `bytes ${start}-${end}/${meta.size}`);
  }
  headers.set("content-length", String(end - start + 1));
  if (request.method === "HEAD") return new Response(null, { status, headers });
  // stream the chunks that cover [start, end]; FixedLengthStream keeps Content-Length on the response
  const first = Math.floor(start / size), last = Math.floor(end / size);
  const { readable, writable } = new FixedLengthStream(end - start + 1);
  (async () => {
    const writer = writable.getWriter();
    try {
      for (let i = first; i <= last; i++) {
        const chunk = await env.MEDIA.get(`c:${key}:${i}`, { type: "arrayBuffer", ...KV_CACHE });
        if (!chunk) throw new Error(`missing chunk ${i} of ${key}`); // never send a silently short file
        const buf = new Uint8Array(chunk);
        const from = i === first ? start - i * size : 0;
        const to = i === last ? end - i * size + 1 : buf.length;
        await writer.write(buf.subarray(from, to));
      }
      await writer.close();
    } catch (err) {
      // the viewer may simply have gone away (Safari drops connections when seeking)
      await writer.abort(err).catch(() => {});
    }
  })();
  return new Response(readable, { status, headers });
}

// Stream a request body into KV in CHUNK-sized pieces; returns the total size.
// On any failure the chunks written so far are removed, so nothing is left behind.
async function putChunked(env, key, stream, type) {
  if (!stream) throw fail(400, "empty file");
  const reader = stream.getReader();
  let parts = [], have = 0, n = 0, size = 0;
  const flushChunk = async (bytes) => {
    const out = new Uint8Array(bytes);
    let off = 0;
    while (off < bytes) {
      const p = parts[0];
      const take = Math.min(p.length, bytes - off);
      out.set(p.subarray(0, take), off);
      off += take;
      if (take === p.length) parts.shift();
      else parts[0] = p.subarray(take);
    }
    have -= bytes;
    await env.MEDIA.put(`c:${key}:${n}`, out);
    n++;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_UPLOAD) throw fail(413, "file too large (max 95 MB)");
      parts.push(value);
      have += value.length;
      while (have >= CHUNK) await flushChunk(CHUNK);
    }
    if (have) await flushChunk(have);
    if (!size) throw fail(400, "empty file");
    await env.MEDIA.put(`m:${key}`, JSON.stringify({ type, size, chunks: n, chunk: CHUNK }));
    return size;
  } catch (err) {
    reader.cancel().catch(() => {});
    for (let i = 0; i < n; i++) await env.MEDIA.delete(`c:${key}:${i}`).catch(() => {});
    throw err;
  }
}

async function deleteChunked(env, key) {
  const meta = await env.MEDIA.get(`m:${key}`, "json");
  if (!meta) return;
  for (let i = 0; i < meta.chunks; i++) await env.MEDIA.delete(`c:${key}:${i}`);
  await env.MEDIA.delete(`m:${key}`);
}

// ---------- writes ----------
async function setNote(request, env, id) {
  const { note } = await body(request);
  if (typeof note !== "string" || note.length > 5000) throw fail(400, "bad note");
  const res = await env.DB.prepare("UPDATE items SET note = ?, updated_at = ? WHERE id = ?").bind(note.trim() ? note : "", Date.now(), id).run();
  if (!res.meta.changes) throw fail(404, "no such item");
  return json({ ok: true });
}

// { done: true|false } — 撮影済み. A plain set (not a toggle), so two phones marking the same shot agree.
async function setDone(request, env, id) {
  const { done } = await body(request);
  if (typeof done !== "boolean") throw fail(400, "bad done");
  const res = await env.DB.prepare("UPDATE items SET done = ?, updated_at = ? WHERE id = ?").bind(done ? 1 : 0, Date.now(), id).run();
  if (!res.meta.changes) throw fail(404, "no such item");
  return json({ ok: true });
}

// ---- tags (e.g. 顔アップ, 足元): a shared list, attached to items ----
const tagName = (name) => (typeof name === "string" ? name.trim().slice(0, 30) : "");
const tagId = (raw) => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw fail(400, "bad tag");
  return id;
};

async function addTag(request, env) {
  const name = tagName((await body(request)).name);
  if (!name) throw fail(400, "bad name");
  await env.DB.prepare("INSERT OR IGNORE INTO tags (name, pos) VALUES (?1, (SELECT COALESCE(MAX(pos), -1) + 1 FROM tags))").bind(name).run();
  const row = await env.DB.prepare("SELECT id FROM tags WHERE name = ?").bind(name).first();
  return json({ ok: true, id: row.id, name });
}

async function renameTag(request, env, raw) {
  const id = tagId(raw);
  const name = tagName((await body(request)).name);
  if (!name) throw fail(400, "bad name");
  const clash = await env.DB.prepare("SELECT id FROM tags WHERE name = ? AND id != ?").bind(name, id).first();
  if (clash) throw fail(409, "name taken");
  const res = await env.DB.prepare("UPDATE tags SET name = ? WHERE id = ?").bind(name, id).run();
  if (!res.meta.changes) throw fail(404, "no such tag");
  return json({ ok: true });
}

async function removeTag(env, raw) {
  const id = tagId(raw);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM item_tags WHERE tag_id = ?").bind(id),
    env.DB.prepare("DELETE FROM tags WHERE id = ?").bind(id),
  ]);
  return json({ ok: true });
}

// { tags: [tag ids] } — replaces the item's tags (a plain set, so retries and two phones agree)
async function setItemTags(request, env, id) {
  const { tags } = await body(request);
  if (!Array.isArray(tags) || tags.length > 50 || !tags.every((t) => Number.isInteger(t) && t > 0)) throw fail(400, "bad tags");
  const item = await env.DB.prepare("SELECT id FROM items WHERE id = ?").bind(id).first();
  if (!item) throw fail(404, "no such item");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM item_tags WHERE item_id = ?").bind(id),
    // unknown (e.g. just-deleted) tag ids are skipped
    env.DB.prepare("INSERT OR IGNORE INTO item_tags (item_id, tag_id) SELECT ?1, t.id FROM tags t JOIN json_each(?2) j ON t.id = j.value").bind(id, JSON.stringify(tags)),
  ]);
  return json({ ok: true });
}

// { order: { section: [ids...] } } — every listed id gets that section and position.
// One statement (json_each), since the free plan allows only ~50 D1 queries per request.
async function setOrder(request, env) {
  const { order } = await body(request);
  if (!order || typeof order !== "object" || Array.isArray(order)) throw fail(400, "bad order");
  const known = new Set((await env.DB.prepare("SELECT name FROM sections").all()).results.map((r) => r.name));
  const rows = [];
  for (const [section, ids] of Object.entries(order)) {
    if (!known.has(section) || !Array.isArray(ids)) throw fail(400, "bad section");
    for (const id of ids) {
      if (typeof id !== "string" || id.length > 64) throw fail(400, "bad id");
      rows.push({ id, s: section, p: rows.length });
    }
  }
  if (rows.length > 5000) throw fail(400, "too many items");
  if (rows.length) {
    await env.DB.prepare(
      `UPDATE items SET section = json_extract(j.value, '$.s'), pos = json_extract(j.value, '$.p'), updated_at = ?2
       FROM json_each(?1) AS j WHERE items.id = json_extract(j.value, '$.id')`
    ).bind(JSON.stringify(rows), Date.now()).run();
  }
  return json({ ok: true });
}

async function addSection(request, env) {
  const { name } = await body(request);
  const clean = typeof name === "string" ? name.trim().slice(0, 40) : "";
  if (!clean) throw fail(400, "bad name");
  const { max } = await env.DB.prepare("SELECT COALESCE(MAX(pos), -1) AS max FROM sections").first();
  await env.DB.prepare("INSERT OR IGNORE INTO sections (name, pos) VALUES (?, ?)").bind(clean, max + 1).run();
  return json({ ok: true, name: clean });
}

// raw body = the photo/video; ?section=…&w=…&h=…; Content-Type = the file's type.
// Streamed straight into KV, so a big video never sits whole in Worker memory.
async function upload(request, env, url) {
  const type = (request.headers.get("content-type") || "").split(";")[0].trim();
  if (!MEDIA_TYPES.test(type)) throw fail(400, "photo or video only");
  if (Number(request.headers.get("content-length") || 0) > MAX_UPLOAD) throw fail(413, "file too large (max 95 MB)");
  const section = url.searchParams.get("section") || "";
  const sec = await env.DB.prepare("SELECT name FROM sections WHERE name = ?").bind(section).first();
  if (!sec) throw fail(400, "unknown section");
  const kind = type.startsWith("video/") ? "video" : "image";
  const id = `u${Date.now().toString(36)}${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
  const mediaKey = `uploads/${id}.${EXT[type]}`;
  await putChunked(env, mediaKey, request.body, type);
  const w = clampInt(url.searchParams.get("w")), h = clampInt(url.searchParams.get("h"));
  try {
    await env.DB.prepare(
      `INSERT INTO items (id, kind, section, pos, note, w, h, media, poster, created_at, updated_at)
       VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(pos), -1) + 1 FROM items), '', ?4, ?5, ?6, ?7, ?8, ?8)`
    ).bind(id, kind, section, w, h, mediaKey, kind === "image" ? mediaKey : null, Date.now()).run();
  } catch (err) {
    await deleteChunked(env, mediaKey); // don't keep a file no item points at
    throw err;
  }
  return json({ ok: true, id });
}

// raw JPEG body: the still shown before a video plays (and as its edit-mode thumbnail)
async function setPoster(request, env, id) {
  if ((request.headers.get("content-type") || "").split(";")[0].trim() !== "image/jpeg") throw fail(400, "jpeg only");
  const row = await env.DB.prepare("SELECT kind, poster FROM items WHERE id = ?").bind(id).first();
  if (!row || row.kind !== "video" || !id.startsWith("u")) throw fail(404, "no such video");
  const key = `uploads/${id}.poster-${Date.now().toString(36)}.jpg`; // new key each time: media is cached as immutable
  await putChunked(env, key, request.body, "image/jpeg");
  await env.DB.prepare("UPDATE items SET poster = ?, updated_at = ? WHERE id = ?").bind(key, Date.now(), id).run();
  if (row.poster) await deleteChunked(env, row.poster);
  return json({ ok: true });
}

async function removeItem(env, id) {
  const row = await env.DB.prepare("SELECT media, poster FROM items WHERE id = ?").bind(id).first();
  if (!row) throw fail(404, "no such item");
  await env.DB.prepare("DELETE FROM items WHERE id = ?").bind(id).run();
  if (id.startsWith("u")) for (const key of new Set([row.media, row.poster].filter(Boolean))) await deleteChunked(env, key); // only uploads
  return json({ ok: true });
}

// ---------- helpers ----------
async function authorized(request, env) {
  const got = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!env.PASSCODE || !got) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(got)), crypto.subtle.digest("SHA-256", enc.encode(env.PASSCODE))]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim());
  return {
    "access-control-allow-origin": allowed.includes(origin) ? origin : allowed[0] || "*",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, range",
    "access-control-expose-headers": "content-range, content-length",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

async function body(request) {
  try {
    return await request.json();
  } catch {
    throw fail(400, "bad json");
  }
}

function clampInt(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 && n < 20000 ? n : null;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}

function fail(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}
