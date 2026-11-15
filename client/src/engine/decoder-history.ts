// ============================================================
// Persisted decoder history API
// ============================================================
// Background decoders write decoded messages to SQLite. The client reads the
// same rows back so the Digital Decoders workspace can show previous sessions
// alongside the live stream.

export interface DecoderHistoryMessage {
  id: number;
  decoderId: string;
  dongleId: string;
  mode: string;
  receivedMs: number;
  text: string;
  frequencyHz: number;
  audioHz: number;
  snrDb: number;
  dtSec: number;
  period: number;
  payload: Record<string, unknown> | null;
}

export interface DecoderHistoryPage {
  messages: DecoderHistoryMessage[];
  total: number;
  limit: number;
  offset: number;
}

export interface DecoderEntity {
  kind: string;
  key: string;
  firstSeenMs: number;
  lastSeenMs: number;
  payload: Record<string, unknown>;
}

export interface DecoderHistoryParams {
  mode?: string;
  decoderId?: string;
  dongleId?: string;
  q?: string;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
}

export async function fetchDecoderHistory(
  params: DecoderHistoryParams,
): Promise<DecoderHistoryPage> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      query.set(key, String(value));
    }
  }
  const res = await fetch(`/api/decoder/history?${query.toString()}`, {
    credentials: 'same-origin',
  });
  if (!res.ok) {
    throw new Error(`history request failed (HTTP ${res.status})`);
  }
  const data = await res.json();
  return {
    messages: Array.isArray(data.messages) ? data.messages : [],
    total: typeof data.total === 'number' ? data.total : 0,
    limit: typeof data.limit === 'number' ? data.limit : params.limit ?? 200,
    offset: typeof data.offset === 'number' ? data.offset : params.offset ?? 0,
  };
}

export async function fetchDecoderEntities(
  kind: 'aircraft' | 'vessel',
  limit = 500,
): Promise<DecoderEntity[]> {
  const path = kind === 'aircraft' ? 'aircraft' : 'vessels';
  const res = await fetch(`/api/decoder/${path}?limit=${limit}`, {
    credentials: 'same-origin',
  });
  if (!res.ok) {
    throw new Error(`entity request failed (HTTP ${res.status})`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export function isEntityMode(mode: string): boolean {
  return mode === 'adsb' || mode === 'ais';
}

export function entityKind(mode: string): 'aircraft' | 'vessel' | null {
  if (mode === 'adsb') return 'aircraft';
  if (mode === 'ais') return 'vessel';
  return null;
}
