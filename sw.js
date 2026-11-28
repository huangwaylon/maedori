// 前撮り メモ — service worker: lets the home-screen app open and play every clip with no signal.
// Registered as sw.js?v=<ASSET_V>, so each deploy installs a fresh copy (and a fresh app shell).
// - app shell (index.html, app.js, style.css): precached per version; the page is network-first with a short timeout
// - media (clips/… from this site, /media/uploads/… from the Worker): cache-first from the "media" cache, which the
//   page fills in the background (see offline sync in app.js). Range requests are answered from the cached file,
//   since Safari asks for videos in byte ranges.
"use strict";

const VERSION = new URL(self.location.href).searchParams.get("v") || "0";
const SHELL = `maedori-shell-${VERSION}`;
const MEDIA = "maedori-media"; // survives deploys; keys are URLs without ?v=
const SHELL_FILES = [`app.js?v=${VERSION}`, `style.css?v=${VERSION}`];
// a page belongs to this version only if it loads this version's app.js (the CDN can briefly serve an older page)
const isOurPage = (html) => html.includes(`app.js?v=${VERSION}"`);

self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      await cache.addAll(SHELL_FILES.map((u) => new Request(u, { cache: "reload" })));
      // the page itself, fetched with a unique URL so the CDN can't hand back an older copy
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`./?v=${VERSION}&i=${Date.now()}`, { cache: "reload" });
        if (res.ok && isOurPage(await res.clone().text())) {
          await cache.put("./", res);
          break;
        }
        if (i === 2) throw new Error("page for this version not available yet"); // install fails; retried on next load
        await new Promise((r) => setTimeout(r, 3000));
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith("maedori-shell-") && key !== SHELL) await caches.delete(key);
      await self.clients.claim();
    })()
  );
});

// clips/… are versioned with ?v= for the browser cache; the media cache keys them without it
const mediaKey = (url) => (url.origin === self.location.origin ? url.origin + url.pathname : url.href);
const isMedia = (url) =>
  (url.origin === self.location.origin && url.pathname.includes("/clips/")) || url.pathname.startsWith("/media/uploads/");

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (req.mode === "navigate") return e.respondWith(page(req));
  if (url.searchParams.has("swbypass")) return; // the page checking the server directly (re-cut clips)
  if (isMedia(url)) return e.respondWith(media(req, url));
  if (url.origin === self.location.origin && /\/(app\.js|style\.css)$/.test(url.pathname)) return e.respondWith(shellFile(req));
  // everything else (version.json, /api/data, writes) goes straight to the network
});

// the page: fresh when there is signal (so updates arrive), the cached copy when there isn't.
// The 4s timeout only applies when there is a cached copy to fall back to; a late answer is still kept.
async function page(req) {
  const cache = await caches.open(SHELL);
  const cached = (await cache.match("./")) || (await caches.match(req, { ignoreSearch: true }));
  const net = fetch(req).then(async (res) => {
    if (res.ok && isOurPage(await res.clone().text())) await cache.put("./", res.clone());
    return res;
  });
  if (!cached) return net.catch(() => Response.error());
  try {
    return await withTimeout(net, 4000);
  } catch {
    net.catch(() => {}); // still lands in the cache when it finishes
    return cached;
  }
}

async function shellFile(req) {
  const hit = await caches.match(req); // exact ?v= match first: never mix versions
  if (hit) return hit;
  try {
    return await fetch(req);
  } catch {
    return (await caches.match(req, { ignoreSearch: true })) || Response.error(); // offline: any saved copy beats a blank page
  }
}

async function media(req, url) {
  const cache = await caches.open(MEDIA);
  const hit = await cache.match(mediaKey(url));
  if (!hit) {
    try {
      return await fetch(req);
    } catch {
      return new Response("", { status: 504, statusText: "offline" });
    }
  }
  const range = req.headers.get("range");
  if (!range) return hit;
  return rangeOf(hit, range);
}

// Answer "Range: bytes=a-b" from a whole cached file (Safari needs 206 responses to play video)
async function rangeOf(res, range) {
  const blob = await res.blob();
  const size = blob.size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let start = 0, end = size - 1;
  if (m && m[1]) {
    start = Number(m[1]);
    if (m[2]) end = Math.min(Number(m[2]), size - 1);
  } else if (m && m[2]) start = Math.max(0, size - Number(m[2]));
  if (!m || start > end || start >= size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      "content-type": res.headers.get("content-type") || blob.type || "application/octet-stream",
      "content-range": `bytes ${start}-${end}/${size}`,
      "content-length": String(end - start + 1),
      "accept-ranges": "bytes",
    },
  });
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}
