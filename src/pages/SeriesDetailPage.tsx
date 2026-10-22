import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { api } from "../api/client";
import type { SeriesDetail } from "../types";
import { fmtTime } from "../lib/utils";

export default function SeriesDetailPage() {
  const { slug } = useParams();
  const [series, setSeries] = useState<SeriesDetail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!slug) return;
    api
      .seriesDetail(slug)
      .then(setSeries)
      .catch((e) => setError(e.message));
  }, [slug]);

  if (error) return <div className="page empty">{error}</div>;
  if (!series) return <div className="page empty">Đang tải…</div>;

  return (
    <div className="page">
      <div className="spread" style={{ marginBottom: 18 }}>
        <div>
          <h1 className="page-title" style={{ marginBottom: 6 }}>
            {series.title}
          </h1>
          <div className="muted" style={{ maxWidth: 720, fontSize: 14 }}>
            {series.description || `${series.episode_count} tập`}
          </div>
        </div>
      </div>
      {series.episodes.length === 0 ? (
        <div className="empty card">Chưa có tập nào được publish.</div>
      ) : (
        <div className="stack">
          {series.episodes.map((ep) => (
            <Link
              key={ep.id}
              to={`/watch/${ep.id}`}
              className="card ep-item"
              style={{ padding: 10, gap: 14, borderRadius: 12, border: "1px solid var(--border)" }}
            >
              <div className="ep-thumb-wrap" style={{ position: "relative" }}>
                {ep.thumbnail ? (
                  <img className="ep-thumb" style={{ width: 120, height: 68 }} src={ep.thumbnail} alt="" />
                ) : (
                  <div
                    className="ep-thumb"
                    style={{ width: 120, height: 68, display: "flex", alignItems: "center", justifyContent: "center" }}
                  >
                    ▶
                  </div>
                )}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>
                  Tập {ep.number}
                  {ep.title ? ` · ${ep.title}` : ""}
                </div>
                <div className="faint" style={{ fontSize: 13, marginTop: 4 }}>
                  {ep.duration ? fmtTime(ep.duration) : "—"} · {ep.segment_count} câu phụ đề
                  {ep.segment_count > 0 && ` · dịch ${Math.round((ep.translated_count / ep.segment_count) * 100)}%`}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
