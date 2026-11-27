// maedori-api — shared storage for the 前撮り メモ site (GitHub Pages frontend).
// D1 holds sections, items (clips/photos), their order and notes.
// Media: the original clips/photos live in the GitHub repo (served by Pages, key "clips/…");
// photos/videos uploaded from phones live in KV (key "uploads/…"), split into 20 MB chunks.
// Reads are public. Every write needs the passcode (Bearer token), set as the PASSCODE secret.

const MAX_UPLOAD = 95 * 1024 * 1024; // Workers accept request bodies up to 100 MB
const CHUNK = 20 * 1024 * 1024; // KV values max out at 25 MiB
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
  const method = request.method;

  if (method === "GET" && pathname === "/api/data") return json(await readAll(env));
  if ((method === "GET" || method === "HEAD") && pathname.startsWith("/media/")) return media(request, env, decodeURIComponent(pathname.slice(7)));

  // ---- writes ----
  if (!(await authorized(request, env))) throw fail(401, "passcode required");
  if (method === "POST" && pathname === "/api/check") return json({ ok: true });
  if (method === "PUT" && pathname.startsWith("/api/notes/")) return setNote(request, env, decodeURIComponent(pathname.slice(11)));
  if (method === "PUT" && pathname === "/api/order") return setOrder(request, env);
  if (method === "POST" && pathname === "/api/sections") return addSection(request, env);
  if (method === "POST" && pathname === "/api/upload") return upload(request, env, url);
  if (method === "PUT" && pathname.startsWith("/api/poster/")) return setPoster(request, env, decodeURIComponent(pathname.slice(12)));
  if (method === "PUT" && pathname === "/api/import") return importItem(request, env);
  if (method === "DELETE" && pathname.startsWith("/api/items/")) return removeItem(env, decodeURIComponent(pathname.slice(11)));
  throw fail(404, "not found");
}

// ---------- reads ----------
async function readAll(env) {
  const [sections, items] = await env.DB.batch([
    env.DB.prepare("SELECT name FROM sections ORDER BY pos"),
    env.DB.prepare("SELECT id, kind, section, pos, note, w, h, src_start, src_end, media, poster FROM items ORDER BY pos"),
  ]);
  return {
    sections: sections.results.map((r) => r.name),
    items: items.results.map((r) => ({
      id: r.id,
      kind: r.kind,
      section: r.section,
      note: r.note || "",
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
  const meta = await env.MEDIA.get(`m:${key}`, "json");
  if (!meta) throw fail(404, "not found");
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
  const first = Math.floor(start / CHUNK), last = Math.floor(end / CHUNK);
  const { readable, writable } = new FixedLengthStream(end - start + 1);
  (async () => {
    const writer = writable.getWriter();
    try {
      for (let i = first; i <= last; i++) {
        const buf = new Uint8Array(await env.MEDIA.get(`c:${key}:${i}`, "arrayBuffer"));
        const from = i === first ? start - i * CHUNK : 0;
        const to = i === last ? end - i * CHUNK + 1 : buf.length;
        await writer.write(buf.subarray(from, to));
      }
      await writer.close();
    } catch (err) {
      await writer.abort(err);
    }
  })();
  const body = readable;
  return new Response(body, { status, headers });
}

// Stream a request body into KV in CHUNK-sized pieces; returns the total size
async function putChunked(env, key, stream, type) {
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
    await env.MEDIA.put(`c:${key}:${n++}`, out);
  };
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
  await env.MEDIA.put(`m:${key}`, JSON.stringify({ type, size, chunks: n }));
  return size;
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

// { order: { section: [ids...] } } — every listed id gets that section and position
async function setOrder(request, env) {
  const { order } = await body(request);
  if (!order || typeof order !== "object") throw fail(400, "bad order");
  const known = new Set((await env.DB.prepare("SELECT name FROM sections").all()).results.map((r) => r.name));
  const stmts = [];
  let pos = 0;
  for (const [section, ids] of Object.entries(order)) {
    if (!known.has(section) || !Array.isArray(ids)) throw fail(400, "bad section");
    for (const id of ids) {
      if (typeof id !== "string") throw fail(400, "bad id");
      stmts.push(env.DB.prepare("UPDATE items SET section = ?, pos = ?, updated_at = ? WHERE id = ?").bind(section, pos++, Date.now(), id));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
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
  const { max } = await env.DB.prepare("SELECT COALESCE(MAX(pos), -1) AS max FROM items").first();
  await env.DB.prepare("INSERT INTO items (id, kind, section, pos, note, w, h, media, poster, created_at, updated_at) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)")
    .bind(id, kind, section, max + 1, w, h, mediaKey, kind === "image" ? mediaKey : null, Date.now(), Date.now()).run();
  return json({ ok: true, id });
}

// raw JPEG body: the still shown before a video plays (and as its edit-mode thumbnail)
async function setPoster(request, env, id) {
  const row = await env.DB.prepare("SELECT kind FROM items WHERE id = ?").bind(id).first();
  if (!row || row.kind !== "video" || !id.startsWith("u")) throw fail(404, "no such video");
  const key = `uploads/${id}.poster.jpg`;
  await putChunked(env, key, request.body, "image/jpeg");
  await env.DB.prepare("UPDATE items SET poster = ?, updated_at = ? WHERE id = ?").bind(key, Date.now(), id).run();
  return json({ ok: true });
}

// one-off migration helper: upsert an item row (its files are already in the repo)
async function importItem(request, env) {
  const meta = await body(request);
  await env.DB.prepare(
    `INSERT INTO items (id, kind, section, pos, note, w, h, src_start, src_end, media, poster, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
     ON CONFLICT(id) DO UPDATE SET kind=?2, section=?3, pos=?4, note=?5, w=?6, h=?7, src_start=?8, src_end=?9, media=?10, poster=?11, updated_at=?12`
  ).bind(meta.id, meta.kind, meta.section, meta.pos, meta.note || "", meta.w, meta.h, meta.start ?? null, meta.end ?? null, meta.media, meta.poster, Date.now()).run();
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
