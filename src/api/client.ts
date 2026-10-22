import type { AiJob, Episode, Segment, SeriesDetail, SeriesSummary } from "../types";

const TOKEN_KEY = "nv:admin-token";

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (token: string | null) => {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}, admin = false): Promise<T> {
  const headers = new Headers(init.headers);
  if (admin) {
    const token = getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = await res.json();
      if (typeof data.detail === "string") message = data.detail;
    } catch {
      /* ignore non-JSON error bodies */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

// ------------------------------------------------------------------ public
export const api = {
  series: () => request<SeriesSummary[]>("/api/series"),
  seriesDetail: (slug: string) => request<SeriesDetail>(`/api/series/${slug}`),
  episode: (id: number) => request<Episode>(`/api/episodes/${id}`),
  subtitles: (episodeId: number) =>
    request<{ episode_id: number; segments: Segment[] }>(`/api/episodes/${episodeId}/subtitles`),
};

// ------------------------------------------------------------------ admin
export const adminApi = {
  login: (password: string) =>
    request<{ token: string }>("/api/admin/login", json({ password })),

  series: () => request<SeriesSummary[]>("/api/admin/series", {}, true),
  createSeries: (body: Record<string, unknown>) =>
    request<SeriesSummary>("/api/admin/series", json(body), true),
  updateSeries: (id: number, body: Record<string, unknown>) =>
    request<SeriesSummary>(`/api/admin/series/${id}`, { method: "PATCH", body: JSON.stringify(body) }, true),
  deleteSeries: (id: number) =>
    request<{ ok: boolean }>(`/api/admin/series/${id}`, { method: "DELETE" }, true),

  episodes: (seriesId: number) =>
    request<Episode[]>(`/api/admin/series/${seriesId}/episodes`, {}, true),
  createEpisode: (seriesId: number, body: Record<string, unknown>) =>
    request<Episode>(`/api/admin/series/${seriesId}/episodes`, json(body), true),
  updateEpisode: (id: number, body: Record<string, unknown>) =>
    request<Episode>(`/api/admin/episodes/${id}`, { method: "PATCH", body: JSON.stringify(body) }, true),
  deleteEpisode: (id: number) =>
    request<{ ok: boolean }>(`/api/admin/episodes/${id}`, { method: "DELETE" }, true),
  uploadVideo: (id: number, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<Episode>(`/api/admin/episodes/${id}/video`, { method: "POST", body: form }, true);
  },
  extractHls: (pageUrl: string, referer?: string) =>
    request<{ urls: string[] }>("/api/admin/extract-hls", json({ page_url: pageUrl, referer }), true),

  ingestEpisode: (id: number) =>
    request<AiJob>(`/api/admin/episodes/${id}/ingest`, { method: "POST" }, true),
  revertIngest: (id: number) =>
    request<Episode>(`/api/admin/episodes/${id}/ingest:revert`, { method: "POST" }, true),

  segments: (episodeId: number) =>
    request<{ episode: Episode; segments: Segment[] }>(
      `/api/admin/episodes/${episodeId}/segments`,
      {},
      true,
    ),
  uploadSrt: (episodeId: number, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{ imported: number; segments: Segment[] }>(
      `/api/admin/episodes/${episodeId}/subtitles:upload`,
      { method: "POST", body: form },
      true,
    );
  },
  updateSegment: (id: number, body: Partial<Segment>) =>
    request<Segment>(`/api/admin/subtitle-segments/${id}`, { method: "PATCH", body: JSON.stringify(body) }, true),
  translateSegment: (id: number) =>
    request<Segment>(`/api/admin/subtitle-segments/${id}/translate`, { method: "POST" }, true),
  translateEpisode: (episodeId: number, body: { all?: boolean; segment_ids?: number[]; overwrite?: boolean }) =>
    request<AiJob>(`/api/admin/episodes/${episodeId}/translate`, json(body), true),
  job: (id: number) => request<AiJob>(`/api/admin/ai-jobs/${id}`, {}, true),
  cancelJob: (id: number) =>
    request<{ ok: boolean }>(`/api/admin/ai-jobs/${id}/cancel`, { method: "POST" }, true),
  exportSrt: (episodeId: number, kind: string) =>
    request<{ content: string }>(`/api/admin/episodes/${episodeId}/subtitles:export?kind=${kind}`, {}, true),
};
