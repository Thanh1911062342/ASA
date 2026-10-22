/**
 * Whole-episode download into Cache Storage, so an episode plays with no
 * network at all.
 *
 * Two things decide the shape of this file:
 *
 * 1. **The proxy URL is not a stable key.** `episode.proxy_url` is
 *    `/media/proxy?url=<upstream>` and that upstream token expires within
 *    minutes (`backend/app/api/media.py:31-34`), so a pack stored under the
 *    real URL would miss on the next playback. Everything here is written
 *    under a synthetic `/__offline/ep/<id>/…` key instead, plus a rewritten
 *    playlist that points at those keys — see `rewritePlaylist`.
 * 2. **`cache.put` is awaited here, unlike in `sw.js`.** The worker writes
 *    fire-and-forget, which is right for a session cache that is dropped on
 *    every reload. A downloaded pack is the opposite: the user asked for it,
 *    the UI reports real progress, and a byte reported as stored has to be on
 *    disk. So the page does the writing.
 *
 * Jobs live in a module-level registry, not in React state: navigating from
 * `/watch/3` to another episode must not cancel the download. Only a reload
 * does (and the store downgrades an interrupted entry to `partial`).
 */

import { isByterangePlaylist, parsePlaylist, toAbsolute } from "./preload";
import { useDownloads } from "../stores";
import type { DownloadEntry } from "../stores";
import type { Episode } from "../types";

export const OFFLINE_CACHE = "nv-offline-v1";
const API_CACHE = "nv-api-v1";
export const OFFLINE_PREFIX = "/__offline/ep/";

/**
 * Marks every media request this module makes, so `sw.js` leaves its own
 * session cache alone. Without it each segment is written twice — once here,
 * once by the worker into `nv-media-v1` — which doubles the download's disk
 * footprint for a cache that is deleted on the next reload anyway.
 */
export const OFFLINE_REQ_HEADER = "X-Nv-Offline";

/** Where the artifacts of one downloaded episode live. */
export const packBase = (episodeId: number) => `${OFFLINE_PREFIX}${episodeId}/`;
export const packPlaylist = (episodeId: number) => `${packBase(episodeId)}playlist.m3u8`;
export const packSegment = (episodeId: number, index: number) =>
  `${packBase(episodeId)}seg/${String(index).padStart(5, "0")}.ts`;
export const packVideo = (episodeId: number) => `${packBase(episodeId)}video.mp4`;
export const packThumb = (episodeId: number) => `${packBase(episodeId)}thumb.jpg`;

/** 4, not preload's 6: hls.js is very likely still streaming this same episode
 * while it downloads, and HTTP/1.1 only gives the host six connections. */
const WORKERS = 4;
const RETRY_DELAY_MS = 800;
/** Store writes are throttled — ~4/s reads as smooth and keeps the persisted
 * localStorage entry from being rewritten on every one of ~140 segments. */
const EMIT_MS = 250;
/** Give up only after this many consecutive segment failures. A pack is useless
 * half-built, and a CDN that stopped answering must surface as an error rather
 * than as a spinner that never finishes. */
const MAX_STREAK = 8;

/** `.ts`/`.m4s`/`.aac` — the container is sniffed from the bytes by hls.js. */
const SEGMENT_TYPE = "video/mp2t";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isAbort = (err: unknown) => (err as Error)?.name === "AbortError";

export const offlineSupported = () => typeof caches !== "undefined";

/** Thrown for anything the user should read as a sentence, in Vietnamese. */
class DownloadError extends Error {}

/** `cache.put` rejecting because the origin is out of storage. */
class QuotaError extends Error {}

function isQuota(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  return !!e && (e.name === "QuotaExceededError" || /quota|storage/i.test(e.message ?? ""));
}

async function putCached(cache: Cache, key: string, res: Response): Promise<void> {
  try {
    await cache.put(new Request(key), res);
  } catch (err) {
    if (isQuota(err)) throw new QuotaError();
    throw err;
  }
}

/** Absolute URL for a possibly root-relative one. */
function resolve(uri: string, base: string): string {
  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
}

// --------------------------------------------------------------- playlist

const URI_ATTR_RE = /URI="([^"]*)"/g;
/** `#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"` — a map that is itself a byte
 * range. Nothing here can serve a partial body, so the playlist is refused. */
const MAP_BYTERANGE_RE = /#EXT-X-MAP:[^\n]*BYTERANGE=/i;

/** Reason this playlist cannot become an offline pack, or null if it can. */
export function unsupportedReason(body: string): string | null {
  if (isByterangePlaylist(body) || MAP_BYTERANGE_RE.test(body)) {
    return "Nguồn này dùng byte-range nên chưa tải offline được.";
  }
  return null;
}

interface PackPlan {
  /** the rewritten playlist body, stored under `packPlaylist` */
  body: string;
  /** absolute upstream URL of each segment, index = pack index */
  segments: string[];
  /** encryption keys and fMP4 init segments, fetched before the segments */
  assets: { url: string; key: string }[];
  /** sum of every `#EXTINF` in the playlist */
  duration: number;
}

/**
 * Rewrite a media playlist line by line, pointing at pack keys.
 *
 * Deliberately not a re-generation from the parsed segment list: a real
 * playlist carries `#EXT-X-KEY`, `#EXT-X-MAP`, `#EXT-X-DISCONTINUITY`,
 * `#EXT-X-TARGETDURATION` and friends, and hls.js needs all of them. Only two
 * things are substituted — bare URI lines, and the `URI="…"` attribute of the
 * key/map directives (the same attribute the backend rewrites on the way out,
 * `backend/app/services/hls.py:73-94`).
 */
export function rewritePlaylist(body: string, baseUrl: string, episodeId: number): PackPlan {
  const base = toAbsolute(baseUrl);
  const segments: string[] = [];
  const assets: { url: string; key: string }[] = [];
  const assetIndex = new Map<string, string>();
  const out: string[] = [];
  let duration = 0;
  let endlist = false;

  /** Cache the key/init segment and return the pack path to point at. */
  const addAsset = (uri: string, dir: string, ext: string) => {
    const abs = resolve(uri, base);
    const seen = assetIndex.get(abs);
    if (seen) return seen;
    const key = `${packBase(episodeId)}${dir}/${assets.length}.${ext}`;
    assetIndex.set(abs, key);
    assets.push({ url: abs, key });
    return key;
  };

  for (const raw of body.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const text = line.trim();
    if (!text) {
      out.push(line);
      continue;
    }
    if (text.startsWith("#")) {
      if (text.startsWith("#EXT-X-ENDLIST")) endlist = true;
      else if (text.startsWith("#EXT-X-KEY")) {
        out.push(line.replace(URI_ATTR_RE, (_m, uri: string) => `URI="${addAsset(uri, "key", "key")}"`));
        continue;
      } else if (text.startsWith("#EXT-X-MAP")) {
        out.push(line.replace(URI_ATTR_RE, (_m, uri: string) => `URI="${addAsset(uri, "map", "mp4")}"`));
        continue;
      } else {
        const inf = /^#EXTINF:\s*(-?[\d.]+)/.exec(text);
        if (inf) {
          const secs = Number(inf[1]);
          if (Number.isFinite(secs) && secs > 0) duration += secs;
        }
      }
      out.push(line);
      continue;
    }
    // A bare URI line: the next segment, in order.
    segments.push(resolve(text, base));
    out.push(packSegment(episodeId, segments.length - 1));
  }

  // Without ENDLIST hls.js treats the playlist as live and keeps re-fetching it.
  if (!endlist) out.push("#EXT-X-ENDLIST");
  return { body: `${out.join("\n")}\n`, segments, assets, duration };
}

// ------------------------------------------------------------------ jobs

interface Job {
  /** set the moment the job is cancelled or replaced — silences every write */
  dead: boolean;
  controller: AbortController;
  entry: DownloadEntry;
}

const jobs = new Map<number, Job>();

export const isDownloading = (episodeId: number) => jobs.has(episodeId);

function blankEntry(ep: Episode): DownloadEntry {
  return {
    episodeId: ep.id,
    seriesId: ep.series_id,
    seriesSlug: ep.series?.slug ?? "",
    seriesTitle: ep.series?.title ?? "",
    number: ep.number,
    title: ep.title,
    thumbnail: ep.thumbnail,
    duration: ep.duration,
    sourceType: ep.source_type,
    loaded: 0,
    total: 0,
    bytes: 0,
    size: 0,
    status: "downloading",
    error: null,
    updatedAt: Date.now(),
  };
}

/** Abort a running job. Bytes already written stay, so `partial` is resumable. */
export function cancelDownload(episodeId: number): void {
  const job = jobs.get(episodeId);
  if (!job) return;
  job.dead = true;
  job.controller.abort();
  jobs.delete(episodeId);
  const { entry } = job;
  if (!entry.loaded && !entry.bytes) {
    // Nothing landed on disk: leave no half-entry behind.
    useDownloads.getState().remove(episodeId);
    return;
  }
  entry.status = "partial";
  entry.updatedAt = Date.now();
  useDownloads.getState().put({ ...entry });
}

/** Delete a pack's bytes and its metadata. Never called automatically — the
 * user is the only one who decides what to give back to the browser. */
export async function removeDownload(episodeId: number): Promise<void> {
  cancelDownload(episodeId);
  useDownloads.getState().remove(episodeId);
  if (!offlineSupported()) return;
  try {
    const cache = await caches.open(OFFLINE_CACHE);
    const prefix = packBase(episodeId);
    const keys = await cache.keys();
    await Promise.all(
      keys.filter((r) => new URL(r.url).pathname.startsWith(prefix)).map((r) => cache.delete(r)),
    );
  } catch {
    /* nothing cached under that prefix */
  }
}

/**
 * Is a complete pack actually on disk for this episode?
 *
 * The store is metadata only, and the browser may evict Cache Storage under
 * pressure even after `navigator.storage.persist()`. Checking the bytes is what
 * keeps the player from switching to an offline URL that no longer exists.
 */
export async function hasPack(episodeId: number): Promise<boolean> {
  if (!offlineSupported()) return false;
  try {
    const cache = await caches.open(OFFLINE_CACHE);
    if (await cache.match(packPlaylist(episodeId))) return true;
    return !!(await cache.match(packVideo(episodeId)));
  } catch {
    return false;
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number }> {
  try {
    const est = await navigator.storage?.estimate?.();
    return { usage: est?.usage ?? 0, quota: est?.quota ?? 0 };
  } catch {
    return { usage: 0, quota: 0 };
  }
}

// ------------------------------------------------------------------ start

/**
 * Download the whole episode in the background. Returns immediately; progress
 * and the outcome are reported through `useDownloads`.
 */
export function startDownload(ep: Episode): void {
  if (jobs.has(ep.id) || !offlineSupported()) return;

  const controller = new AbortController();
  const { signal } = controller;
  const job: Job = { dead: false, controller, entry: blankEntry(ep) };
  const { entry } = job;
  jobs.set(ep.id, job);

  let lastWrite = 0;
  const put = (force = false) => {
    if (job.dead) return;
    const now = Date.now();
    if (!force && now - lastWrite < EMIT_MS) return;
    lastWrite = now;
    entry.updatedAt = now;
    useDownloads.getState().put({ ...entry });
  };

  const media = (url: string) => fetch(url, { signal, headers: { [OFFLINE_REQ_HEADER]: "1" } });

  async function fetchWithRetry(url: string): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const res = await media(url);
        if (res.ok) return res;
        if ((res.status === 403 || res.status === 429) && attempt === 0) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        throw new DownloadError(`Nguồn trả về lỗi ${res.status}.`);
      } catch (err) {
        if (isAbort(err) || err instanceof DownloadError) throw err;
        if (attempt === 0) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        throw err;
      }
    }
  }

  async function fetchPlaylist(url: string): Promise<{ body: string; url: string }> {
    const res = await fetchWithRetry(url);
    const body = await res.text();
    if (!body.trimStart().startsWith("#EXTM3U")) {
      throw new DownloadError("Link này không phải playlist HLS.");
    }
    return { body, url: toAbsolute(url) };
  }

  /** One episode's worth of segments, from a media playlist. */
  async function downloadHls(cache: Cache): Promise<void> {
    const first = ep.proxy_url ?? ep.hls_url;
    if (!first) throw new DownloadError("Tập này chưa có nguồn video.");

    let { body, url } = await fetchPlaylist(first);
    if (body.includes("#EXT-X-STREAM-INF")) {
      // A master: pick the one variant worth keeping, then work on that.
      const variant = parsePlaylist(body, url).variants[0];
      if (!variant) throw new DownloadError("Playlist không có biến thể nào dùng được.");
      ({ body, url } = await fetchPlaylist(variant));
    }

    const reason = unsupportedReason(body);
    if (reason) throw new DownloadError(reason);

    const plan = rewritePlaylist(body, url, ep.id);
    if (!plan.segments.length) throw new DownloadError("Playlist không có segment nào.");

    // `parsePlaylist` and `rewritePlaylist` enumerate the same URI lines in the
    // same order; if that ever stopped holding, the index mapping would be
    // silently wrong and the pack would play the wrong pieces.
    const parsed = parsePlaylist(body, url);
    if (parsed.segments.length !== plan.segments.length) {
      throw new DownloadError("Không đọc được playlist này.");
    }

    entry.total = plan.segments.length;
    entry.size = entry.bytes;
    if (!entry.duration && plan.duration > 0) entry.duration = plan.duration;
    put(true);

    // Keys and init segments first: tiny, and a pack with segments but no key
    // is undecryptable.
    for (const asset of plan.assets) {
      const res = await fetchWithRetry(asset.url);
      await putCached(
        cache,
        asset.key,
        new Response(await res.arrayBuffer(), {
          headers: { "Content-Type": res.headers.get("content-type") || "application/octet-stream" },
        }),
      );
    }

    // Resume by probing, not by keeping an index list: whatever is already in
    // the cache is skipped, so "Tải tiếp" only pulls the holes, and the answer
    // stays right even if the user deleted part of the pack by hand.
    const missing: number[] = [];
    for (let i = 0; i < plan.segments.length; i += 1) {
      const hit = await cache.match(packSegment(ep.id, i));
      if (!hit) {
        missing.push(i);
      } else {
        entry.loaded += 1;
        // `.blob().size`, not `arrayBuffer()`: the size is known without
        // pulling ~95 MB through the JS heap just to count it.
        entry.bytes += (await hit.clone().blob()).size;
      }
    }
    put(true);

    let streak = 0;
    // In index order, from the front. This is deliberately *not* preload's
    // interleaved-by-region order: that exists so a partly-filled session cache
    // covers the whole timeline, but here the entire episode is wanted, so order
    // only matters if the user stops early — and then a contiguous prefix from
    // 00:00 is the part still worth watching.
    const queue = missing;
    let cursor = 0;

    async function worker(): Promise<void> {
      for (;;) {
        if (signal.aborted) return;
        const at = cursor;
        cursor += 1;
        if (at >= queue.length) return;
        const index = queue[at];
        try {
          const res = await fetchWithRetry(plan.segments[index]);
          const buf = await res.arrayBuffer();
          await putCached(
            cache,
            packSegment(ep.id, index),
            new Response(buf, {
              headers: { "Content-Type": res.headers.get("content-type") || SEGMENT_TYPE },
            }),
          );
          entry.bytes += buf.byteLength;
          entry.loaded += 1;
          streak = 0;
        } catch (err) {
          if (isAbort(err)) return;
          if (err instanceof QuotaError) throw err;
          streak += 1;
          if (streak >= MAX_STREAK) {
            throw new DownloadError("Nguồn ngừng trả dữ liệu. Thử lại sau ít phút.");
          }
        }
        put();
      }
    }

    await Promise.all(Array.from({ length: Math.max(1, Math.min(WORKERS, queue.length)) }, worker));

    if (entry.loaded < entry.total) {
      throw new DownloadError("Tải chưa xong. Bấm “Tải tiếp” để thử lại.");
    }
    // Not known up front for HLS — the segment sizes are only revealed by
    // fetching them, so the total is whatever actually landed.
    entry.size = entry.bytes;

    // The playlist is written last on purpose: its absence is what marks a pack
    // as incomplete, so `hasPack` can never call a half-downloaded episode
    // playable.
    await putCached(
      cache,
      packPlaylist(ep.id),
      new Response(plan.body, { headers: { "Content-Type": "application/vnd.apple.mpegurl" } }),
    );
  }

  /** One self-hosted MP4. A single request — an MP4 cannot be resumed, so a
 * failure here costs the whole download and the user's only recourse is to
 * start over; hence the one retry. */
  async function downloadFile(cache: Cache): Promise<void> {
    const url = ep.stream_url;
    if (!url) throw new DownloadError("Tập này chưa có nguồn video.");

    for (let attempt = 0; ; attempt += 1) {
      try {
        await downloadFileOnce(cache, url);
        return;
      } catch (err) {
        if (attempt >= 1 || isAbort(err) || err instanceof QuotaError || err instanceof DownloadError) {
          throw err;
        }
        // Nothing was kept from the failed attempt, so this only costs time.
        console.warn("offline: file download failed, retrying once", err);
        entry.bytes = 0;
        entry.loaded = 0;
        put(true);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  async function downloadFileOnce(cache: Cache, url: string): Promise<void> {
    // No `Range` header, so `/media/{path}` answers 200 with the whole body
    // (`backend/app/api/media.py:272-286`) — which is what `cache.put` needs,
    // since it throws on a 206.
    const res = await fetchWithRetry(url);
    if (!res.body) throw new DownloadError("Không đọc được nội dung file.");

    const declared = Number(res.headers.get("content-length") ?? 0);
    entry.total = 1;
    entry.size = Number.isFinite(declared) ? declared : 0;
    put(true);

    const type = res.headers.get("content-type") || "video/mp4";
    // `tee()`: one branch streams to Cache Storage — which writes straight to
    // disk and never holds the file in the JS heap — while the other is read
    // only to count bytes, since `<video>` gets no progress events from us.
    const [toCache, toCount] = res.body.tee();
    const writing = putCached(cache, packVideo(ep.id), new Response(toCache, { headers: { "Content-Type": type } }))
      // Converted to a value so a rejection is never unhandled when the reader
      // below throws first (cancel, or a dropped connection).
      .then(() => null)
      .catch((err: unknown) => err);

    const reader = toCount.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      entry.bytes += value.byteLength;
      put();
    }

    const failed = await writing;
    if (failed) throw failed;
    if (!entry.size) entry.size = entry.bytes;
    entry.loaded = 1;
    put(true);
  }

  /** Tiny extras, so the pack is usable without ever touching the network. */
  async function grabExtras(cache: Cache): Promise<void> {
    if (ep.thumbnail) {
      try {
        const res = await fetch(ep.thumbnail, { signal });
        if (res.ok) {
          await cache.put(
            new Request(packThumb(ep.id)),
            new Response(await res.arrayBuffer(), {
              headers: { "Content-Type": res.headers.get("content-type") || "image/jpeg" },
            }),
          );
          // Point the listing at the pack copy: `/media/{path}` is not served by
          // the Service Worker at all, so the original URL is dead offline.
          entry.thumbnail = packThumb(ep.id);
        }
      } catch {
        /* a missing thumbnail is not worth failing the pack over */
      }
    }

    // Watch.tsx's data loading is deliberately untouched — it keeps calling the
    // public API, and `sw.js` answers from `nv-api-v1` when the network is gone.
    // Seeding those keys here means the pack is self-sufficient even on the very
    // first visit, before the worker controls the page.
    const urls = ["/api/series", `/api/episodes/${ep.id}`, `/api/episodes/${ep.id}/subtitles`];
    if (ep.series?.slug) urls.push(`/api/series/${ep.series.slug}`);
    try {
      const api = await caches.open(API_CACHE);
      for (const url of urls) {
        try {
          const res = await fetch(url, { signal });
          if (!res.ok) continue;
          await api.put(
            new Request(url),
            new Response(await res.text(), { headers: { "Content-Type": "application/json" } }),
          );
        } catch {
          /* one missing endpoint must not fail the pack */
        }
      }
    } catch {
      /* API cache unavailable */
    }
  }

  void (async () => {
    try {
      const cache = await caches.open(OFFLINE_CACHE);
      if (ep.source_type === "hls") await downloadHls(cache);
      else await downloadFile(cache);
      await grabExtras(cache);
      if (signal.aborted || job.dead) return;
      entry.status = "done";
      entry.error = null;
      put(true);
    } catch (err) {
      if (job.dead || isAbort(err)) return;
      entry.status = "error";
      entry.error =
        err instanceof QuotaError
          ? "Không đủ dung lượng — hãy xóa bớt tập đã tải."
          : err instanceof DownloadError
            ? err.message
            : `Không tải được tập này (${(err as Error)?.name || "lỗi mạng"}).`;
      entry.updatedAt = Date.now();
      useDownloads.getState().put({ ...entry });
    } finally {
      if (jobs.get(ep.id)?.controller === controller) jobs.delete(ep.id);
    }
  })();
}