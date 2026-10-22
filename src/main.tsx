import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import "./styles.css";

import AppLayout from "./components/AppLayout";
import AdminApp from "./pages/Admin/AdminApp";
import AdminLogin from "./pages/Admin/AdminLogin";
import SeriesEditor from "./pages/Admin/SeriesEditor";
import EpisodesPage from "./pages/Admin/EpisodesPage";
import SubtitleEditor from "./pages/Admin/SubtitleEditor";
import SeriesList from "./pages/SeriesList";
import SeriesDetailPage from "./pages/SeriesDetailPage";
import Watch from "./pages/Watch/Watch";

// Session-scoped segment cache (see public/sw.js): Cache Storage is shared
// between the page and its workers, so the load itself drops the previous
// session's segments — the "wipe on F5" half of the design. This name is
// hardcoded on purpose: `nv-offline-v1` (downloaded packs), `nv-shell-v1` and
// `nv-api-v1` must survive. Never turn this into a `caches.keys()` loop.
if ("caches" in window) {
  caches.delete("nv-media-v1");
}
// Playback no longer resumes from the last position; drop the old key so
// stale data from previous builds doesn't linger.
localStorage.removeItem("nv:progress");
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    /* dev over a non-localhost origin, or SW blocked — player still works */
  });
}
// Ask the browser not to evict Cache Storage under storage pressure — a
// downloaded episode pack is ~95 MB, exactly what it would reclaim first.
// Best-effort only: if it refuses, packs may vanish and the download store
// reports them as missing rather than playing silently broken.
if (navigator.storage?.persist) {
  navigator.storage.persist().catch(() => undefined);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<SeriesList />} />
          <Route path="/s/:slug" element={<SeriesDetailPage />} />
          <Route path="/watch/:episodeId" element={<Watch />} />
        </Route>
        <Route path="/admin/login" element={<AdminLogin />} />
        <Route path="/admin" element={<AdminApp />}>
          <Route index element={<Navigate to="series" replace />} />
          <Route path="series" element={<SeriesEditor />} />
          <Route path="series/:seriesId/episodes" element={<EpisodesPage />} />
          <Route path="episodes/:episodeId/subtitles" element={<SubtitleEditor />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
