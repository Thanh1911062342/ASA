export type SubMode = "jp_vi" | "jp" | "vi";

export interface SeriesSummary {
  id: number;
  title: string;
  slug: string;
  description: string | null;
  cover_url: string | null;
  tags: string[];
  status: string;
  sort_order: number;
  episode_count: number;
}

export interface Episode {
  id: number;
  series_id: number;
  number: number;
  title: string | null;
  source_type: "file" | "hls";
  embed_url: string | null;
  hls_url: string | null;
  stream_url: string | null;
  proxy_url: string | null;
  duration: number | null;
  thumbnail: string | null;
  status: string;
  segment_count: number;
  translated_count: number;
  series?: { id: number; title: string; slug: string };
}

export interface SeriesDetail extends SeriesSummary {
  episodes: Episode[];
}

export interface Segment {
  id: number;
  idx: number;
  start_ms: number;
  end_ms: number;
  text_jp: string;
  text_vi: string | null;
  translated_by?: string | null;
  status?: string;
}

export interface AiJob {
  id: number;
  episode_id: number;
  type: string;
  status: "pending" | "running" | "done" | "error" | "canceled";
  total: number;
  done: number;
  error: string | null;
}
