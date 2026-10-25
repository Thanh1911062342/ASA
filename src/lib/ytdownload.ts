/**
 * Download a YouTube episode to this device, muxing video and audio in the
 * browser.
 *
 * Why this is a whole extra pipeline rather than a case in `lib/download.ts`:
 *
 *  - YouTube has **no muxed format**. Every one of its ~50 formats is either
 *    video or audio, never both (checked against the live API: 0 of 53 had
 *    both, and an `ffprobe` of a real HLS segment showed only `h264 video`).
 *    So an offline copy is inherently two downloads plus a mux.
 *  - The browser cannot fetch the streams itself. `googlevideo.com` sends no
 *    `Access-Control-Allow-Origin`, so a page fetch fails while the same URL
 *    downloads fine server-side. Every byte therefore goes through the app's
 *    own `/media/proxy`, which relays but stores nothing.
 *
 * The mux runs on the user's machine, not the server, so watching one episode
 * never costs the server storage or a download it has to repeat per viewer.
 *
 * `@ffmpeg/core` is single-threaded (no SharedArrayBuffer, so no COOP/COEP
 * headers are needed) and is 32 MB, so it is fetched lazily and only when
 * someone actually asks for an offline copy.
 */

import { OFFLINE_CACHE, OFFLINE_REQ_HEADER, packBase } from "./download";
import { useDownloads } from "../stores";
import type { DownloadEntry } from "../stores";
import type { Episode } from "../types";

/**
 * The core is served from this app's own origin (`public/ffmpeg/`), not a CDN,
 * and the URLs passed to `load()` must be **absolute**.
 *
 * Both halves of that were bugs found the hard way:
 *
 *  - A CDN fails even though jsdelivr sends `Access-Control-Allow-Origin: *`
 *    and the file fetches fine on its own. ffmpeg.wasm imports the core inside
 *    a worker, and `@ffmpeg/util`'s `toBlobURL` now gets a worker whose origin
 *    is `blob:`, which refuses to import it.
 *  - A root-relative `/ffmpeg/…` fails for the same reason: the worker's base is
 *    `blob:…`, so `importScripts('/ffmpeg/ffmpeg-core.js')` is reported as
 *    "The URL is invalid" and surfaces only as `failed to import ffmpeg-core.js`.
 *    Resolving against `location.origin` first is what makes it work.
 *
 * The 32 MB cost is paid only when someone actually asks for an offline copy.
 */
const coreUrl = (file: string) => new URL(`/ffmpeg/${file}`, window.location.origin).href;

/**
 * A mux holds both streams in the WASM heap, so memory is the real limit —
 * roughly the size of the episode. Refusing up front with a clear message beats
 * a tab that dies mid-way through.
 */
export const MAX_YT_DURATION_S = 2 * 60 * 60;

/**
 * Range chunk size for a stream download.
 *
 * Load-bearing, not a tuning knob. YouTube throttles a whole-file GET to a
 * trickle — measured on this machine, the same audio track came down at
 * **32 KB/s** with a plain GET and **1,700-2,100 KB/s** as 2 MB Range requests,
 * a ~60x difference, consistent across formats. A 10 MB audio track therefore
 * takes 5 minutes one way and 5 seconds the other. `/media/proxy` already
 * forwards Range and answers 206, so no backend change was needed.
 */
const CHUNK_BYTES = 2 * 1024 * 1024;

const isAbort = (err: unknown) => (err as Error)?.name === "AbortError";

export const ytVideoKey = (episodeId: number) => `${packBase(episodeId)}video.ts`;
export const ytAudioKey = (episodeId: number) => `${packBase(episodeId)}audio.m4a`;
/** Where the muxed result goes — the same key a `file` pack uses, so playback
 * needs no new branch: `Player.tsx` already plays `video.mp4` as a blob. */
export const ytMuxedKey = (episodeId: number) => `${packBase(episodeId)}video.mp4`;

export interface YtDownloadState {
  /** downloading | muxing | done | error */
  phase: "fetching" | "core" | "muxing" | "done" | "error";
  loaded: number;
  total: number;
  bytes: number;
  error: string | null;
}

interface Streams {
  kind?: string;
  url?: string;
  video_hls?: string;
  audio?: string;
  audio_ext?: string;
  duration?: number;
  error?: string;
}

function entryFor(ep: Episode): DownloadEntry {
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

/**
 * Run the mux. Returns the size of the produced MP4, or throws.
 *
 * `-c copy` throughout: nothing is re-encoded, so an hour of video takes
 * seconds rather than the length of the video. The container is forced to mp4
 * because `-c copy` from MPEG-TS would otherwise stay `.ts`, which `<video>`
 * plays less reliably.
 */
async function muxToMp4(
  video: Uint8Array,
  audio: Uint8Array | null,
  audioName: string,
  onProgress: (ratio: number) => void,
): Promise<Uint8Array> {
  const { FFmpeg } = await import("@ffmpeg/ffmpeg");

  const ffmpeg = new FFmpeg();
  ffmpeg.on("progress", ({ progress }) => onProgress(Math.min(1, Math.max(0, progress))));
  // ffmpeg's own diagnostics are the only way to tell a bad argument from a bad
  // input; without them a failure reads as a bare "FS error".
  ffmpeg.on("log", ({ type, message }) => console.debug(`[ffmpeg ${type}]`, message));

  // The **esm** build of the core, and no `classWorkerURL`.
  //
  // @ffmpeg/ffmpeg always spawns its worker with `{ type: "module" }`, and a
  // module worker cannot use `importScripts` — calling it throws "Module scripts
  // don't support importScripts()". That rules out the umd core, which is why
  // `public/ffmpeg/` holds the esm build: the library's own worker loads it with
  // a dynamic `import()`, which is exactly what an esm core is for. Both URLs
  // are absolute because a module worker created from a blob has no usable base
  // to resolve a root-relative path against.
  await ffmpeg.load({
    coreURL: coreUrl("ffmpeg-core.js"),
    wasmURL: coreUrl("ffmpeg-core.wasm"),
  });

  try {
    await ffmpeg.writeFile("video.ts", video);
    const args = ["-i", "video.ts"];
    if (audio) {
      await ffmpeg.writeFile(audioName, audio);
      // The audio track is copied in as a second input; without it the output
      // has picture and silence, which is the exact failure this pipeline exists
      // to avoid.
      args.push("-i", audioName);
    }
    args.push("-c", "copy", "-map", "0:v:0");
    if (audio) args.push("-map", "1:a:0");
    // Without this, an odd audio timescale makes mp4 muxing fail or drift.
    args.push("-avoid_negative_ts", "make_zero", "out.mp4");

    await ffmpeg.exec(args);
    const data = await ffmpeg.readFile("out.mp4");
    if (typeof data === "string") throw new Error("ffmpeg trả về text thay vì video");
    return data as Uint8Array;
  } finally {
    // Best-effort cleanup only: `deleteFile` on a path that was never written
    // throws `ErrnoError: FS error` (ENOENT), and letting that escape would turn
    // a successful mux into a reported failure.
    for (const name of ["video.ts", audioName, "out.mp4"]) {
      try {
        await ffmpeg.deleteFile(name);
      } catch {
        /* not written, nothing to remove */
      }
    }
    ffmpeg.terminate();
  }
}

/**
 * Download every segment of an HLS playlist and concatenate them.
 *
 * `video_hls` is a **playlist**, not a media file, and ffmpeg refuses it
 * outright ("Failed to open an initialization section"). Segments must be
 * fetched individually and joined.
 *
 * Two details that a naive version gets wrong:
 *
 *  - The backend has **already** rewritten each URI to `/media/proxy?url=…`
 *    (see `rewrite_playlist` in `services/hls.py`). Wrapping them in a second
 *    proxy is a 400, so the paths are used as-is — only resolved against the
 *    page origin, because they are root-relative.
 *  - YouTube serves **fMP4**, not bare TS: the playlist carries an `#EXT-X-MAP`
 *    initialisation segment that has to come first, or the result is not
 *    decodable. It is fetched and prepended explicitly.
 */
async function fetchHls(
  playlistUrl: string,
  signal: AbortSignal,
  onBytes: (delta: number, total: number) => void,
): Promise<Uint8Array> {
  const res = await fetch(playlistUrl, { signal, headers: { [OFFLINE_REQ_HEADER]: "1" } });
  if (!res.ok) throw new Error(`Không đọc được playlist (${res.status}).`);
  const body = await res.text();

  // A master playlist points at variants; recurse into the last (lowest) one.
  if (body.includes("#EXT-X-STREAM-INF")) {
    const variant = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .pop();
    if (!variant) throw new Error("Playlist không có biến thể nào.");
    return fetchHls(new URL(variant, res.url).href, signal, onBytes);
  }

  // URIs are root-relative paths already pointing at our own proxy, so the page
  // origin is the only thing missing.
  const absolute = (uri: string) => new URL(uri, window.location.origin).href;

  const segments = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map(absolute);
  if (!segments.length) throw new Error("Playlist không có segment nào.");

  // fMP4 initialisation segment, if present. Must be first in the output.
  const mapMatch = /#EXT-X-MAP:URI="([^"]+)"/.exec(body);
  const init = mapMatch ? [absolute(mapMatch[1])] : [];

  const get = async (url: string) => {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const r = await fetch(url, { signal, headers: { [OFFLINE_REQ_HEADER]: "1" } });
    if (!r.ok) throw new Error(`Tải segment lỗi ${r.status}.`);
    const part = new Uint8Array(await r.arrayBuffer());
    onBytes(part.byteLength, Math.round((segments.length + init.length) * 400_000));
    return part;
  };

  // Sequential on purpose: bursting googlevideo from one IP is exactly what
  // triggers the throttling this path exists to avoid.
  const parts: Uint8Array[] = [];
  for (const url of init) parts.push(await get(url));
  let got = 0;
  for (const url of segments) {
    const part = await get(url);
    parts.push(part);
    got += part.byteLength;
  }

  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  void got;
  return out;
}

/** Read a cached artifact, or null. */
async function cached(cache: Cache, key: string): Promise<Response | null> {
  try {
    return (await cache.match(key)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Download a whole response in `Range` chunks and return the bytes.
 *
 * Two reasons this is not one `fetch`: YouTube throttles non-Range GETs by
 * roughly 60x (see `CHUNK_BYTES`), and chunking gives real progress for files
 * that can be tens of megabytes. Falls back to a single GET if the server does
 * not honour Range, so this works against any `/media/proxy` target.
 */
async function fetchChunked(
  url: string,
  signal: AbortSignal,
  onBytes: (delta: number, total: number) => void,
): Promise<Uint8Array> {
  const first = await fetch(url, {
    signal,
    headers: { [OFFLINE_REQ_HEADER]: "1", Range: `bytes=0-${CHUNK_BYTES - 1}` },
  });
  if (!first.ok && first.status !== 206) throw new Error(`Tải lỗi ${first.status}.`);

  // `206` + a parseable total is what says chunking is safe here.
  const contentRange = first.headers.get("content-range");
  const total = contentRange ? Number(contentRange.split("/")[1]) : 0;
  const head = new Uint8Array(await first.arrayBuffer());
  onBytes(head.byteLength, total || head.byteLength);

  if (first.status !== 206 || !Number.isFinite(total) || total <= head.byteLength) {
    // No Range support (or the whole thing already arrived): one shot.
    return head;
  }

  const parts: Uint8Array[] = [head];
  let received = head.byteLength;
  while (received < total) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const end = Math.min(received + CHUNK_BYTES, total) - 1;
    const res = await fetch(url, {
      signal,
      headers: { [OFFLINE_REQ_HEADER]: "1", Range: `bytes=${received}-${end}` },
    });
    if (!res.ok && res.status !== 206) throw new Error(`Tải lỗi ${res.status}.`);
    const part = new Uint8Array(await res.arrayBuffer());
    if (!part.byteLength) break; // guard against a server that answers 200 empty
    parts.push(part);
    received += part.byteLength;
    onBytes(part.byteLength, total);
  }

  // One contiguous buffer: ffmpeg.wasm wants a single file, and concatenating
  // once here beats letting the WASM side copy repeatedly.
  const out = new Uint8Array(received);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

export async function startYtDownload(episode: Episode, signal: AbortSignal): Promise<void> {
  const state: YtDownloadState = {
    phase: "fetching",
    loaded: 0,
    total: 0,
    bytes: 0,
    error: null,
  };
  const entry = entryFor(episode);
  let lastWrite = 0;
  const put = (force = false) => {
    const now = Date.now();
    if (!force && now - lastWrite < 250) return;
    lastWrite = now;
    entry.updatedAt = now;
    entry.bytes = state.bytes;
    useDownloads.getState().put({ ...entry });
  };

  const fail = (message: string) => {
    entry.status = "error";
    entry.error = message;
    entry.updatedAt = Date.now();
    useDownloads.getState().put({ ...entry });
  };

  if (!("caches" in window)) return fail("Trình duyệt không hỗ trợ lưu trữ offline.");

  try {
    // ---- 1. ask the server for fresh stream URLs (they expire in hours)
    entry.status = "downloading";
    entry.error = "Đang lấy link…";
    put(true);

    const res = await fetch(`/api/episodes/${episode.id}/yt-streams`, { method: "POST", signal });
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      throw new Error(detail?.detail ?? `Máy chủ trả về ${res.status}`);
    }
    const streams = (await res.json()) as Streams;
    if (streams.error) throw new Error(streams.error);

    if (streams.duration && streams.duration > MAX_YT_DURATION_S) {
      throw new Error(
        `Video dài ${Math.round(streams.duration / 60)} phút — quá dài để ghép trên máy. Giới hạn ${MAX_YT_DURATION_S / 3600} giờ.`,
      );
    }

    const cache = await caches.open(OFFLINE_CACHE);
    const audioName = `audio.${streams.audio_ext || "m4a"}`;

    // Progress across both stream downloads. `want` accumulates the Content-Length
    // each stream reports, so the bar covers video + audio as one job; the mux
    // phase then takes the bar over and reports 0..100 of its own.
    let got = 0;
    let want = 0;
    /** Which stream's total has already been counted into `want`. */
    let lastTotal = -1;
    const onBytes = (delta: number, total: number) => {
      got += delta;
      // Each stream reports its own total; add it once per stream.
      if (total > 0 && total !== lastTotal) {
        want += total;
        lastTotal = total;
      }
      state.bytes = got;
      const pct = want > 0 ? Math.min(100, Math.round((got / want) * 100)) : 0;
      entry.loaded = pct;
      entry.total = 100;
      entry.error = `Đang tải ${pct}%`;
      put();
    };

    // ---- 2. video. A `muxed` result is one plain file; `split` means an HLS
    //         playlist of video-only segments.
    let videoBytes: Uint8Array | null = null;
    const vidHit = await cached(cache, ytVideoKey(episode.id));
    if (vidHit) {
      videoBytes = new Uint8Array(await vidHit.arrayBuffer());
      state.bytes += videoBytes.byteLength;
    } else {
      const videoUrl =
        streams.kind === "muxed"
          ? streams.url
          : `/media/proxy?url=${encodeURIComponent(streams.video_hls ?? "")}`;
      if (!videoUrl || videoUrl.endsWith("url=")) throw new Error("Không có link video.");
      // `muxed` is a real file; the split case gives a playlist that has to be
      // expanded into segments (see fetchHls).
      videoBytes =
        streams.kind === "muxed"
          ? await fetchChunked(videoUrl, signal, onBytes)
          : await fetchHls(videoUrl, signal, onBytes);
      const type = streams.kind === "muxed" ? "video/mp4" : "video/mp2t";
      await cache.put(ytVideoKey(episode.id), new Response(videoBytes, { headers: { "Content-Type": type } }));
      state.bytes += videoBytes.byteLength;
    }
    put(true);

    // A `muxed` source is already playable: store it under the normal video key
    // so the existing blob-URL player path picks it up, and stop here.
    if (streams.kind === "muxed") {
      await cache.put(
        ytMuxedKey(episode.id),
        new Response(videoBytes, { headers: { "Content-Type": "video/mp4" } }),
      );
      entry.size = entry.bytes = state.bytes;
      entry.loaded = entry.total = 1;
      entry.error = null;
      entry.status = "done";
      put(true);
      return;
    }

    // ---- 3. audio (only for `split`)
    let audioBytes: Uint8Array | null = null;
    const audHit = await cached(cache, ytAudioKey(episode.id));
    if (audHit) {
      audioBytes = new Uint8Array(await audHit.arrayBuffer());
      state.bytes += audioBytes.byteLength;
    } else {
      if (!streams.audio) throw new Error("Không có link audio.");
      audioBytes = await fetchChunked(
        `/media/proxy?url=${encodeURIComponent(streams.audio)}`,
        signal,
        onBytes,
      );
      await cache.put(ytAudioKey(episode.id), new Response(audioBytes, { headers: { "Content-Type": "audio/mp4" } }));
      state.bytes += audioBytes.byteLength;
    }
    put(true);

    // ---- 4. mux, in the browser
    entry.error = "Đang chuẩn bị ghép (lần đầu tải ~32 MB công cụ)…";
    state.phase = "core";
    put(true);

    const video = videoBytes;
    const audio = audioBytes;

    entry.error = "Đang ghép hình và tiếng…";
    state.phase = "muxing";
    put(true);

    const mp4 = await muxToMp4(video, audio, audioName, (ratio) => {
      entry.loaded = Math.round(ratio * 100);
      entry.total = 100;
      put();
    });

    await cache.put(
      ytMuxedKey(episode.id),
      new Response(mp4, { headers: { "Content-Type": "video/mp4" } }),
    );

    // The separate tracks have served their purpose; keeping them would double
    // the footprint of an already-large pack. `video.ts` is dropped too — a
    // resume would re-fetch from YouTube rather than trust a stale token.
    for (const key of [ytVideoKey(episode.id), ytAudioKey(episode.id)]) {
      await cache.delete(key).catch(() => undefined);
    }

    entry.size = entry.bytes = state.bytes + mp4.byteLength;
    entry.loaded = entry.total = 100;
    entry.error = null;
    entry.status = "done";
    put(true);
  } catch (err) {
    if (isAbort(err)) {
      // Cancelled, not failed: whatever was fetched stays in the cache, so the
      // next attempt reuses it instead of starting over.
      entry.status = "partial";
      entry.error = null;
      entry.updatedAt = Date.now();
      useDownloads.getState().put({ ...entry });
      return;
    }
    // ffmpeg.wasm rejects with a bare string rather than an Error, so a plain
    // `err.message` would report nothing useful.
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error("yt download failed:", err);
    fail(detail || "Không tải được video này.");
  }
}

/** True when the episode already has a muxed offline copy. */
export async function hasYtPack(episodeId: number): Promise<boolean> {
  if (!("caches" in window)) return false;
  try {
    const cache = await caches.open(OFFLINE_CACHE);
    return !!(await cache.match(ytMuxedKey(episodeId)));
  } catch {
    return false;
  }
}