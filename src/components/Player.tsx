import Hls from "hls.js";
import type { HlsConfig } from "hls.js";
import { useEffect, useRef, useState } from "react";
import {
  hasPack,
  OFFLINE_CACHE,
  packPlaylist,
  packVideo,
} from "../lib/download";
import {
  createPreload,
  PRELOAD_GATE_SECONDS,
  PRELOAD_REGIONS,
  PRELOAD_WORKERS,
} from "../lib/preload";
import { isMobile } from "../lib/utils";
import { useDownloads } from "../stores";
import type { Episode } from "../types";

/**
 * Tuned for long-form VOD behind a slow, tokenised proxy — not for live.
 *
 * The defaults are what made far seeks hang: a stalled segment was retried for
 * 20s × 6 before giving up, an unbounded back buffer kept growing over a
 * 20-minute episode, and a 0.1s buffer hole after a seek counted as "no media".
 */
const HLS_CONFIG: Partial<HlsConfig> = {
  enableWorker: true,
  lowLatencyMode: false,
  // Flush what was already watched: memory stays flat across a full episode.
  backBufferLength: 90,
  // Buffer ahead: 120s normal, up to 300s max to keep playback smooth without stalls.
  maxBufferLength: 120,
  maxMaxBufferLength: 300,
  // A small gap left by a seek should be stepped over, not stalled on forever.
  maxBufferHole: 0.5,
  nudgeMaxRetry: 5,
  // Fail fast and retry with paced backoff to avoid tripping CDN rate limits.
  fragLoadingTimeOut: 12000,
  fragLoadingMaxRetry: 6,
  fragLoadingRetryDelay: 1000,
  fragLoadingMaxRetryTimeout: 64000,
  levelLoadingMaxRetry: 4,
  manifestLoadingMaxRetry: 2,
  // Warm the first segment while the manifest is still being parsed.
  startFragPrefetch: true,
};

/** How many times each fatal error class gets a recovery attempt. */
const MAX_RECOVERY = 3;

/** Once the gate opens, keep preloading but let hls.js have the connections. */
const YIELD_RELEASE_MS = 300;

interface PlayerProps {
  episode: Episode;
  onTimeMs: (ms: number) => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onPlayStateChange: (playing: boolean) => void;
  onEnded: () => void;
  /** Reading mode: the subtitle clock advances on its own, video stays paused. */
  freeRun: boolean;
  /** Report the media duration once known. */
  onDuration?: (seconds: number) => void;
}

const PROXY_PREFIX = "/media/proxy?url=";

/** The percent-encoded upstream URL of a proxy link, or null if not one. */
function upstreamOf(url: string): string | null {
  if (!url.startsWith(PROXY_PREFIX)) return null;
  try {
    return decodeURIComponent(url.slice(PROXY_PREFIX.length));
  } catch {
    return null;
  }
}

/**
 * Worth handing to hls.js: an explicit .m3u8 link, or anything behind the
 * proxy — remote sources like megavid's `/vid/...` carry no extension at all.
 */
function looksLikeHls(url: string): boolean {
  return upstreamOf(url) !== null || /\.m3u8(\?|$)/i.test(url);
}

/**
 * Video surface only — subtitles are rendered by the parent below the video.
 *
 * Two source kinds, both played by our own `<video>` so seek/pause/replay all
 * work:
 * - `file`: HTML5 video on our own `/media`.
 * - `hls` : a remote stream URL routed through `/media/proxy`. The backend
 *           relays it (no foreign Origin sent) and rewrites nested playlist
 *           URIs, so hls.js sees same-origin media.
 */
export default function Player({
  episode,
  onTimeMs,
  videoRef,
  onPlayStateChange,
  onEnded,
  freeRun,
  onDuration,
}: PlayerProps) {
  const timeMsRef = useRef(0);

  const netUrl =
    episode.source_type === "hls" ? (episode.proxy_url ?? episode.hls_url) : episode.stream_url;

  // ---- play from the downloaded pack, when there is one on disk
  const entry = useDownloads((s) => s.entries[episode.id]);
  const packDone = entry?.status === "done";
  /** A download in flight for this episode — preload has to stay out of its way. */
  const downloading = entry?.status === "downloading";

  const [packSrc, setPackSrc] = useState<string | null>(null);
  const [packSettled, setPackSettled] = useState(!packDone);

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    setPackSrc(null);
    setPackSettled(!packDone);
    if (!packDone) return;
    void (async () => {
      try {
        // The store is metadata only, and the browser may have evicted the
        // bytes. One `cache.match` is what stops us pointing the player at an
        // offline URL that now answers 504.
        if (!(await hasPack(episode.id))) return;
        if (episode.source_type === "hls") {
          if (alive) setPackSrc(packPlaylist(episode.id));
          return;
        }
        // A cached whole MP4 cannot answer the Range request `<video>` always
        // sends, and synthesising 206s in the worker is deliberately not done.
        // A `blob:` URL never reaches the Service Worker at all and the browser
        // ranges it natively, so seeking keeps working.
        const cache = await caches.open(OFFLINE_CACHE);
        const hit = await cache.match(packVideo(episode.id));
        if (!hit) return;
        objectUrl = URL.createObjectURL(await hit.blob());
        if (alive) setPackSrc(objectUrl);
        else URL.revokeObjectURL(objectUrl);
      } catch {
        /* no pack after all — the network URL below is still an option */
      } finally {
        if (alive) setPackSettled(true);
      }
    })();
    return () => {
      alive = false;
      // Every way out of this effect has to release the blob, or switching
      // episodes leaks a whole episode's worth of memory per switch.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [packDone, episode.id, episode.source_type]);

  const fromPack = packSrc !== null;
  const directUrl = packSrc ?? netUrl;

  // ---- preload gate
  // A `file` episode is our own MP4: `<video>` ranges it directly, nothing to
  // preload, no gate. A proxied HLS episode waits until ~90s is in Cache
  // Storage so playback never has to fight the CDN for the first segments.
  // Keyed by URL rather than a plain boolean: switching episode then re-gates
  // instead of inheriting the previous one's `true` for the render in which
  // `directUrl` has already changed.
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const ready = fromPack || episode.source_type !== "hls" || openedFor === directUrl;
  const yieldRef = useRef(false);
  const onDurationRef = useRef(onDuration);
  onDurationRef.current = onDuration;

  const openGate = () => setOpenedFor(directUrl ?? null);

  /** Nothing to preload from a pack (it is already local), and nothing to
   * preload *while* downloading (that would be a second copy of the same bytes
   * over the same six connections). */
  const skipPreload = fromPack || downloading;

  useEffect(() => {
    // `packDone` is known from the store on the first render, but `packSrc` only
    // lands after the cache probe. Starting a preload in that window would
    // download segments we are about to stop needing.
    if (packDone && !packSettled) return;
    if (skipPreload) {
      openGate();
      return;
    }
    if (episode.source_type !== "hls" || !directUrl || !looksLikeHls(directUrl)) {
      openGate();
      return;
    }
    // No MSE ⇒ hls.js can't run and the browser plays the playlist itself
    // (iOS Safari). Its segment requests never reach our Service Worker, so
    // preloading buys nothing there — don't gate it either.
    //
    // Deliberately *not* keyed on `canPlayType("application/vnd.apple.mpegurl")`:
    // Chrome 155 answers "maybe" to that, and taking the native branch there
    // would hand fetching back to the browser — serial, during playback, which
    // is precisely the pattern the CDN 403s and this gate exists to avoid.
    if (!Hls.isSupported()) {
      openGate();
      return;
    }

    setOpenedFor(null);
    const handle = createPreload(directUrl, {
      gateSeconds: PRELOAD_GATE_SECONDS,
      workers: PRELOAD_WORKERS,
      regions: PRELOAD_REGIONS,
      // On mobile only the gated 90s is worth pulling — the rest is ~95 MB.
      fullAfterGate: !isMobile(),
      yieldRef,
      onState: (s) => {
        if (s.totalSeconds > 0) onDurationRef.current?.(s.totalSeconds);
        // `gating`→`running` means the 90s are local; every other terminal
        // phase also has to open the player, or a dead CDN would make the
        // episode unwatchable.
        if (s.phase !== "manifest" && s.phase !== "gating") setOpenedFor(directUrl);
      },
    });
    handle.start();
    return () => {
      yieldRef.current = false;
      handle.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps - openGate closes over directUrl
  }, [episode.source_type, directUrl, videoRef, skipPreload, packDone, packSettled]);

  // ---- attach hls.js when needed
  useEffect(() => {
    if (!directUrl || !ready) return;
    const video = videoRef.current;
    if (!video) return;

    let hls: Hls | null = null;
    let torn = false;
    // Declared here, not inside the `new Hls(...)` branch, so the cleanup below
    // can clear it: it is what releases `yieldRef` back to preload.
    let releaseTimer = 0;
    // Only reach for `<video src>` when hls.js cannot run at all (no MSE) or
    // the URL isn't HLS. Chrome 155+ plays HLS natively, but natively means
    // without our Service Worker cache, our retry ladder or the preload gate —
    // so as long as MSE is there, hls.js is the path we want. `nativeFallback`
    // below still keeps the native route as a last resort.
    const native = !looksLikeHls(directUrl) || !Hls.isSupported();

    if (native) {
      video.src = directUrl;
    } else {
      hls = new Hls(HLS_CONFIG);
      hls.loadSource(directUrl);
      hls.attachMedia(video);

      let mediaRetries = 0;
      let networkRetries = 0;

      // Native playback is only right when the response really isn't HLS — a
      // dead segment or a stuck decoder must be retried inside hls.js instead
      // of tearing the whole pipeline down (that gave-up-on-seek behaviour was
      // the freeze users saw after a far seek).
      const nativeFallback = () => {
        torn = true;
        hls?.destroy();
        hls = null;
        video.src = directUrl;
        video.load();
      };

      // There are only 6 connections per host. While hls.js is pulling a
      // fragment, preload must not be holding five of them — that is exactly
      // the contention the gate was built to avoid. `FRAG_ERROR` does not exist
      // in hls.js 1.7, so failures clear the flag through `Hls.Events.ERROR`.
      hls.on(Hls.Events.FRAG_LOADING, () => {
        window.clearTimeout(releaseTimer);
        yieldRef.current = true;
      });
      const releaseYield = () => {
        window.clearTimeout(releaseTimer);
        releaseTimer = window.setTimeout(() => {
          yieldRef.current = false;
        }, YIELD_RELEASE_MS);
      };
      hls.on(Hls.Events.FRAG_LOADED, releaseYield);
      hls.on(Hls.Events.FRAG_BUFFERED, releaseYield);

      hls.on(Hls.Events.ERROR, (_event, data) => {
        yieldRef.current = false;
        window.clearTimeout(releaseTimer);
        if (!data.fatal || torn || !hls) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          // Decoder got wedged mid-stream (common right after a long seek):
          // reattach a fresh MediaSource, swapping audio codecs on later tries.
          if (mediaRetries++ >= MAX_RECOVERY) return nativeFallback();
          if (mediaRetries > 1) hls.swapAudioCodec();
          hls.recoverMediaError();
        } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          // A segment/manifest request died — transient proxy hiccup or expired
          // token. Resume loading from where we are instead of giving up.
          if (networkRetries++ >= MAX_RECOVERY) return nativeFallback();
          hls.startLoad(-1);
        } else {
          // MANIFEST_PARSING_ERROR & friends: the URL was never HLS after all
          // (extensionless guesses can be a plain MP4). Native is the real fix.
          nativeFallback();
        }
      });
    }

    const onMeta = () => {
      if (video.duration && Number.isFinite(video.duration)) onDuration?.(video.duration);
    };
    video.addEventListener("loadedmetadata", onMeta);
    return () => {
      torn = true;
      window.clearTimeout(releaseTimer);
      yieldRef.current = false;
      video.removeEventListener("loadedmetadata", onMeta);
      hls?.destroy();
    };
  }, [directUrl, videoRef, onDuration, ready]);

  // ---- interpolate between timeupdate events (only ~4/s, too coarse to
  //      drive subtitle highlighting on its own)
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let raf = 0;
    let base = { at: performance.now(), ms: 0 };

    const onTimeUpdate = () => {
      base = { at: performance.now(), ms: video.currentTime * 1000 };
    };
    const tick = () => {
      if (!video.paused) {
        timeMsRef.current = base.ms + (performance.now() - base.at);
      } else if (freeRun) {
        // Reading mode: the video stays paused but the subtitle clock keeps
        // advancing, so the active line keeps moving.
        timeMsRef.current += 16;
      } else {
        timeMsRef.current = video.currentTime * 1000;
      }
      onTimeMs(timeMsRef.current);
      raf = requestAnimationFrame(tick);
    };
    video.addEventListener("timeupdate", onTimeUpdate);
    raf = requestAnimationFrame(tick);
    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      cancelAnimationFrame(raf);
    };
  }, [onTimeMs, videoRef, freeRun]);

  return (
    <div className="player-frame">
      <video
        ref={videoRef}
        preload="metadata"
        playsInline
        // Native controls stay hidden: the app's own controls drive playback
        // (pause/seek/speed), which is the whole point of streaming it here.
        controls={false}
        onPlay={() => onPlayStateChange(true)}
        onPause={() => onPlayStateChange(false)}
        onEnded={onEnded}
      />
      {!ready && (
        <div
          // Absolutely positioned inside `.player-frame`, which is already
          // `position: relative`; `.spinner` is reused CSS, so nothing new to
          // style. Spinner only — no label, no numbers.
          //
          // Clicking anywhere opens the gate by hand. Every preload failure
          // path already ends in `phase: "error"` and opens it automatically,
          // so this is the escape hatch for the remaining case: a CDN that
          // hangs instead of answering. A dead source must never leave the
          // episode unwatchable behind a spinner.
          role="button"
          tabIndex={0}
          aria-label="Phát ngay"
          title="Bấm để phát ngay"
          onClick={openGate}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") openGate();
          }}
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            cursor: "pointer",
          }}
        >
          <span className="spinner" style={{ width: 26, height: 26, borderWidth: 3 }} />
        </div>
      )}
    </div>
  );
}
