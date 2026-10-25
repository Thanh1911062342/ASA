import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { api } from "../../api/client";
import Player from "../../components/Player";
import SidePanel from "../../components/SidePanel";
import {
  cancelDownload,
  isDownloading,
  readPackApi,
  removeDownload,
  startDownload,
  storageEstimate,
} from "../../lib/download";
import { fmtBytes, fmtTime, findSegment, isMobile } from "../../lib/utils";
import { startYtDownload } from "../../lib/ytdownload";
import { useDownloads, useSettings } from "../../stores";
import type { DownloadEntry } from "../../stores";
import type { Episode, Segment, SeriesDetail } from "../../types";

/** Never shrink past this, or a long cue turns into unreadable microtext. */
const SUB_MIN_SCALE = 0.6;

/**
 * Fit the subtitle strip: pick the largest JP/VI font size that keeps every
 * line inside the box, then set it as CSS vars.
 *
 * The strip's height is fixed by the watch grid (the `1fr` row under video +
 * controls), so `clamp(…, vw, …)` can't work — viewport width knows nothing
 * about that height or about how many lines the current cue wraps to, and long
 * JP lines spilled out of the frame. Measuring beats guessing: start at the
 * CSS baseline and step down while the content is still taller than the box.
 */
function fitSubStrip(strip: HTMLElement) {
  const jp = strip.querySelector<HTMLElement>(".jp-line");
  const vi = strip.querySelector<HTMLElement>(".vi-line");

  // Clear the previous fit (vars on the strip, inline sizes left on the
  // children by the probe) so each line's computed size is its CSS baseline.
  strip.style.removeProperty("--sub-jp");
  strip.style.removeProperty("--sub-vi");
  if (jp) jp.style.removeProperty("font-size");
  if (vi) vi.style.removeProperty("font-size");
  if (!jp && !vi) return; // placeholder: nothing to scale

  const px = (el: HTMLElement | null) =>
    el ? parseFloat(getComputedStyle(el).fontSize) || 0 : 0;
  const jpBase = px(jp);
  const viBase = px(vi);

  const cs = getComputedStyle(strip);
  const avail =
    strip.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
  const gap = parseFloat(cs.rowGap) || 0;
  // Sum the real boxes rather than trust scrollHeight: with `justify-content:
  // center` overflowing content spills both ways and scrollHeight undercounts.
  const needed = () => {
    let h = gap * Math.max(0, strip.children.length - 1);
    for (const child of Array.from(strip.children)) h += (child as HTMLElement).offsetHeight;
    return h;
  };

  const apply = (s: number) => {
    if (jp) jp.style.fontSize = `${(jpBase * s).toFixed(2)}px`;
    if (vi) vi.style.fontSize = `${(viBase * s).toFixed(2)}px`;
  };

  let scale = 1;
  apply(scale);
  while (needed() > avail + 0.5 && scale > SUB_MIN_SCALE) {
    // ~7% per step: a few synchronous layout passes per cue, never visible.
    scale = Math.max(SUB_MIN_SCALE, scale * 0.93);
    apply(scale);
  }

  // Keep the result on the strip as CSS vars — the single source of truth the
  // stylesheet reads, surviving React re-renders of the children.
  strip.style.setProperty("--sub-jp", `${(jpBase * scale).toFixed(2)}px`);
  strip.style.setProperty("--sub-vi", `${(viBase * scale).toFixed(2)}px`);
  if (jp) jp.style.removeProperty("font-size");
  if (vi) vi.style.removeProperty("font-size");
}

/**
 * The one download control in the app (PC and mobile share it).
 *
 * Scoped to the Watch page on purpose: no per-episode buttons in the series
 * lists, and no "download the whole series". The store is the source of truth,
 * so the label survives navigation and an F5.
 */
function DownloadButton({ episode }: { episode: Episode }) {
  const entry = useDownloads((s) => s.entries[episode.id]);
  const [confirming, setConfirming] = useState(false);
  const [free, setFree] = useState(0);
  const ytAbort = useRef<AbortController | null>(null);

  // Shown before the first click only: the user decides what to give back to
  // the browser, so the remaining room is worth knowing up front.
  useEffect(() => {
    let alive = true;
    storageEstimate().then(({ usage, quota }) => {
      if (alive && quota > 0) setFree(Math.max(0, quota - usage));
    });
    return () => {
      alive = false;
    };
  }, [entry?.status]);

  const status = entry?.status;

  // An `embed` episode has no single URL the app can fetch: YouTube splits every
  // format into video-only and audio-only tracks and blocks cross-origin reads.
  // The offline path is therefore a different pipeline — fetch both tracks
  // through the proxy, then mux them here in the browser (`lib/ytdownload.ts`).
  if (episode.source_type === "embed" && status !== "done") {
    if (status === "downloading") {
      const label = entry.error ?? "Đang tải…";
      return (
        <button
          className="btn btn-sm"
          onClick={() => ytAbort.current?.abort()}
          title="Bấm để dừng"
        >
          {entry.total === 100 ? `⬇ Ghép ${entry.loaded}%` : `⬇ ${label}`}
        </button>
      );
    }
    return (
      <button
        className="btn btn-sm"
        title="Tải video này về máy: tải hình và tiếng rồi ghép ngay trên máy bạn"
        onClick={() => {
          const controller = new AbortController();
          ytAbort.current = controller;
          void startYtDownload(episode, controller.signal);
        }}
      >
        {status === "partial" ? "↻ Tải tiếp" : "⬇ Tải về máy"}
      </button>
    );
  }

  if (status === "done") {
    return (
      <button
        className={`btn btn-sm${confirming ? " btn-danger" : ""}`}
        title={confirming ? "Xóa tập đã tải khỏi máy" : "Đã tải về máy — bấm để xóa"}
        onClick={() => (confirming ? void removeDownload(episode.id) : setConfirming(true))}
      >
        {confirming ? "🗑 Xóa?" : `✓ Đã tải · ${fmtBytes(entry.bytes)}`}
      </button>
    );
  }

  if (status === "downloading") {
    // A reload aborts every page-side fetch; until the boot downgrade lands,
    // the store can still say "downloading" with no job behind it.
    if (!isDownloading(episode.id)) return <span className="badge">Đang tải…</span>;
    const pct = entry.total > 0 ? Math.round((entry.loaded / entry.total) * 100) : 0;
    return (
      <button className="btn btn-sm" onClick={() => cancelDownload(episode.id)} title="Bấm để dừng">
        ⬇ {pct} %
      </button>
    );
  }

  if (status === "partial" || status === "error") {
    // The bytes already fetched are still on disk, so only the holes get
    // pulled — resume works by probing the cache, not from a saved index list.
    return (
      <button
        className="btn btn-sm btn-primary"
        onClick={() => startDownload(episode)}
        title={free > 0 ? `Còn trống khoảng ${fmtBytes(free)}` : "Tải tiếp phần còn thiếu"}
      >
        ↻ Tải tiếp
      </button>
    );
  }

  return (
    <button
      className="btn btn-sm"
      onClick={() => startDownload(episode)}
      title={free > 0 ? `Còn trống khoảng ${fmtBytes(free)}` : "Tải tập này về máy để xem offline"}
    >
      ⬇ Tải về
    </button>
  );
}

/** Progress and errors for the pack of the episode on screen. */
function DownloadStatusLine({ entry }: { entry: DownloadEntry | undefined }) {
  if (!entry) return null;
  if (entry.status === "downloading") {
    const pct = entry.total > 0 ? (entry.loaded / entry.total) * 100 : 0;
    return (
      <div className="job-bar">
        <span className="faint" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>
          Đang tải offline · {entry.loaded}/{entry.total}
        </span>
        <div className="track">
          <div className="fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="faint" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>
          {fmtBytes(entry.bytes)}
        </span>
      </div>
    );
  }
  if (entry.status === "error" && entry.error) {
    // Never auto-deleted: the message says what to do, the user decides.
    return <div className="notice">⚠ {entry.error}</div>;
  }
  return null;
}

export default function Watch() {
  const { episodeId } = useParams();
  const epId = Number(episodeId);

  const [episode, setEpisode] = useState<Episode | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [series, setSeries] = useState<SeriesDetail | null>(null);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [error, setError] = useState("");
  const [timeMs, setTimeMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [freeRun, setFreeRun] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [mobile, setMobile] = useState(isMobile());
  const [duration, setDuration] = useState<number | null>(null);

  const { subMode, setSubMode, rate, setRate, volume } = useSettings();
  // Above the early returns below: a hook after a conditional `return` changes
  // the hook count between renders and React aborts the whole tree.
  const downloaded = useDownloads((s) => s.entries[epId]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const subStripRef = useRef<HTMLDivElement | null>(null);
  // For `embed` episodes there is no <video> to write `currentTime` to, so the
  // player hands these two back instead. Every seek/play call site below stays
  // identical — only the target changes.
  const embedSeekRef = useRef<((ms: number) => void) | null>(null);
  const embedControlRef = useRef<{ play: () => void; pause: () => void } | null>(null);

  // Every source plays in our own <video> now (no iframe), so the controls are
  // always live. `playable` only gates the "no source yet" notice.
  const playable = episode
    ? !!(episode.proxy_url || episode.hls_url || episode.stream_url || episode.embed_src)
    : false;

  // Load episode + subtitles (+ series with its episode list)
  useEffect(() => {
    if (!epId) return;
    let alive = true;
    setEpisode(null);
    setSegments([]);
    setSeries(null);
    setEpisodes([]);
    setDuration(null);
    setError("");
    Promise.all([api.episode(epId), api.subtitles(epId)])
      .then(([ep, subs]) => {
        if (!alive) return;
        setEpisode(ep);
        setSegments(subs.segments);
        if (ep.series) {
          api
            .seriesDetail(ep.series.slug)
            .then((s) => {
              if (!alive) return;
              setSeries(s);
              setEpisodes(s.episodes);
            })
            .catch(() => undefined);
        }
      })
      .catch(async (e) => {
        if (!alive) return;
        // The API is unreachable, but the episode may still be on disk. A
        // downloaded pack carries its own copies of these three responses
        // (see `grabExtras` in lib/download.ts), so read them directly rather
        // than leaving the page on "Đang tải…" forever. Before this, a backend
        // that was down *or answering 5xx* made a fully downloaded episode
        // unopenable — which defeats the whole point of the feature.
        const [ep, subs] = await Promise.all([
          readPackApi<Episode>(`/api/episodes/${epId}`),
          readPackApi<{ segments: Segment[] }>(`/api/episodes/${epId}/subtitles`),
        ]);
        if (!alive) return;
        if (!ep) return setError(e.message);
        setEpisode(ep);
        setSegments(subs?.segments ?? []);
        if (ep.series?.slug) {
          const s = await readPackApi<SeriesDetail>(`/api/series/${ep.series.slug}`);
          if (alive && s) {
            setSeries(s);
            setEpisodes(s.episodes ?? []);
          }
        }
      });
    return () => {
      alive = false;
    };
  }, [epId]);

  useEffect(() => {
    const onResize = () => setMobile(isMobile());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Deliberately no resume-from-last-position: a reload restarts the episode
  // from 00:00, so nothing needs to be persisted while watching either.

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, [rate, episode]);

  const activeIdx = findSegment(segments, timeMs);

  // Refit the subtitle text whenever the cue, mode, layout or box size changes.
  // Layout effect (pre-paint) so a shrunk cue is never shown overflowing first.
  useLayoutEffect(() => {
    const strip = subStripRef.current;
    if (!strip) return;
    fitSubStrip(strip);
    const ro = new ResizeObserver(() => fitSubStrip(strip));
    ro.observe(strip);
    return () => ro.disconnect();
  }, [activeIdx, subMode, mobile, segments]);

  // ---- playback control. Each helper prefers the iframe handle when the episode
  // is an `embed`; `videoRef` is null there, so without the branch every button
  // on the page would silently do nothing.
  const togglePlay = useCallback(() => {
    const embedCtrl = embedControlRef.current;
    const v = videoRef.current;
    if (v) {
      if (v.paused) v.play().catch(() => undefined);
      else v.pause();
      return;
    }
    if (!embedCtrl) return;
    if (playing) embedCtrl.pause();
    else embedCtrl.play();
  }, [playing]);

  const seekRelative = useCallback(
    (deltaSec: number) => {
      const v = videoRef.current;
      if (v) {
        v.currentTime = Math.max(0, v.currentTime + deltaSec);
        return;
      }
      const embedSeek = embedSeekRef.current;
      if (embedSeek) embedSeek(Math.max(0, timeMs + deltaSec * 1000));
    },
    [timeMs],
  );

  const seekTo = useCallback((ms: number) => {
    const v = videoRef.current;
    if (v) {
      v.currentTime = ms / 1000;
      // Optimistic: the strip should move on click, and the iframe only reports
      // its position on our next poll.
      setTimeMs(ms);
      return;
    }
    embedSeekRef.current?.(ms);
    setTimeMs(ms);
  }, []);

  /** Click a line in the side panel: jump there and resume (re-listen). */
  const replayFrom = useCallback((ms: number) => {
    const v = videoRef.current;
    if (v) {
      v.currentTime = ms / 1000;
      v.play().catch(() => undefined);
      return;
    }
    embedSeekRef.current?.(ms);
    embedControlRef.current?.play();
    setTimeMs(ms);
  }, []);

  /** Pause the video when entering reading mode; leaving it resumes manually. */
  const toggleFreeRun = useCallback(() => {
    const v = videoRef.current;
    if (!freeRun && v && !v.paused) v.pause();
    if (!freeRun && !v) embedControlRef.current?.pause();
    setFreeRun((r) => !r);
  }, [freeRun]);

  if (error) return <div className="page empty">{error}</div>;
  if (!episode) return <div className="page empty">Đang tải…</div>;

  const active = activeIdx >= 0 ? segments[activeIdx] : null;

  const modeToggle = (
    <div className="seg">
      {(
        [
          ["jp_vi", "JP + VI"],
          ["jp", "JP"],
          ["vi", "VI"],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          className={subMode === value ? "on" : ""}
          onClick={() => setSubMode(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );

  const packBadge =
    downloaded?.status === "done" ? <span className="badge badge-ok">Offline</span> : null;

  const player = (
    <Player
      episode={episode}
      onTimeMs={setTimeMs}
      videoRef={videoRef}
      onPlayStateChange={setPlaying}
      onEnded={() => undefined}
      freeRun={freeRun}
      onDuration={setDuration}
      rate={rate}
      volume={volume}
      embedSeekRef={embedSeekRef}
      embedControlRef={embedControlRef}
    />
  );

  // Subtitle strip below the video — plain text, never drawn over the video.
  // Text size is fitted to the box by `fitSubStrip` (see the layout effect).
  const subStrip = (
    <div ref={subStripRef} className={`sub-strip mode-${subMode}`}>
      {active ? (
        <>
          {subMode !== "vi" && <div className="jp-line jp">{active.text_jp}</div>}
          {subMode !== "jp" &&
            (active.text_vi ? (
              <div className="vi-line">{active.text_vi}</div>
            ) : (
              <div className="vi-line faint" style={{ fontStyle: "italic" }}>
                chưa dịch
              </div>
            ))}
        </>
      ) : (
        <div className="placeholder">— chưa có phụ đề ở đoạn này —</div>
      )}
    </div>
  );

  // ---------------------------------------------------------------- mobile
  if (mobile) {
    return (
      <div style={{ paddingBottom: 76 }}>
        <div className="mobile-top">
          <Link to={`/s/${series?.slug ?? ""}`} className="icon-btn" aria-label="Quay lại">
            ←
          </Link>
          <div className="title">
            Tập {episode.number}
            {episode.title ? ` · ${episode.title}` : ""}
          </div>
          {modeToggle}
        </div>

        <div className="mobile-player">{player}</div>

        <div className="mobile-controls">
          <button className="round-btn" onClick={() => seekRelative(-10)}>
            ⏪
          </button>
          <button className="round-btn big" onClick={togglePlay}>
            {playing ? "⏸" : "▶"}
          </button>
          <button className="round-btn" onClick={() => seekRelative(10)}>
            ⏩
          </button>
        </div>

        <div style={{ padding: "0 12px" }}>{subStrip}</div>

        <div style={{ padding: "10px 12px 0" }}>
          <DownloadStatusLine entry={downloaded} />
        </div>

        {!playable && (
          <div className="notice" style={{ margin: "0 12px" }}>
            ⓘ Tập này chưa có nguồn video. Vào admin sửa tập: dán link embed rồi bấm{" "}
            <strong>“Lấy HLS master playlist”</strong>, hoặc upload file MP4.
          </div>
        )}

        <div className="row" style={{ padding: "10px 14px 0" }}>
          <button
            className={`btn btn-sm${freeRun ? " btn-primary" : ""}`}
            onClick={toggleFreeRun}
            style={{ flex: 1 }}
          >
            {freeRun ? "📖 Đang đọc (video dừng)" : "📖 Chế độ đọc"}
          </button>
          <button className="btn btn-sm" style={{ flex: 1 }} onClick={() => setSheetOpen(true)}>
            ☰ Danh sách phụ đề
          </button>
        </div>

        <div className="row" style={{ padding: "8px 14px 0" }}>
          <DownloadButton episode={episode} />
          {packBadge}
        </div>

        {episodes.length > 0 && (
          <>
            <div className="spread" style={{ padding: "14px 14px 0" }}>
              <strong style={{ fontSize: 14 }}>{series?.title}</strong>
              <span className="faint" style={{ fontSize: 12 }}>
                {episodes.length} tập
              </span>
            </div>
            <div className="ep-strip">
              {episodes.map((ep) => (
                <Link
                  key={ep.id}
                  to={`/watch/${ep.id}`}
                  className={`ep-chip${ep.id === episode.id ? " current" : ""}`}
                >
                  <div className="cover">
                    {ep.thumbnail ? <img src={ep.thumbnail} alt="" /> : null}
                  </div>
                  <div className="label">Tập {ep.number}</div>
                </Link>
              ))}
            </div>
          </>
        )}

        <div className="bottom-nav">
          <Link to="/" className="on">
            ⌂<span>Trang chủ</span>
          </Link>
          <Link to={`/s/${series?.slug ?? ""}`}>
            📚<span>Tập</span>
          </Link>
          <a href="/admin">
            ⚙<span>Admin</span>
          </a>
        </div>

        {sheetOpen && (
          <>
            <div className="sheet-backdrop" onClick={() => setSheetOpen(false)} />
            <div className="sheet">
              <div className="sheet-head">
                <strong>Hội thoại · {segments.length} câu</strong>
                <button className="icon-btn" onClick={() => setSheetOpen(false)}>
                  ✕
                </button>
              </div>
              <div style={{ overflow: "auto", flex: 1 }}>
                {segments.map((seg, i) => (
                  <div
                    key={seg.id}
                    className={`sub-row${i === activeIdx ? " active" : ""}`}
                    onClick={() => {
                      replayFrom(seg.start_ms);
                      setSheetOpen(false);
                    }}
                  >
                    <span className="idx">{seg.idx}</span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      {subMode !== "vi" && <div className="jp-line jp">{seg.text_jp}</div>}
                      {subMode !== "jp" && (
                        <div className="vi-line">{seg.text_vi ?? "chưa dịch"}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------- desktop
  return (
    <div className="watch-layout">
      <div className="player-col">
        {player}

        <div className="controls">
          <button className="icon-btn play" onClick={togglePlay}>
            {playing ? "⏸" : "▶"}
          </button>
          <button className="icon-btn" onClick={() => seekRelative(-10)} title="-10 giây">
            ⏪
          </button>
          <button className="icon-btn" onClick={() => seekRelative(10)} title="+10 giây">
            ⏩
          </button>
          <span className="time">{fmtTime(timeMs / 1000)}</span>
          <input
            className="seek"
            type="range"
            min={0}
            max={Math.max(1, duration ?? episode.duration ?? 0)}
            step={0.1}
            value={Math.min(timeMs / 1000, duration ?? episode.duration ?? 0)}
            onChange={(e) => seekTo(Number(e.target.value) * 1000)}
          />
          <span className="time">
            {duration ?? episode.duration ? fmtTime(duration ?? episode.duration ?? 0) : "—"}
          </span>
          {modeToggle}
          <button
            className={`btn btn-sm${freeRun ? " btn-primary" : ""}`}
            onClick={toggleFreeRun}
            title="Chế độ đọc: video dừng, phụ đề tự chạy tiếp"
          >
            📖
          </button>
          <div className="seg">
            {[0.75, 1, 1.25].map((r) => (
              <button key={r} className={rate === r ? "on" : ""} onClick={() => setRate(r)}>
                {r}×
              </button>
            ))}
          </div>
          <DownloadButton episode={episode} />
          {packBadge}
        </div>

        <DownloadStatusLine entry={downloaded} />

        {!playable && (
          <div className="notice">
            ⓘ Tập này chưa có nguồn video. Vào admin sửa tập: dán link embed rồi bấm{" "}
            <strong>“Lấy HLS master playlist”</strong>, hoặc upload file MP4.
          </div>
        )}

        {subStrip}
      </div>

      <SidePanel
        segments={segments}
        activeIdx={activeIdx}
        subMode={subMode}
        episodes={episodes}
        series={series}
        currentEpisodeId={episode.id}
        onReplay={replayFrom}
        onPick={replayFrom}
        onSeekTo={seekTo}
      />
    </div>
  );
}