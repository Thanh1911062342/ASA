import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { Episode, Segment, SeriesDetail, SubMode } from "../types";
import { fmtMs } from "../lib/utils";

type Tab = "dialogue" | "analysis" | "episodes";

interface SidePanelProps {
  segments: Segment[];
  activeIdx: number;
  subMode: SubMode;
  episodes: Episode[];
  series: SeriesDetail | null;
  currentEpisodeId: number;
  onReplay: (ms: number) => void;
  onPick: (ms: number) => void;
  onSeekTo: (ms: number) => void;
}

/**
 * Right column: a single panel with three tabs —
 * Hội thoại (subtitle list) · Phân tích (per-line analysis) · Tập (episodes).
 */
export default function SidePanel({
  segments,
  activeIdx,
  subMode,
  episodes,
  series,
  currentEpisodeId,
  onReplay,
  onPick,
  onSeekTo,
}: SidePanelProps) {
  const [tab, setTab] = useState<Tab>("dialogue");

  return (
    <aside className="side-panel">
      <div className="tabs">
        <button className={tab === "dialogue" ? "on" : ""} onClick={() => setTab("dialogue")}>
          Hội thoại
        </button>
        <button className={tab === "analysis" ? "on" : ""} onClick={() => setTab("analysis")}>
          Phân tích
        </button>
        <button className={tab === "episodes" ? "on" : ""} onClick={() => setTab("episodes")}>
          Tập ({episodes.length || (series ? series.episode_count : 0)})
        </button>
      </div>

      {tab === "dialogue" && (
        <DialogueList
          segments={segments}
          activeIdx={activeIdx}
          subMode={subMode}
          onReplay={onReplay}
          onPick={onPick}
        />
      )}

      {tab === "analysis" && (
        <AnalysisList segments={segments} activeIdx={activeIdx} onSeekTo={onSeekTo} />
      )}

      {tab === "episodes" && (
        <EpisodeList episodes={episodes} currentEpisodeId={currentEpisodeId} series={series} />
      )}
    </aside>
  );
}

// ------------------------------------------------------------------ dialogue

function DialogueList({
  segments,
  activeIdx,
  subMode,
  onReplay,
  onPick,
}: {
  segments: Segment[];
  activeIdx: number;
  subMode: SubMode;
  onReplay: (ms: number) => void;
  onPick: (ms: number) => void;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: segments.length,
    getScrollElement: () => parentRef.current,
    // Initial guess only — real heights vary with wrapped JP/VI/time lines and
    // come from `measureElement` on each row below. The old fixed 78px was
    // smaller than most rows, and since rows are absolutely positioned with
    // `translateY(row.start)`, every row overlapped the one before it.
    estimateSize: () => 92,
    overscan: 12,
  });

  useEffect(() => {
    if (activeIdx < 0 || !parentRef.current) return;
    virtualizer.scrollToIndex(activeIdx, { align: "center" });
  }, [activeIdx, virtualizer]);

  return (
    <div ref={parentRef} className="panel-body">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((row) => {
          const seg = segments[row.index];
          const isActive = row.index === activeIdx;
          return (
            <div
              key={seg.id}
              // `data-index` + `measureElement` = dynamic row heights: the
              // virtualizer measures each rendered row (ResizeObserver, so
              // rewraps on width changes count too) instead of trusting the
              // estimate — this is what stops the rows from overlapping.
              data-index={row.index}
              ref={virtualizer.measureElement}
              className={`sub-row${isActive ? " active" : ""}`}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${row.start}px)`,
              }}
              onClick={() => onPick(seg.start_ms)}
            >
              <span className="idx">{seg.idx}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                {subMode !== "vi" && <div className="jp-line jp">{seg.text_jp}</div>}
                {subMode !== "jp" &&
                  (seg.text_vi ? (
                    <div className="vi-line">{seg.text_vi}</div>
                  ) : (
                    <div className="vi-line faint" style={{ fontStyle: "italic" }}>
                      chưa dịch
                    </div>
                  ))}
                <span className="faint" style={{ fontSize: 11 }}>
                  {fmtMs(seg.start_ms)} → {fmtMs(seg.end_ms)}
                </span>
              </div>
              <button
                className="replay"
                title="Nghe lại đoạn này"
                onClick={(e) => {
                  e.stopPropagation();
                  onReplay(seg.start_ms);
                }}
              >
                ↺
              </button>
            </div>
          );
        })}
        {segments.length === 0 && (
          <div className="empty" style={{ position: "absolute", inset: 0 }}>
            Tập này chưa có phụ đề.
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ analysis

/**
 * Per-line breakdown. Vocabulary/grammar extraction is a phase-2 feature, so
 * this currently shows the current line plus its word-level placeholders and
 * links back to the video; the layout is what matters here.
 */
function AnalysisList({
  segments,
  activeIdx,
  onSeekTo,
}: {
  segments: Segment[];
  activeIdx: number;
  onSeekTo: (ms: number) => void;
}) {
  const current = activeIdx >= 0 ? segments[activeIdx] : null;
  if (!current) {
    return <div className="panel-body empty">Chưa có câu nào đang chiếu.</div>;
  }
  return (
    <div className="panel-body" style={{ padding: 14 }}>
      <div className="analysis-line">
        <div className="jp-line jp" style={{ fontSize: 22, fontWeight: 600 }}>
          {current.text_jp}
        </div>
        {current.text_vi && (
          <div className="vi-line" style={{ marginTop: 8, fontSize: 15 }}>
            {current.text_vi}
          </div>
        )}
        <button
          className="btn btn-sm"
          style={{ marginTop: 12 }}
          onClick={() => onSeekTo(current.start_ms)}
        >
          ↺ Nghe lại câu này
        </button>
      </div>
      <div className="analysis-note">
        Phân tích từ vựng &amp; ngữ pháp từng câu sẽ được bổ sung ở giai đoạn sau
        (cột <code>furigana</code> / <code>grammar</code> đã chừa sẵn trong DB).
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ episodes

function EpisodeList({
  episodes,
  currentEpisodeId,
  series,
}: {
  episodes: Episode[];
  currentEpisodeId: number;
  series: SeriesDetail | null;
}) {
  if (episodes.length === 0) {
    return <div className="panel-body empty">Chưa có tập nào.</div>;
  }
  return (
    <div className="panel-body">
      {series && (
        <div className="panel-section-title">{series.title}</div>
      )}
      <div className="ep-list">
        {episodes.map((ep) => (
          <a
            key={ep.id}
            href={`/watch/${ep.id}`}
            className={`ep-item${ep.id === currentEpisodeId ? " current" : ""}`}
          >
            <span className="ep-num">{String(ep.number).padStart(2, "0")}</span>
            {ep.thumbnail ? (
              <img className="ep-thumb" src={ep.thumbnail} alt="" />
            ) : (
              <div className="ep-thumb" />
            )}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                Tập {ep.number}
                {ep.title ? ` · ${ep.title}` : ""}
              </div>
              <div className="faint" style={{ fontSize: 11 }}>
                {ep.segment_count} câu
              </div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}