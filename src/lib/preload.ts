/**
 * Browser-side segment preload, so playback of a remote HLS episode starts from
 * Cache Storage instead of from a CDN that 403s under burst.
 *
 * The chain, verified end to end: `fetch("/media/proxy?url=<seg>")` → backend
 * responds `X-Media-Kind: segment` → `sw.js` stores a clone in `nv-media-v1` →
 * hls.js later XHRs the *same* URL → the Service Worker answers from cache. The
 * backend writes its own `proxy_cache` on the way, so even before the SW
 * controls the page hls.js's request is a server-side cache hit. Two layers,
 * and neither is load-bearing on its own.
 *
 * The browser can never fetch the CDN directly — megavid sends
 * `access-control-allow-origin: https://megavid.buzz` and its `OPTIONS`
 * preflight 404s — so every byte here goes through the same-origin proxy.
 */

export type PreloadPhase =
  | "manifest"
  | "gating"
  | "running"
  | "ready"
  | "skipped"
  | "error";

export interface PreloadState {
  /** `manifest` while parsing, `gating` until `gateSeconds` are local, then
   * `running`; `ready` when the rest is cached or the gate was opened by hand;
   * `skipped` when preloading isn't possible; `error` when upstream gave up. */
  phase: PreloadPhase;
  loadedSeconds: number;
  gateSeconds: number;
  totalSeconds: number;
  /** segments finished */
  loaded: number;
  /** segments in the playlist */
  total: number;
  bytes: number;
  /** some segments were dropped after retries — playback may hiccup there */
  degraded: boolean;
}

export interface PreloadOptions {
  gateSeconds: number;
  workers: number;
  /** contiguous regions of the episode pulled in parallel once the gate opens */
  regions: number;
  /** false = stop after the gate (mobile: don't burn ~95 MB of cellular data) */
  fullAfterGate: boolean;
  /** set by the player while hls.js is fetching, so preload stops competing */
  yieldRef: { current: boolean };
  onState: (state: PreloadState) => void;
}

export interface PreloadHandle {
  start: () => void;
  destroy: () => void;
}

/** HTTP/1.1 gives 6 connections per host, and in dev every request funnels
 * through the Vite proxy to 127.0.0.1:8010 — going past 6 only queues. */
export const PRELOAD_WORKERS = 6;
export const PRELOAD_REGIONS = 4;
export const PRELOAD_GATE_SECONDS = 90;

/** Highest variant worth pulling; an episode is ~95 MB at 484 kbps. */
const MAX_BANDWIDTH = 1_500_000;
/** Consecutive failures after which preloading gives up on the episode. */
const MAX_STREAK = 5;
const RETRY_DELAY_MS = 800;
const YIELD_POLL_MS = 150;
/** `onState` throttle — ~4/s reads as smooth and keeps React re-renders sane. */
const EMIT_MS = 250;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isAbort = (err: unknown) => (err as Error)?.name === "AbortError";

/** Exported for lib/download.ts, which parses the same playlists. */
export interface Item {
  url: string;
  dur: number;
}

export interface Playlist {
  variants: string[];
  segments: Item[];
}

const EXTINF_RE = /^#EXTINF:\s*(-?[\d.]+)/;
const STREAM_INF_RE = /^#EXT-X-STREAM-INF:(.*)$/;
const BANDWIDTH_RE = /BANDWIDTH=(\d+)/;

/** `new URL(line, base)` needs an *absolute* base, and the proxy link the
 * player holds is root-relative (`/media/proxy?url=…`). Resolve against the
 * document first — a relative base makes every URI line throw, which parses as
 * "playlist with no segments" and silently skips preloading.
 * Exported because lib/download.ts resolves the same root-relative proxy links. */
export function toAbsolute(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    /* relative — try with a document base below */
  }
  try {
    return new URL(url, globalThis.location?.origin).href;
  } catch {
    return url;
  }
}

/**
 * Parse an M3U8. URIs in a proxied playlist were rewritten by the backend to
 * `/media/proxy?url=…`, which is *relative*, so resolve against `baseUrl`.
 * A playlist is either a master (variants) or a media playlist (segments);
 * the flag below keeps a URI line from landing in both.
 */
export function parsePlaylist(body: string, baseUrl: string): Playlist {
  const base = toAbsolute(baseUrl);
  const variants: { bw: number; url: string }[] = [];
  const segments: Item[] = [];
  let pending: number | null = null;
  let pendingBw: number | null = null;

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const inf = EXTINF_RE.exec(line);
      if (inf) {
        const dur = Number(inf[1]);
        pending = Number.isFinite(dur) && dur > 0 ? dur : 0;
        continue;
      }
      const stream = STREAM_INF_RE.exec(line);
      if (stream) {
        const bw = BANDWIDTH_RE.exec(stream[1]);
        pendingBw = bw ? Number(bw[1]) : 0;
      }
      continue;
    }
    let url: string;
    try {
      url = new URL(line, base).href;
    } catch {
      pending = null;
      pendingBw = null;
      continue;
    }
    if (pendingBw !== null) {
      variants.push({ bw: pendingBw, url });
    } else {
      // A URI with no preceding EXTINF still counts: dropping it would leave a
      // hole the player stalls in.
      segments.push({ url, dur: pending ?? 0 });
    }
    pending = null;
    pendingBw = null;
  }
  return { variants: pickVariants(variants), segments };
}

/** Highest BANDWIDTH at or under the cap, else the smallest, else null. */
function pickVariants(variants: { bw: number; url: string }[]): string[] {
  if (!variants.length) return [];
  const eligible = variants.filter((v) => v.bw <= MAX_BANDWIDTH);
  const pool = eligible.length ? eligible : variants;
  const best = eligible.length
    ? pool.reduce((a, b) => (b.bw > a.bw ? b : a))
    : pool.reduce((a, b) => (b.bw < a.bw ? b : a));
  return [best.url];
}

/**
 * Element `k` of each of `regions` contiguous blocks, then `k+1` of each, … so
 * that at any moment several different parts of the episode are in flight. That
 * is what makes a subtitle click at minute 18 land on cached data.
 */
export function interleave(indices: number[], regions: number): number[] {
  const n = Math.max(1, Math.min(regions, indices.length));
  const size = Math.ceil(indices.length / n);
  const out: number[] = [];
  for (let offset = 0; offset < size; offset += 1) {
    for (let block = 0; block < n; block += 1) {
      const at = block * size + offset;
      if (at < indices.length) out.push(indices[at]);
    }
  }
  return out;
}

export function createPreload(masterUrl: string, opts: PreloadOptions): PreloadHandle {
  const controller = new AbortController();
  let destroyed = false;
  let started = false;

  const state: PreloadState = {
    phase: "manifest",
    loadedSeconds: 0,
    gateSeconds: opts.gateSeconds,
    totalSeconds: 0,
    loaded: 0,
    total: 0,
    bytes: 0,
    degraded: false,
  };

  let lastEmit = 0;
  const emit = (force = false) => {
    if (destroyed) return;
    const now = performance.now();
    if (!force && now - lastEmit < EMIT_MS) return;
    lastEmit = now;
    // a copy: React would otherwise watch one object mutate in place
    opts.onState({ ...state });
  };

  const finish = (phase: PreloadPhase) => {
    state.phase = phase;
    emit(true);
  };

  /** One segment, with a single retry on 403/429. False = could not fetch. */
  async function fetchOne(item: Item): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (destroyed) return false;
      // hls.js owns the 6 connections while it is actively loading a fragment.
      while (opts.yieldRef.current) {
        if (destroyed) return false;
        await sleep(YIELD_POLL_MS);
      }
      try {
        const res = await fetch(item.url, { signal: controller.signal });
        if (!res.ok) {
          if ((res.status === 403 || res.status === 429) && attempt === 0) {
            await sleep(RETRY_DELAY_MS);
            continue;
          }
          return false;
        }
        // The body must be consumed or the response stays open. `arrayBuffer()`
        // is safer than `res.body.cancel()`: the SW already split the stream
        // with `res.clone()` for its `cache.put`.
        const buf = await res.arrayBuffer();
        state.bytes += buf.byteLength;
        return true;
      } catch (err) {
        if (isAbort(err)) return false;
        if (attempt === 0) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        return false;
      }
    }
    return false;
  }

  /** `null` = network/parse failure, `"byterange"` = unsafe to preload,
   * otherwise the segment list (empty when the playlist held nothing usable). */
  async function segmentsOf(url: string): Promise<Item[] | "byterange" | null> {
    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal });
    } catch (err) {
      if (isAbort(err)) return [];
      return null;
    }
    if (!res.ok) return null;
    let body: string;
    try {
      body = await res.text();
    } catch (err) {
      if (isAbort(err)) return [];
      return null;
    }
    // Each "segment" of a byterange playlist is a slice of one bigger file, so
    // fetching whole URIs would download the episode N times and cache N
    // identical blobs. Better to not preload at all than to make it worse.
    if (isByterangePlaylist(body)) return "byterange";
    let parsed: Playlist;
    try {
      parsed = parsePlaylist(body, url);
    } catch (err) {
      if (isAbort(err)) return [];
      return null;
    }
    if (parsed.segments.length) return parsed.segments;
    const variant = parsed.variants[0];
    if (!variant) return [];
    return segmentsOf(variant);
  }

  async function run(): Promise<void> {
    const parsed = await segmentsOf(masterUrl);
    if (destroyed) return;
    if (parsed === null) return finish("error");
    if (parsed === "byterange" || !parsed.length) return finish("skipped");
    // Re-bound as a plain `Item[]`: the closures below (`advance`, `drain`) run
    // later, so TypeScript would not carry the narrowing of `parsed` into them.
    const segments: Item[] = parsed;
    // `#EXT-X-KEY` needs no handling: its URI was rewritten too and hls.js
    // fetches the key itself.

    state.total = segments.length;
    state.totalSeconds = segments.reduce((sum, s) => sum + s.dur, 0);
    state.phase = "gating";
    emit(true);

    const done: boolean[] = new Array(segments.length).fill(false);
    let frontier = 0;
    let streak = 0;
    let gaveUp = false;

    const advance = () => {
      // Seconds only count from the front: a cached segment at minute 18 does
      // nothing for the first 90.
      while (frontier < segments.length && done[frontier]) {
        state.loadedSeconds += segments[frontier].dur;
        frontier += 1;
      }
    };

    const workerCount = Math.max(1, Math.min(opts.workers, segments.length));

    async function drain(queue: number[], next: () => number | undefined) {
      const take = async (): Promise<void> => {
        for (;;) {
          if (destroyed || gaveUp) return;
          const index = queue.length ? queue.shift()! : next();
          if (index === undefined) return;
          if (done[index]) continue;
          const ok = await fetchOne(segments[index]);
          done[index] = true;
          if (ok) {
            streak = 0;
            state.loaded += 1;
          } else {
            streak += 1;
            state.degraded = true;
          }
          advance();
          emit();
          if (streak >= MAX_STREAK) {
            // Upstream is refusing everything. Preloading must never be the
            // reason a video can't play, so stop and let hls.js try on its own.
            gaveUp = true;
            return;
          }
        }
      };
      await Promise.all(Array.from({ length: workerCount }, take));
    }

    // ---- phase 1: strictly from the front, `workers` sharing one cursor.
    // The first 90 seconds have to arrive first; round-robining regions from
    // the start would advance the whole episode evenly and open the gate late.
    let cursor = 0;
    await drain([], () => {
      if (state.loadedSeconds >= opts.gateSeconds) return undefined;
      const at = cursor;
      cursor += 1;
      return at < segments.length ? at : undefined;
    });
    if (destroyed) return;

    if (gaveUp) return finish("error");
    if (frontier >= segments.length) return finish("ready");
    if (!opts.fullAfterGate) return finish("ready");

    // ---- phase 2: the rest, as interleaved contiguous regions
    state.phase = "running";
    emit(true);
    const remaining: number[] = [];
    for (let i = 0; i < segments.length; i += 1) if (!done[i]) remaining.push(i);
    await drain(interleave(remaining, opts.regions), () => undefined);

    if (destroyed) return;
    finish(gaveUp ? "error" : "ready");
  }

  return {
    start: () => {
      if (started || destroyed) return;
      started = true;
      void run().catch((err) => {
        if (isAbort(err) || destroyed) return;
        finish("error");
      });
    },
    destroy: () => {
      destroyed = true;
      controller.abort();
    },
  };
}

/** Byterange playlists are unusable here: each "segment" is a byte range of one
 * bigger file, so fetching whole URIs would download the episode N times and
 * cache N identical blobs. Detected on the raw body before any of that. */
export function isByterangePlaylist(body: string): boolean {
  return body.includes("#EXT-X-BYTERANGE");
}
