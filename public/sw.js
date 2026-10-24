/* Cache layer for the player and for offline packs (Cache Storage).
 *
 * Four caches, each with one job and one lifetime:
 *
 *   nv-media-v1   proxied HLS segments for the *current session*. Written by
 *                 this worker from `X-Media-Kind: segment` responses, and
 *                 deleted by the page on every load (see main.tsx) so nothing
 *                 stale survives an F5.
 *   nv-offline-v1 downloaded episode packs. Written **by the page**
 *                 (lib/download.ts) under the synthetic `/__offline/` prefix,
 *                 never by this worker, and it survives reloads.
 *   nv-shell-v1   navigations + hashed build assets, so the app opens with no
 *                 backend at all.
 *   nv-api-v1     public GET /api/* JSON (never /api/admin/*), network-first.
 *
 * Why the offline packs live under synthetic keys: `/media/proxy?url=…` carries
 * an upstream token that expires within minutes, so a pack keyed by the real URL
 * would never match on the next playback. download.ts rewrites the playlist to
 * point at `/__offline/ep/<id>/seg/…` and stores both.
 */
const CACHE = "nv-media-v1";
const OFFLINE = "nv-offline-v1";
const SHELL = "nv-shell-v1";
const API = "nv-api-v1";

const OFFLINE_PREFIX = "/__offline/";
/** The shell is stored under this canonical key, whatever URL navigated. */
const SHELL_KEY = "/index.html";

const HTML = { headers: { "Content-Type": "text/html; charset=utf-8" } };

/** Shown only when there is neither network nor a cached shell.
 * A factory, not a constant: a Response body can be consumed exactly once, so a
 * shared instance would serve the first request and break every one after it. */
const deadPage = () =>
  new Response(
    `<!doctype html><html lang="vi"><meta charset="utf-8">
   <meta name="viewport" content="width=device-width, initial-scale=1">
   <title>日本語 — offline</title>
   <body style="background:#18181b;color:#fbfbed;font:15px system-ui;padding:32px">
   <h2>Bạn đang offline</h2>
   <p>Ứng dụng chưa được lưu trên máy này, nên không mở được khi mất mạng.</p>
   <p>Hãy kết nối mạng và tải lại trang một lần.</p></body></html>`,
    HTML,
  );

/** A cached whole body cannot answer a Range request; say so plainly. */
const gone = () => new Response("offline pack not cached", { status: 504, statusText: "Not Cached" });

/** Only 200s are storable: `cache.put` throws on 206, redirects and `Vary: *`. */
function storable(res) {
  return res.ok && res.status === 200 && !res.redirected && res.headers.get("Vary") !== "*";
}

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  // Awaited, not fire-and-forget: this is the only write that puts the hashed
  // build assets in `nv-shell-v1`, and an unawaited `cache.put` is not covered by
  // `event.waitUntil`, so the browser may kill the worker mid-write and the
  // offline shell would be missing its JS.
  if (storable(res)) await cache.put(req, res.clone());
  return res;
}

/**
 * Re-wrap a cached response so the page can tell it did not come from the
 * network.
 *
 * Without this the app cannot distinguish "fresh list" from "yesterday's list
 * replayed", because both arrive as a perfectly ordinary 200. The home page
 * needs that difference: it must warn that only downloaded episodes are
 * playable instead of looking like nothing is wrong.
 *
 * Same-origin, so there is no CORS exposure: pages on another origin never see
 * this response.
 */
async function marked(hit) {
  const headers = new Headers(hit.headers);
  headers.set("X-Nv-Stale", "1");
  // `arrayBuffer()` hands back a decoded body, so the upstream's encoding and
  // length no longer describe it. Leaving them in would have the browser try to
  // decompress plain bytes (or truncate them), which is a far worse failure than
  // the staleness marker is worth.
  headers.delete("Content-Encoding");
  headers.delete("Content-Length");
  return new Response(await hit.arrayBuffer(), {
    status: hit.status,
    statusText: hit.statusText,
    headers,
  });
}

async function networkFirst(req, name, key) {
  const cache = await caches.open(name);
  const fromCache = async () => {
    const hit = (await cache.match(key ?? req)) || (key ? await cache.match(req) : null);
    return hit ? marked(hit) : null;
  };
  try {
    const res = await fetch(req);
    // A 5xx is a *successful fetch* that failed upstream, so it never reaches
    // the catch below. Vercel answers this way (502 + a plain-text body) when
    // the tunnel or the backend is down, and handing that to the app turned a
    // dead backend into a JSON parse error instead of a cache hit — the UI said
    // "Đang tải…" forever even with the episode sitting in `nv-offline-v1`.
    // Treat it like a network failure: last good copy wins.
    if (res.status >= 500) {
      return (await fromCache()) || res;
    }
    if (storable(res)) cache.put(key ?? req, res.clone());
    return res;
  } catch (err) {
    // Offline: fall back to the last good copy instead of failing the page.
    const hit = await fromCache();
    if (hit) return hit;
    throw err;
  }
}

async function navigation(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (storable(res)) cache.put(SHELL_KEY, res.clone());
    return res;
  } catch {
    return (await cache.match(SHELL_KEY)) || deadPage();
  }
}

self.addEventListener("install", () => self.skipWaiting());

// Deliberately deletes nothing: a new cache name must survive a worker update,
// and downloaded packs are the user's data. If cache-version pruning is ever
// added here, all four names above must be whitelisted.
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 1. Downloaded packs. Cache-only and checked *before* the Range bail below:
  //    a pack has no network to fall back to, and <video> always sends Range.
  if (url.pathname.startsWith(OFFLINE_PREFIX)) {
    event.respondWith(
      (async () => (await caches.open(OFFLINE)).match(req, { ignoreSearch: true }) || gone())(),
    );
    return;
  }

  // 2. Navigations: network-first so a rebuild shows up immediately, shell
  //    cache when the backend is down.
  if (req.mode === "navigate") {
    event.respondWith(navigation(req));
    return;
  }

  // 3. Public API JSON. Never /api/admin/* — auth'd, mutating-adjacent, and
  //    useless offline.
  if (url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/admin")) {
    event.respondWith(networkFirst(req, API).catch(() => gone()));
    return;
  }

  // 4. Hashed build assets: immutable, so cache-first is always correct.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(req, SHELL));
    return;
  }

  // 5. Proxied HLS segments, the original behaviour of this worker.
  if (!url.pathname.startsWith("/media/proxy")) return;
  // A Range request wants a genuine 206 from the server; never answer it from
  // a whole-body cache entry.
  if (req.headers.has("range")) return;
  // lib/download.ts writes its own copy into `nv-offline-v1` under the synthetic
  // `/__offline/` keys and marks its requests, because storing the same bytes
  // here as well would double the download's footprint in a cache that
  // main.tsx deletes on the next load anyway.
  if (req.headers.get("X-Nv-Offline")) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && res.headers.get("X-Media-Kind") === "segment" && storable(res)) {
        // Fire-and-forget by design: playback must not wait on the write.
        cache.put(req, res.clone());
      }
      return res;
    })(),
  );
});
