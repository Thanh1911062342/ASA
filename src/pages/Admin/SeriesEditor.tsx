import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { adminApi } from "../../api/client";
import type { SeriesSummary } from "../../types";

interface FormState {
  id?: number;
  title: string;
  slug: string;
  description: string;
  cover_url: string;
  status: string;
}

const emptyForm: FormState = {
  title: "",
  slug: "",
  description: "",
  cover_url: "",
  status: "draft",
};

export default function SeriesEditor() {
  const [rows, setRows] = useState<SeriesSummary[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () =>
    adminApi
      .series()
      .then(setRows)
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setError("");
    try {
      const body = {
        title: form.title,
        slug: form.slug || undefined,
        description: form.description || null,
        cover_url: form.cover_url || null,
        status: form.status,
      };
      if (form.id) await adminApi.updateSeries(form.id, body);
      else await adminApi.createSeries(body);
      setForm(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number, title: string) => {
    if (!confirm(`Xóa series "${title}" và toàn bộ tập bên trong?`)) return;
    await adminApi.deleteSeries(id);
    load();
  };

  return (
    <div>
      <div className="spread">
        <h1>Series</h1>
        <button className="btn btn-primary" onClick={() => setForm(emptyForm)}>
          + Thêm series
        </button>
      </div>
      {error && <div style={{ color: "#ff9aa6", marginBottom: 12 }}>{error}</div>}

      <table className="table">
        <thead>
          <tr>
            <th>Tiêu đề</th>
            <th>Slug</th>
            <th>Trạng thái</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id}>
              <td>
                <strong>{s.title}</strong>
              </td>
              <td className="faint">{s.slug}</td>
              <td>
                <span className={`badge ${s.status === "published" ? "badge-ok" : "badge-draft"}`}>
                  {s.status}
                </span>
              </td>
              <td>
                <div className="row" style={{ justifyContent: "flex-end" }}>
                  <Link className="btn btn-sm" to={`/admin/series/${s.id}/episodes`}>
                    Tập
                  </Link>
                  <button
                    className="btn btn-sm"
                    onClick={() =>
                      setForm({
                        id: s.id,
                        title: s.title,
                        slug: s.slug,
                        description: s.description ?? "",
                        cover_url: s.cover_url ?? "",
                        status: s.status,
                      })
                    }
                  >
                    Sửa
                  </button>
                  <button className="btn btn-sm btn-danger" onClick={() => remove(s.id, s.title)}>
                    Xóa
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="empty">
                Chưa có series nào.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {form && (
        <div className="modal-backdrop" onClick={() => setForm(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
            <h2>{form.id ? "Sửa series" : "Thêm series"}</h2>
            <div className="field">
              <label>Tiêu đề</label>
              <input
                className="input"
                required
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Slug (để trống = tự tạo)</label>
              <input
                className="input"
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value })}
                placeholder="yuru-camp-s2"
              />
            </div>
            <div className="field">
              <label>Mô tả</label>
              <textarea
                className="textarea"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Cover URL</label>
              <input
                className="input"
                value={form.cover_url}
                onChange={(e) => setForm({ ...form, cover_url: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Trạng thái</label>
              <select
                className="select"
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value })}
              >
                <option value="draft">draft — ẩn với người học</option>
                <option value="published">published — hiện công khai</option>
              </select>
            </div>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="btn" onClick={() => setForm(null)}>
                Hủy
              </button>
              <button className="btn btn-primary" disabled={busy}>
                Lưu
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
