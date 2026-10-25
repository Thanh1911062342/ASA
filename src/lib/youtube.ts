/**
 * YouTube IFrame Player API, wrapped so the rest of the app can drive an
 * embedded video the same way it drives `<video>`.
 *
 * Why the API and not a plain `<iframe>`: a bare iframe is a sealed box — there
 * is no way to seek it, pause it, or read its clock from the parent page, which
 * would break the whole point of this app (click a subtitle line, jump to it).
 * The API is the supported postMessage channel that makes those calls work.
 *
 * Verified against the real player before this was written:
 *   new YT.Player(...) → onReady → seekTo(300, true) → getCurrentTime() ≈ 302
 *
 * Two conditions that cost an afternoon to find, both load-bearing:
 *
 *  1. The page must be served over http/https. Loading the API from an
 *     `about:blank` document (a test harness, a `setContent` call) fails with
 *     `153 REFERER_NOT_ALLOWED` — the player has no origin to check against.
 *     In this app the origin is always real, so this only bites in tests.
 *  2. The video must allow embedding. An uploader can disable it, and the
 *     failure mode is an error card inside the iframe, so `playable_in_embed`
 *     is checked server-side (`services/resolve.py`) before this is offered.
 */

/** Only what we need from the API's shape; it is loaded as a global script. */
interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  setPlaybackRate(rate: number): void;
  getPlaybackRate(): number;
  mute(): void;
  unMute(): void;
  setVolume(volume: number): void;
  getVolume(): number;
  destroy(): void;
}

interface YTNamespace {
  Player: new (
    el: HTMLElement | string,
    opts: {
      videoId: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: () => void;
        onStateChange?: (e: { data: number }) => void;
        onError?: (e: { data: number }) => void;
      };
    },
  ) => YTPlayer;
  PlayerState: { PLAYING: number; PAUSED: number; ENDED: number; BUFFERING: number };
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const API_SRC = "https://www.youtube.com/iframe_api";

/** One shared promise: the script is global, so it must only be added once. */
let apiPromise: Promise<YTNamespace> | null = null;

export function loadYouTubeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;

  apiPromise = new Promise<YTNamespace>((resolve, reject) => {
    // The API calls this global by name when it is ready — there is no event to
    // subscribe to instead, so it has to be assigned before the script loads.
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (window.YT?.Player) resolve(window.YT);
      else reject(new Error("YouTube API loaded but YT.Player is missing"));
    };

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${API_SRC}"]`);
    if (existing) return; // another mount already started the load
    const script = document.createElement("script");
    script.src = API_SRC;
    script.async = true;
    script.onerror = () => reject(new Error("Không tải được YouTube IFrame API"));
    document.head.appendChild(script);
  });

  return apiPromise;
}

/**
 * Pull the video id out of anything a person might paste: a watch URL, a
 * youtu.be short link, an /embed/ link, a Shorts link, or the bare id.
 * Returns null when it is not a YouTube URL at all.
 */
export function youtubeId(url: string): string | null {
  const trimmed = url.trim();
  // A bare 11-character id.
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\.|^m\./, "");
  if (host === "youtu.be") return parsed.pathname.slice(1).split("/")[0] || null;
  if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
  if (parsed.searchParams.get("v")) return parsed.searchParams.get("v");
  const parts = parsed.pathname.split("/").filter(Boolean);
  // /embed/<id>, /shorts/<id>, /live/<id>, /v/<id>
  if (parts.length >= 2 && ["embed", "shorts", "live", "v"].includes(parts[0])) return parts[1];
  return null;
}

export interface EmbedHandle {
  play(): void;
  pause(): void;
  seekTo(seconds: number): void;
  setRate(rate: number): void;
  setVolume(volume: number): void;
  /** Live clock. The API only advances on our own polling, so callers poll. */
  currentTime(): number;
  duration(): number;
  isPaused(): boolean;
  destroy(): void;
}

export interface EmbedCallbacks {
  onReady?: (duration: number) => void;
  /** Fires on play/pause/seek/end so the parent can mirror its own UI state. */
  onStateChange?: (state: "playing" | "paused" | "ended" | "buffering") => void;
  onError?: (message: string) => void;
}

/** Player error codes → something a learner can act on. */
const ERROR_TEXT: Record<number, string> = {
  2: "Link YouTube không hợp lệ.",
  5: "Trình duyệt không phát được video này (HTML5).",
  100: "Video không tồn tại hoặc đã bị xoá.",
  101: "Chủ video không cho phép nhúng. Hãy tải về máy thay vì nhúng.",
  150: "Chủ video không cho phép nhúng. Hãy tải về máy thay vì nhúng.",
};

export function createEmbed(
  host: HTMLElement,
  videoId: string,
  cb: EmbedCallbacks,
): { ready: Promise<EmbedHandle>; destroy: () => void } {
  let player: YTPlayer | null = null;
  let destroyed = false;
  let state: YTNamespace["PlayerState"] | null = null;

  // The API replaces the element it is given with its own iframe, so it needs a
  // throwaway child rather than the container React is managing.
  const mount = document.createElement("div");
  host.appendChild(mount);

  const ready = loadYouTubeApi().then(
    (YT) =>
      new Promise<EmbedHandle>((resolve) => {
        if (destroyed) {
          resolve(noopHandle());
          return;
        }
        state = YT.PlayerState;
        // Assigned by the constructor below, then read by onReady. Held in a
        // local so the "destroyed before ready" path can tear it down.
        let instance: YTPlayer | null = null;
        const created = new YT.Player(mount, {
          videoId,
          playerVars: {
            // `origin` is what the player validates the embedding page against;
            // omitting it is what produces error 153 in a bare document.
            origin: window.location.origin,
            playsinline: 1,
            rel: 0,
            modestbranding: 1,
            // Captions are rendered by this app from its own subtitle data, so
            // YouTube's own track would sit on top of ours.
            cc_load_policy: 0,
          },
          events: {
            onReady: () => {
              if (destroyed) {
                // Unmounted while the player was still booting: tear it down
                // and hand back an inert handle so nobody calls into it.
                created.destroy?.();
                resolve(noopHandle());
                return;
              }
              player = created;
              cb.onReady?.(created.getDuration());
              resolve(makeHandle(created));
            },
            onStateChange: (e) => {
              if (!state) return;
              const map: Record<number, "playing" | "paused" | "ended" | "buffering"> = {
                [state.PLAYING]: "playing",
                [state.PAUSED]: "paused",
                [state.ENDED]: "ended",
                [state.BUFFERING]: "buffering",
              };
              const mapped = map[e.data];
              if (mapped) cb.onStateChange?.(mapped);
            },
            onError: (e) => cb.onError?.(ERROR_TEXT[e.data] ?? `Lỗi phát YouTube (${e.data}).`),
          },
        });
        instance = created;
        // `onReady` may never fire if the element is detached before boot; the
        // promise below is resolved by onReady, so a destroyed mount would hang
        // forever without this.
        if (destroyed && instance) {
          instance.destroy?.();
          resolve(noopHandle());
        }
      }),
  );

  const destroy = () => {
    destroyed = true;
    try {
      player?.destroy();
    } catch {
      /* the iframe may already be gone */
    }
    player = null;
    mount.remove();
  };

  return { ready, destroy };
}

function noopHandle(): EmbedHandle {
  return {
    play: () => undefined,
    pause: () => undefined,
    seekTo: () => undefined,
    setRate: () => undefined,
    setVolume: () => undefined,
    currentTime: () => 0,
    duration: () => 0,
    isPaused: () => true,
    destroy: () => undefined,
  };
}

function makeHandle(p: YTPlayer): EmbedHandle {
  return {
    play: () => p.playVideo(),
    pause: () => p.pauseVideo(),
    // `allowSeekAhead: true` is required — with it false the player only moves
    // within what it has already buffered, which reads as "seek did nothing".
    seekTo: (seconds) => p.seekTo(Math.max(0, seconds), true),
    setRate: (rate) => p.setPlaybackRate(rate),
    setVolume: (volume) => {
      if (volume <= 0) p.mute();
      else {
        p.unMute();
        p.setVolume(Math.round(volume * 100));
      }
    },
    currentTime: () => p.getCurrentTime() ?? 0,
    duration: () => p.getDuration() ?? 0,
    isPaused: () => p.getPlayerState() !== 1,
    destroy: () => p.destroy(),
  };
}