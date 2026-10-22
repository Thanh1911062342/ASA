import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { SubMode } from "./types";

interface SettingsState {
  subMode: SubMode;
  rate: number;
  volume: number;
  setSubMode: (mode: SubMode) => void;
  setRate: (rate: number) => void;
  setVolume: (volume: number) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      subMode: "jp_vi",
      rate: 1,
      volume: 1,
      setSubMode: (subMode) => set({ subMode }),
      setRate: (rate) => set({ rate }),
      setVolume: (volume) => set({ volume }),
    }),
    { name: "nv:settings" },
  ),
);

// No progress store: reload always restarts the episode from the top, so
// there is nothing to persist. (The old "nv:progress" key is cleaned up in
// main.tsx for anyone who used a previous build.)

export type DownloadStatus = "downloading" | "done" | "partial" | "error";

/**
 * One downloaded episode pack. The **bytes live in Cache Storage**
 * (`nv-offline-v1`, keys `/__offline/ep/<id>/…`); this entry is only the
 * metadata the UI needs to list packs without touching the network.
 *
 * `seriesTitle`, `number`, `title` and `thumbnail` are denormalized on purpose:
 * there is no endpoint that lists episodes across series (`api` in client.ts is
 * just series / seriesDetail / episode / subtitles), so the "Đã tải" tab on the
 * home page has to render entirely from localStorage — which is also the point,
 * since that tab must work with the backend switched off.
 */
export interface DownloadEntry {
  episodeId: number;
  seriesId: number;
  seriesSlug: string;
  seriesTitle: string;
  number: number;
  title: string | null;
  thumbnail: string | null;
  duration: number | null;
  sourceType: "file" | "hls";
  /** HLS: segments finished. file: 0 or 1 — a file pack is one request. */
  loaded: number;
  /** HLS: segments in the playlist. file: 1. */
  total: number;
  /** bytes written to the cache so far */
  bytes: number;
  /** bytes expected in total, as far as the source said (0 = unknown) */
  size: number;
  status: DownloadStatus;
  error: string | null;
  updatedAt: number;
}

interface DownloadsState {
  /** keyed by episodeId so an upsert can't duplicate a pack */
  entries: Record<number, DownloadEntry>;
  put: (entry: DownloadEntry) => void;
  remove: (episodeId: number) => void;
  clear: () => void;
}

export const useDownloads = create<DownloadsState>()(
  persist(
    (set) => ({
      entries: {},
      put: (entry) =>
        set((state) => ({ entries: { ...state.entries, [entry.episodeId]: entry } })),
      remove: (episodeId) =>
        set((state) => {
          if (!(episodeId in state.entries)) return state;
          const entries = { ...state.entries };
          delete entries[episodeId];
          return { entries };
        }),
      clear: () => set({ entries: {} }),
    }),
    {
      name: "nv:downloads",
      // A reload aborts every page-side fetch, so nothing can still be
      // "downloading" — such an entry is really an interrupted pack. Downgrade
      // it rather than leave a spinner in the UI forever; "Tải tiếp" resumes by
      // probing the cache for what is already there.
      onRehydrateStorage: () => () => {
        const state = useDownloads.getState();
        const stale = Object.values(state.entries).filter((e) => e.status === "downloading");
        if (!stale.length) return;
        const entries = { ...state.entries };
        for (const entry of stale) {
          entries[entry.episodeId] = { ...entry, status: "partial", updatedAt: Date.now() };
        }
        useDownloads.setState({ entries });
      },
    },
  ),
);
