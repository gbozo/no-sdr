/**
 * Band plan store — fetches from GET /api/bandplan and exposes reactive signals.
 * Region defaults to '' (global). Consumers can call setRegion('r1'|'r2'|'r3').
 */
import { createSignal } from 'solid-js';

export interface BandEntry {
  name: string;
  lower_bound: number;
  upper_bound: number;
  frequencies?: Record<string, unknown>;
  tags?: string[];
}

interface BandPlanResponse {
  region: string;
  bands: BandEntry[];
  updated: string; // ISO timestamp or zero
}

// Tag → colour mapping for band overlay
const TAG_COLORS: Record<string, string> = {
  hamradio:  'rgba(56, 193, 128, 0.26)',   // accent green
  broadcast: 'rgba(255, 160, 30,  0.25)',   // amber
  service:   'rgba(80,  160, 255, 0.23)',   // blue
  public:    'rgba(200, 100, 255, 0.22)',   // purple
};

export const TAG_BORDER_COLORS: Record<string, string> = {
  hamradio:  'rgba(56, 193, 128, 0.55)',
  broadcast: 'rgba(255, 160, 30,  0.55)',
  service:   'rgba(80,  160, 255, 0.50)',
  public:    'rgba(200, 100, 255, 0.45)',
};

export function tagColor(tags: string[] | undefined): string {
  if (!tags?.length) return 'rgba(150, 150, 150, 0.10)';
  for (const t of tags) if (TAG_COLORS[t]) return TAG_COLORS[t];
  return 'rgba(150, 150, 150, 0.10)';
}

const [bands, setBands] = createSignal<BandEntry[]>([]);
const [region, setRegionSignal] = createSignal<string>('');

export { bands, region };

export function setRegion(r: string): void {
  setRegionSignal(r);
  fetchBandPlan(r);
}

export async function fetchBandPlan(r: string = ''): Promise<void> {
  try {
    const url = r ? `/api/bandplan?region=${encodeURIComponent(r)}` : '/api/bandplan';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: BandPlanResponse = await res.json();
    setBands(data.bands ?? []);
  } catch (e) {
    // silently ignore — bands will stay at previous value (or empty on first load)
    console.warn('[bandplan] fetch failed:', e);
  }
}

// Initial load on module import
fetchBandPlan();
