import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { adminApi } from "../../api/client";
import type { AiJob, Episode, Segment } from "../../types";
import { fmtMs } from "../../lib/utils";

const msToClock = (ms: number) => `${fmtMs(ms)}.${String(ms % 1000).padStart(3, "0")}`;

/**
 * The core admin screen: upload SRT, then per-segment editing with two
 * boxes (JP original / VI translation) + a per-row AI translate button,
 * plus a background job for translating the whole file.
 */
export default function SubtitleEditor() {
  const { episodeId } = useParams();
  const epId = Number(episodeId);

  const [episode, setEpisode] = useState<Episode | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [job, setJob] = useState<AiJob | null>(null);
  const [filter, setFilter] = useState<"all" | "untranslated">("all");
  const [translating, setTranslating] = useState<Record<number, boolean>>({});

  const srtInput = useRef<HTMLInputElement | null>(null);
  const dirty = useRef<Map<number, { text_jp?: string; text_vi?: string }>>(new Map());
  const timers = useRef<Map<number, number>>(new Map());

  const load = useCallback(async () => {
    try {
      const data = await adminApi.segments(epId);
      setEpisode(data.episode);
      setSegments(data.segments);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [epId]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll running job
  useEffect(() => {
    if (!job || ["done", "error", "canceled"].includes(job.status)) return;
    const id = window.setInterval(async () => {
      try {
        const fresh = await adminApi.job(job.id);
        setJob(fresh);
        if (["done", "error", "canceled"].includes(fresh.status)) {
          await load();
          setNotice(
            fresh.status === "done"
              ? `Hoàn tất: ${fresh.done}/${fresh.total} câu đã dịch.`
              : `Job ${fresh.status}${fresh.error ? `: ${fresh.error}` : ""}`,
          );
        }
      } catch {
        /* keep polling; job may have finished between polls */
      }
    }, 2000);
    return () => window.clearInterval(id);
  }, [job, load]);

  const patchLocal = (id: number, field: "text_jp" | "text_vi", value: string) => {
    setSegments((prev) => prev.map((s) => (s.id === id ? { ...s, [field]: value } : s)));
    const entry = dirty.current.get(id) ?? {};
    entry[field] = value;
    dirty.current.set(id, entry);
    // Debounced autosave
    window.clearTimeout(timers.current.get(id));
    timers.current.set(
      id,
      window.setTimeout(() => saveSegment(id), 800),
    );
  };

  const saveSegment = async (id: number) => {
    const changes = dirty.current.get(id);
    if (!changes) return;
    dirty.current.delete(id);
    try {
      const saved = await adminApi.updateSegment(id, changes);
      setSegments((prev) => prev.map((s) => (s.id === id ? saved : s)));
    } catch (e) {
      setError(`Lưu đoạn #${id}: ${(e as Error).message}`);
    }
  };

  const uploadSrt = async (file: File) => {
    setError("");
    setNotice("");
    try {
      const res = await adminApi.uploadSrt(epId, file);
      setNotice(`Đã nhập ${res.imported} câu từ ${file.name}.`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const translateRow = async (id: number) => {
    saveSegment(id);
    setTranslating((prev) => ({ ...prev, [id]: true }));
    try {
      const seg = await adminApi.translateSegment(id);
      setSegments((prev) => prev.map((s) => (s.id === id ? seg : s)));
    } catch (e) {
      setError(`Dịch đoạn: ${(e as Error).message}`);
    } finally {
      setTranslating((prev) => ({ ...prev, [id]: false }));
    }
  };

  const translateAll = async (overwrite = false) => {
    const count = overwrite
      ? segments.length
      : segments.filter((s) => !s.text_vi).length;
    if (count === 0) {
      setNotice("Không còn câu nào chưa dịch.");
      return;
    }
    try {
      const created = await adminApi.translateEpisode(epId, { all: true, overwrite });
      setJob(created);
      setNotice(`Bắt đầu dịch ${count} câu…`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const exportSrt = async (kind: string) => {
    const { content } = await adminApi.exportSrt(epId, kind);
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ep-${epId}.${kind}.srt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const shown = filter === "untranslated" ? segments.filter((s) => !s.text_vi) : segments;
  const untranslated = segments.filter((s) => !s.text_vi).length;

  if (error && !episode) return <div className="empty">{error}</div>;

  return (
    <div>
      <div className="spread">
        <h1>
          Phụ đề {episode ? `— Tập ${episode.number}${episode.title ? `: ${episode.title}` : ""}` : ""}
        </h1>
        <div className="row">
          {episode && (
            <Link className="btn btn-sm" to={`/admin/series/${episode.series_id}/episodes`}>
              ← Tập
            </Link>
          )}
          <button className="btn btn-sm" onClick={() => srtInput.current?.click()}>
            ⬆ Upload SRT
          </button>
          <input
            ref={srtInput}
            type="file"
            accept=".srt"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadSrt(f);
              e.target.value = "";
            }}
          />
          <button className="btn btn-sm" onClick={() => exportSrt("bilingual")}>
            ⬇ Xuất SRT
          </button>
        </div>
      </div>

      <div className="job-bar" style={{ margin: "12px 0" }}>
        <span style={{ fontSize: 13 }} className="muted">
          {segments.length} câu · <strong style={{ color: "var(--accent-2)" }}>{segments.length - untranslated}</strong> đã dịch
        </span>
        <div className="track">
          <div
            className="fill"
            style={{
              width: segments.length
                ? `${((segments.length - untranslated) / segments.length) * 100}%`
                : 0,
            }}
          />
        </div>
        <div className="seg">
          <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>
            Tất cả
          </button>
          <button className={filter === "untranslated" ? "on" : ""} onClick={() => setFilter("untranslated")}>
            Chưa dịch
          </button>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => translateAll(false)} disabled={!!job && !["done", "error", "canceled"].includes(job.status)}>
          ✨ Dịch toàn bộ SRT
        </button>
        {untranslated !== segments.length && (
          <button className="btn btn-sm" onClick={() => confirm("Dịch lại TOÀN BỘ, ghi đè bản dịch hiện có?") && translateAll(true)}>
            Dịch lại tất cả
          </button>
        )}
      </div>

      {job && !["done", "error", "canceled"].includes(job.status) && (
        <div className="job-bar" style={{ margin: "0 0 12px", borderColor: "var(--accent)" }}>
          <span className="spinner" style={{ borderColor: "var(--accent)", borderTopColor: "#fff" }} />
          <span style={{ fontSize: 13 }}>
            Job #{job.id} — {job.done}/{job.total}
          </span>
          <div className="track">
            <div className="fill" style={{ width: job.total ? `${(job.done / job.total) * 100}%` : 0 }} />
          </div>
          <button className="btn btn-sm btn-danger" onClick={() => adminApi.cancelJob(job.id)}>
            Hủy
          </button>
        </div>
      )}

      {error && (
        <div style={{ color: "#ff9aa6", marginBottom: 10, fontSize: 13 }}>{error}</div>
      )}
      {notice && (
        <div style={{ color: "#7ee2b8", marginBottom: 10, fontSize: 13 }}>{notice}</div>
      )}

      <div className="seg-editor">
        {shown.map((seg) => (
          <div key={seg.id} className={`seg-row${seg.text_vi ? " filled" : ""}`}>
            <div className="seg-time">
              #{seg.idx}
              <br />
              {msToClock(seg.start_ms)}
              <br />↓ {msToClock(seg.end_ms)}
            </div>
            <textarea
              className="textarea jp"
              defaultValue={seg.text_jp}
              key={`jp-${seg.id}-${seg.text_jp}`}
              onChange={(e) => patchLocal(seg.id, "text_jp", e.target.value)}
            />
            <textarea
              className="textarea"
              placeholder="Bản dịch tiếng Việt (trống = chưa dịch)"
              defaultValue={seg.text_vi ?? ""}
              key={`vi-${seg.id}-${seg.text_vi}`}
              onChange={(e) => patchLocal(seg.id, "text_vi", e.target.value)}
            />
            <div className="seg-actions">
              <button
                className="btn btn-sm"
                disabled={translating[seg.id]}
                onClick={() => translateRow(seg.id)}
                title="Dịch riêng câu này bằng AI"
              >
                {translating[seg.id] ? <span className="spinner" /> : "✨ Dịch"}
              </button>
              <span className="faint" style={{ fontSize: 10, textAlign: "center" }}>
                {seg.translated_by ?? ""}
              </span>
            </div>
          </div>
        ))}
        {shown.length === 0 && (
          <div className="empty card">
            {segments.length === 0 ? "Chưa có SRT — upload file .srt ở trên." : "Không còn câu nào chưa dịch 🎉"}
          </div>
        )}
      </div>
    </div>
  );
}
