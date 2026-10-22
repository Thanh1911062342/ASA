import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { Segment, SubMode } from "../types";
import { findSegment, fmtMs } from "../lib/utils";

interface SubtitlePanelProps {
  segments: Segment[];
  activeIdx: number;
  subMode: SubMode;
  onSeek: (ms: number) => void;
  onReplay: (ms: number) => void;
}

/**
 * Virtualized subtitle list. The active row is scrolled into the middle of
 * the panel (only on active-row change, not per frame).
 */
export default function SubtitlePanel({ segments, activeIdx, subMode, onSeek, onReplay }: SubtitlePanelProps) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: segments.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 86,
    overscan: 12,
  });

  useEffect(() => {
    if (activeIdx < 0 || !parentRef.current) return;
    virtualizer.scrollToIndex(activeIdx, { align: "center" });
  }, [activeIdx, virtualizer]);

  return (
    <div className="sub-panel">
      <div className="panel-head">
        <span>Phụ đề · {segments.length} câu</span>
        <span className="faint" style={{ fontSize: 12 }}>
          click để nhảy tới
        </span>
      </div>
      <div ref={parentRef} className="panel-body" style={{ overflow: "auto" }}>
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((row) => {
            const seg = segments[row.index];
            const isActive = row.index === activeIdx;
            return (
              <div
                key={seg.id}
                className={`sub-row${isActive ? " active" : ""}`}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${row.start}px)`,
                }}
                onClick={() => onSeek(seg.start_ms)}
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
        </div>
      </div>
    </div>
  );
}

export function currentRow(segments: Segment[], ms: number): number {
  return findSegment(segments, ms);
}
