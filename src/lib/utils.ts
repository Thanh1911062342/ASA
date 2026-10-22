export const fmtTime = (sec: number) => {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
};

export const fmtMs = (ms: number) => {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

/** Binary search: last segment whose start_ms <= t, if it is still active. */
export function findSegment<T extends { start_ms: number; end_ms: number }>(
  segments: T[],
  ms: number,
): number {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].start_ms <= ms) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found === -1) return -1;
  return ms <= segments[found].end_ms ? found : -1;
}

export const isMobile = () =>
  typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches;

/** Human byte size for download progress and the "Đã tải" list. */
export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) bytes = 0;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "";
  for (const u of units) {
    value /= 1024;
    unit = u;
    if (value < 1024) break;
  }
  // One decimal down to 10, then none: "9.6 MB" and "96 MB" both read cleanly.
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}
