import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { adminApi } from "../../api/client";
import type { AiJob, Episode } from "../../types";
import { fmtTime } from "../../lib/utils";

const JOB_OVER = ["done", "error", "canceled"];

/** An ingested MP4 keeps its `hls_url`; a manual upload never has one. */
const ingested = (ep: Episode) => ep.source_type === "file" && !!ep.hls_url;

export default function EpisodesPage() {
  const { seriesId } = useParams();
  const sid = Number(seriesId);
  const [rows, setRows] = useState<Episode[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [job, setJob] = useState<AiJob | null>(null);
  const [form, setForm] = useState<{ id?: number; number: string; title: string; source_type: string; embed_url: string; hls_url: string; status: string } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const load = () =>
    adminApi
      .episodes(sid)
      .then(setRows)
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, [sid]);

  // Same 2s poll as SubtitleEditor: an ingest job runs minutes long, and its
  // row only becomes useful once the episode has flipped to `file`. `load` is
  // recreated every render, so the refresh is inlined here and the effect only
  // depends on `job` — otherwise each render would restart the 2s clock.
  useEffect(() => {
    if (!job || JOB_OVER.includes(job.status)) return;
    const id = window.setInterval(async () => {
      try {
        const fresh = await adminApi.job(job.id);
        setJob(fresh);
        if (JOB_OVER.includes(fresh.status)) {
          setRows(await adminApi.episodes(sid));
          setNotice(
            fresh.status === "done"
              ? `Đã tải tập #${fresh.episode_id} về server (${fresh.done} segment).`
              : `Job ${fresh.status}${fresh.error ? `: ${fresh.error}` : ""}`,
          );
        }
      } catch {
        /* keep polling; the job may have finished between polls */
      }
    }, 2000);
    return () => window.clearInterval(id);
  }, [job, sid]);

  const ingest = async (ep: Episode) => {
    setError("");
    setNotice("");
    try {
      setJob(await adminApi.ingestEpisode(ep.id));
    } catch (err) {
      setError(`Tải về server: ${(err as Error).message}`);
    }
  };

  const revert = async (ep: Episode) => {
    if (!window.confirm(`Tập ${ep.number}: xóa MP4 đã tải và quay lại phát stream?`)) return;
    setError("");
    setNotice("");
    try {
      await adminApi.revertIngest(ep.id);
      setNotice(`Tập ${ep.number} đã về chế độ stream.`);
      await load();
    } catch (err) {
      setError(`Về stream: ${(err as Error).message}`);
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setError("");
    try {
      const body = {
        number: Number(form.number),
        title: form.title || null,
        source_type: form.source_type,
        embed_url: form.embed_url || null,
        hls_url: form.hls_url || null,
        status: form.status,
      };
      if (form.id) await adminApi.updateEpisode(form.id, body);
      else {
        const created = await adminApi.createEpisode(sid, body);
        if (file && form.source_type === "file") await uploadFor(created.id, file);
      }
      setForm(null);
      setFile(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const uploadFor = async (episodeId: number, f: File) => {
    setUploading(true);
    setError("");
    try {
      await adminApi.uploadVideo(episodeId, f);
    } catch (err) {
      setError(`Upload video: ${(err as Error).message}`);
      throw err;
    } finally {
      setUploading(false);
    }
  };

  const extractHls = async () => {
    if (!form?.embed_url) {
      setError("Cần nhập link embed trước khi lấy HLS.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await adminApi.extractHls(form.embed_url, form.embed_url);
      if (res.urls.length === 0) {
        setError("Không tìm thấy playlist nào trong trang embed. Dán tay URL .m3u8 vào ô dưới.");
      } else {
        setForm({ ...form, hls_url: res.urls[0] });
      }
    } catch (err) {
      setError(`Lấy HLS: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number, number: number) => {
    if (!window.confirm(`Xóa tập ${number}?`)) return;
    setBusy(true);
    try {
      await adminApi.deleteEpisode(id);
      await load();
    } catch (err) {
      setError(`Xóa tập: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="spread">
        <h1>
          Tập <span className="faint" style={{ fontSize: 14 }}>(series #{sid})</span>
        </h1>
        <button
          className="btn btn-primary"
          onClick={() =>
            setForm({ number: String(rows.length + 1), title: "", source_type: "hls", embed_url: "", hls_url: "", status: "draft" })
          }
        >
          + Thêm tập
        </button>
      </div>
      {uploading && (
        <div className="job-bar" style={{ marginBottom: 12 }}>
          <span className="spinner" /> Đang upload video… (file lớn có thể mất vài phút)
        </div>
      )}
      {job && !JOB_OVER.includes(job.status) && (
        <div className="job-bar" style={{ marginBottom: 12, borderColor: "var(--accent)" }}>
          <span className="spinner" style={{ borderColor: "var(--accent)", borderTopColor: "#fff" }} />
          <span style={{ fontSize: 13 }}>
            Đang tải về server — {job.done}/{job.total} segment
          </span>
          <div className="track">
            <div className="fill" style={{ width: job.total ? `${(job.done / job.total) * 100}%` : 0 }} />
          </div>
          <button className="btn btn-sm btn-danger" onClick={() => adminApi.cancelJob(job.id)}>
            Hủy
          </button>
        </div>
      )}
      {error && <div style={{ color: "#ff9aa6", marginBottom: 12 }}>{error}</div>}
      {notice && <div style={{ color: "#7ee2b8", marginBottom: 12 }}>{notice}</div>}

      <table className="table">
        <thead>
          <tr>
            <th>Số</th>
            <th>Tiêu đề</th>
            <th>Nguồn</th>
            <th>Phụ đề</th>
            <th>Trạng thái</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((ep) => (
            <tr key={ep.id}>
              <td>
                <strong>{ep.number}</strong>
              </td>
              <td>{ep.title ?? "—"}</td>
              <td className="faint" style={{ fontSize: 13 }}>
                {ep.source_type === "hls" ? (
                  <span title={ep.hls_url ?? ""}>stream{ep.embed_url ? " (từ embed)" : ""}</span>
                ) : (
                  <span title={ep.stream_url ?? ""}>
                    file{ep.duration ? ` · ${fmtTime(ep.duration)}` : ""}
                    {ingested(ep) ? " · tự tải" : ""}
                  </span>
                )}
              </td>
              <td>
                <span className="faint" style={{ fontSize: 13 }}>
                  {ep.segment_count} câu · {ep.translated_count} đã dịch
                </span>
              </td>
              <td>
                <span className={`badge ${ep.status === "published" ? "badge-ok" : "badge-draft"}`}>
                  {ep.status}
                </span>
              </td>
              <td>
                <div className="row" style={{ justifyContent: "flex-end" }}>
                  {ep.source_type === "hls" && ep.hls_url && (
                    <button
                      className="btn btn-sm"
                      title="Tải trọn tập về server, remux thành MP4 tự host — hết phụ thuộc CDN"
                      onClick={() => ingest(ep)}
                      disabled={!!job && !JOB_OVER.includes(job.status)}
                    >
                      ⬇ Tải về server
                    </button>
                  )}
                  {ingested(ep) && (
                    <button
                      className="btn btn-sm"
                      title="Xóa MP4 đã tải, quay lại phát stream qua proxy"
                      onClick={() => revert(ep)}
                      disabled={!!job && !JOB_OVER.includes(job.status)}
                    >
                      ↩ Về stream
                    </button>
                  )}
                  <Link className="btn btn-sm" to={`/admin/episodes/${ep.id}/subtitles`}>
                    Phụ đề
                  </Link>
                  <button
                    className="btn btn-sm"
                    onClick={() =>
                      setForm({
                        id: ep.id,
                        number: String(ep.number),
                        title: ep.title ?? "",
                        source_type: ep.source_type,
                        embed_url: ep.embed_url ?? "",
                        hls_url: ep.hls_url ?? "",
                        status: ep.status,
                      })
                    }
                  >
                    Sửa
                  </button>
                  <button className="btn btn-sm btn-danger" onClick={() => remove(ep.id, ep.number)}>
                    Xóa
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="empty">
                Chưa có tập nào.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {form && (
        <div className="modal-backdrop" onClick={() => !busy && setForm(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
            <h2>{form.id ? `Sửa tập ${form.number}` : "Thêm tập"}</h2>
            <div className="row">
              <div className="field" style={{ flex: "0 0 110px" }}>
                <label>Số tập</label>
                <input
                  className="input"
                  required
                  type="number"
                  step="0.5"
                  value={form.number}
                  onChange={(e) => setForm({ ...form, number: e.target.value })}
                />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Tiêu đề</label>
                <input
                  className="input"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                />
              </div>
            </div>
            <div className="field">
              <label>Nguồn video</label>
              <select
                className="select"
                value={form.source_type}
                onChange={(e) => setForm({ ...form, source_type: e.target.value })}
              >
                <option value="hls">Stream — dán link embed, tự lấy HLS</option>
                <option value="file">File — tự host MP4</option>
              </select>
            </div>
            {form.source_type === "hls" && (
              <>
                <div className="field">
                  <label>Link embed (megavid.buzz…)</label>
                  <div className="row">
                    <input
                      className="input"
                      style={{ flex: 1 }}
                      placeholder="https://megavid.buzz/ani/966/1/sub"
                      value={form.embed_url}
                      onChange={(e) => setForm({ ...form, embed_url: e.target.value })}
                    />
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={extractHls}
                      disabled={busy || !form.embed_url}
                    >
                      {busy ? "Đang lấy…" : "Lấy HLS master playlist"}
                    </button>
                  </div>
                  <span className="faint" style={{ fontSize: 12 }}>
                    Backend đọc trang embed, gọi source API của player để lấy URL HLS thật rồi
                    điền vào ô dưới. Link embed chỉ được lưu để tham chiếu — video luôn phát qua
                    proxy của app (tua/pause/click-nghe-lại đầy đủ).
                  </span>
                </div>
                <div className="field">
                  <label>URL stream (.m3u8 / .mp4) — proxy qua backend</label>
                  <input
                    className="input"
                    placeholder="https://.../playlist.m3u8"
                    value={form.hls_url}
                    onChange={(e) => setForm({ ...form, hls_url: e.target.value })}
                  />
                  <span className="faint" style={{ fontSize: 12 }}>
                    Tự lấy bằng nút trên, hoặc dán tay nếu bạn đã có link.
                  </span>
                </div>
              </>
            )}
            {form.source_type === "file" && (
              <div className="field">
                <label>{form.id ? "Thay file video" : "File video MP4"}</label>
                <input
                  ref={fileInputRef}
                  className="input"
                  type="file"
                  accept="video/mp4,video/webm"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
                {form.id && (
                  <span className="faint" style={{ fontSize: 12 }}>
                    Bỏ trống nếu giữ video hiện tại.
                  </span>
                )}
              </div>
            )}
            <div className="field">
              <label>Trạng thái</label>
              <select
                className="select"
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value })}
              >
                <option value="draft">draft</option>
                <option value="published">published</option>
              </select>
            </div>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="btn" onClick={() => setForm(null)} disabled={busy}>
                Hủy
              </button>
              <button className="btn btn-primary" disabled={busy || uploading}>
                {busy ? "Đang lưu…" : "Lưu"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
