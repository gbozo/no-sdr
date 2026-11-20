// Runtime clamps for values supplied by the origin's `hello` message.
// The DO must never trust a publisher with unbounded memory settings.

export type HistoryMode = "do-ring" | "origin-snapshot" | "off";

export interface HistorySettings {
  mode: HistoryMode;
  bins: number;
  frames: number;
}

export const DEFAULT_HISTORY: HistorySettings = {
  mode: "do-ring",
  bins: 2048,
  frames: 512,
};

export const DEFAULT_MAX_VIEWERS = 200;

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function clampBins(value: unknown): number {
  const n = clampInt(value, 256, 8192, DEFAULT_HISTORY.bins);
  // Keep it a power of two; the max-hold decimator is happiest that way.
  return 2 ** Math.round(Math.log2(n));
}

export function clampFrames(value: unknown): number {
  return clampInt(value, 32, 2048, DEFAULT_HISTORY.frames);
}

export function clampHistoryMode(value: unknown): HistoryMode {
  return value === "origin-snapshot" || value === "off" || value === "do-ring"
    ? value
    : "do-ring";
}
