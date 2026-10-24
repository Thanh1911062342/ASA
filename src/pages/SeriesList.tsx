import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../api/client";
import { packThumb, readPackApi, removeDownload } from "../lib/download";
import { fmtBytes } from "../lib/utils";
import { useDownloads } from "../stores";
import type { DownloadEntry } from "../stores";
import type { SeriesSummary } from "../types";

type Tab = "all" | "offline";

/**
 * Home: the published series, or the episodes already on this device.
 *
 * The "Đã tải" tab renders entirely from `useDownloads` — there is no endpoint
 * that lists episodes across series, and more to the point this tab has to work
 * with the backend switched off, which is the whole feature.
 */
export default function SeriesList() {
  const [series, setSeries] = useState<SeriesSummary[] | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("all");

  const entries = useDownloads((s) => s.entries);
  const downloads = Object.values(entries).sort((a, b) => b.updatedAt - a.updatedAt);

  useEffect(() => {
    api
      .series()
      .then(setSeries)
      .catch(async (e) => {
        // No backend, but the pack seeded `/api/series` into `nv-api-v1` when it
        // was downloaded. Without this the home page sat on "Đang tải…" and the
        // "Đã tải" tab — the one that has to work offline — was unreachable.
        const cached = await readPackApi<SeriesSummary[]>("/api/series");
        if (cached) return setSeries(cached);
        setError(String(e.message));
      });
  }, []);

  const tabs = (
    <div className="tabs" style={{ marginBottom: 16, borderRadius: 12, border: "1px solid var(--border)" }}>
      <button className={tab === "all" ? "on" : ""} onClick={() => setTab("all")}>
        Tất cả
      </button>
      <button className={tab === "offline" ? "on" : ""} onClick={() => setTab("offline")}>
        Đã tải{downloads.length ? ` (${downloads.length})` : ""}
      </button>
    </div>
  );

  if (tab === "offline") {
    return (
      <div className="page">
        <h1 className="page-title">Xem offline</h1>
        {tabs}
        {downloads.length === 0 ? (
          <div className="empty">
            Chưa tải tập nào. Mở một tập và bấm <strong>⬇ Tải về</strong>.
          </div>
        ) : (
          <div className="ep-list">
            {downloads.map((entry) => (
              <OfflineRow key={entry.episodeId} entry={entry} />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className="page">
        <h1 className="page-title">Hôm nay học gì?</h1>
        {tabs}
        <div className="empty">
          Không tải được danh sách: {error}
          <br />
          Các tập đã tải vẫn xem được ở tab <strong>Đã tải</strong>.
        </div>
      </div>
    );
  }
  if (!series)
    return (
      <div className="page">
        <h1 className="page-title">Hôm nay học gì?</h1>
        {tabs}
        <div className="empty">Đang tải…</div>
      </div>
    );

  return (
    <div className="page">
      <h1 className="page-title">Hôm nay học gì?</h1>
      {tabs}
      {series.length === 0 ? (
        <div className="empty">
          Chưa có series nào được publish.
          <br />
          <a className="btn" href="/admin" style={{ marginTop: 12, display: "inline-flex" }}>
            Vào Admin để thêm
          </a>
        </div>
      ) : (
        <div className="series-grid">
          {series.map((s) => (
            <Link key={s.id} to={`/s/${s.slug}`} className="card series-card">
              <div className="series-cover">
                {s.cover_url ? <img src={s.cover_url} alt="" /> : "🎬"}
              </div>
              <div className="series-meta">
                <h3>{s.title}</h3>
                <div className="faint" style={{ fontSize: 13 }}>
                  {s.episode_count} tập
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function OfflineRow({ entry }: { entry: DownloadEntry }) {
  const incomplete = entry.status !== "done";
  return (
    <div className="ep-item">
      {/* The pack copy, not `entry.thumbnail`'s `/media/...` original: the
          Service Worker does not serve `/media/{path}` at all, so the original
          URL is a broken image the moment the backend goes away. */}
      <img
        className="ep-thumb"
        src={packThumb(entry.episodeId)}
        alt=""
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div>
          Tập {entry.number}
          {entry.title ? ` · ${entry.title}` : ""}
        </div>
        <div className="faint" style={{ fontSize: 12.5 }}>
          {entry.seriesTitle || entry.seriesSlug} · {incomplete ? "chưa xong · " : ""}
          {fmtBytes(entry.bytes)}
          {entry.status === "error" && entry.error ? ` · ${entry.error}` : ""}
        </div>
      </div>
      <Link className="btn btn-sm" to={`/watch/${entry.episodeId}`} style={{ flex: "none" }}>
        ▶ Xem
      </Link>
      <button
        className="btn btn-sm btn-danger"
        style={{ flex: "none" }}
        onClick={() => void removeDownload(entry.episodeId)}
        title="Xóa khỏi máy"
      >
        🗑
      </button>
    </div>
  );
}