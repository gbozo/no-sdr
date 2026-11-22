// ============================================================
// Persisted decoder history
// ============================================================
// Full-height overlay for the active digital decoder. Message modes read the
// SQLite history API; ADS-B/AIS read the keyed entity tables.

import { Component, For, Show, createEffect, createSignal, on } from 'solid-js';
import {
  type DecoderEntity,
  type DecoderHistoryMessage,
  entityKind,
  fetchDecoderEntities,
  fetchDecoderHistory,
  isEntityMode,
} from '../engine/decoder-history.js';
import { formatGridCenter, extractGridFromText } from '~/shared';

type Range = '1h' | '24h' | '7d' | 'all';

const RANGE_MS: Record<Exclude<Range, 'all'>, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

function formatTime(ms?: number | null): string {
  if (!ms || !Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString([], {
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatHz(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return '—';
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(6)} MHz`;
  if (hz >= 1_000) return `${(hz / 1_000).toFixed(1)} kHz`;
  return `${hz.toFixed(0)} Hz`;
}

function gridOf(message: DecoderHistoryMessage): string {
  const fromServer = message.payload?.grid;
  if (typeof fromServer === 'string' && fromServer) return fromServer.toUpperCase();
  return extractGridFromText(message.mode, message.text);
}

function entityDetail(payload: Record<string, unknown>): string {  const keys = ['callsign', 'name', 'flight', 'sog_kt', 'altitude_ft', 'lat', 'lon'];
  const parts: string[] = [];
  for (const key of keys) {
    const value = payload[key];
    if (value === undefined || value === null || value === '') continue;
    if (key === 'lat' || key === 'lon') {
      parts.push(`${key.toUpperCase()} ${Number(value).toFixed(4)}`);
    } else if (key === 'sog_kt') {
      parts.push(`${Number(value).toFixed(1)} kt`);
    } else if (key === 'altitude_ft') {
      parts.push(`${value} ft`);
    } else {
      parts.push(String(value));
    }
    if (parts.length >= 4) break;
  }
  return parts.join(' · ') || '—';
}

const DecoderHistoryPanel: Component<{ mode: string; onClose: () => void }> = (props) => {
  const [rows, setRows] = createSignal<DecoderHistoryMessage[]>([]);
  const [entities, setEntities] = createSignal<DecoderEntity[]>([]);
  const [total, setTotal] = createSignal(0);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [range, setRange] = createSignal<Range>('24h');
  const [search, setSearch] = createSignal('');
  const [limit, setLimit] = createSignal(200);
  const [offset, setOffset] = createSignal(0);
  let requestSeq = 0;
  let searchInput: HTMLInputElement | undefined;

  const entityMode = () => isEntityMode(props.mode);

  async function load(reset = true): Promise<void> {
    const seq = ++requestSeq;
    setLoading(true);
    setError('');
    try {
      if (entityMode()) {
        const kind = entityKind(props.mode);
        if (!kind) return;
        const list = await fetchDecoderEntities(kind, 500);
        if (seq !== requestSeq) return;
        setEntities(list);
        setRows([]);
        setTotal(list.length);
        setOffset(0);
        return;
      }

      const nextOffset = reset ? 0 : offset();
      const since =
        range() === 'all'
          ? undefined
          : Date.now() - RANGE_MS[range() as Exclude<Range, 'all'>];
      const page = await fetchDecoderHistory({
        mode: props.mode,
        q: search().trim() || undefined,
        since,
        limit: limit(),
        offset: nextOffset,
      });
      if (seq !== requestSeq) return;
      setRows(reset ? page.messages : [...rows(), ...page.messages]);
      setTotal(page.total);
      setOffset(nextOffset + page.messages.length);
      setEntities([]);
    } catch (cause) {
      if (seq === requestSeq) {
        setError(cause instanceof Error ? cause.message : 'history request failed');
      }
    } finally {
      if (seq === requestSeq) setLoading(false);
    }
  }

  // Reload when the panel opens and whenever the workspace switches mode.
  createEffect(on(() => props.mode, () => load(true)));

  const canLoadMore = () => !entityMode() && rows().length < total() && !loading();

  return (
    <div
      class="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-3"
      onClick={props.onClose}
    >
      <div
        class="w-full max-w-6xl max-h-full min-h-0 flex flex-col rounded-sm border border-cyan/30 bg-sdr-surface shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            props.onClose();
          }
        }}
      >
        <div class="flex items-center gap-3 px-3 py-2 border-b border-border/50 shrink-0 flex-wrap">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-[12px] font-mono font-bold text-text-primary uppercase tracking-wider">
                {props.mode} history
              </span>
              <span class="text-[9px] font-mono uppercase tracking-wider text-cyan border border-cyan/30 rounded px-1">
                persisted
              </span>
            </div>
            <div class="text-[9px] font-mono text-text-dim mt-0.5">
              {total()} stored {entityMode() ? 'entities' : 'messages'}
            </div>
          </div>

          <div class="ml-auto flex items-center gap-1.5 flex-wrap">
            <Show when={!entityMode()}>
              <input
                ref={searchInput}
                type="text"
                class="admin-input w-44"
                placeholder="Search text…"
                value={search()}
                onInput={(event) => setSearch(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') load(true);
                }}
              />
              <select
                class="admin-input w-24"
                value={range()}
                onChange={(event) => {
                  setRange(event.currentTarget.value as Range);
                  load(true);
                }}
              >
                <option value="1h">Last 1h</option>
                <option value="24h">Last 24h</option>
                <option value="7d">Last 7d</option>
                <option value="all">All time</option>
              </select>
              <select
                class="admin-input w-24"
                value={String(limit())}
                onChange={(event) => {
                  setLimit(Number.parseInt(event.currentTarget.value, 10) || 200);
                  load(true);
                }}
              >
                <option value="100">100</option>
                <option value="200">200</option>
                <option value="500">500</option>
                <option value="1000">1000</option>
              </select>
            </Show>
            <button
              class="px-2 py-0.5 text-[10px] font-mono uppercase rounded border border-border/50 text-text-dim hover:text-text-primary transition-colors"
              onClick={() => load(true)}
            >
              Refresh
            </button>
            <button
              class="px-2 py-0.5 text-[11px] font-mono text-text-dim hover:text-amber"
              onClick={props.onClose}
              title="Close history (Esc)"
            >
              ✕
            </button>
          </div>
        </div>

        <Show when={error()}>
          <div class="px-3 py-2 border-b border-red-400/20 bg-red-400/5">
            <span class="text-[10px] font-mono text-red-400">{error()}</span>
          </div>
        </Show>

        <div class="flex-1 min-h-0 overflow-auto">
          <Show when={entityMode()}>
            <table class="w-full text-[10px] font-mono">
              <thead class="sticky top-0 z-10 bg-sdr-surface text-text-dim">
                <tr>
                  <th class="text-left px-2 py-1">KEY</th>
                  <th class="text-left px-2 py-1">LAST SEEN</th>
                  <th class="text-left px-2 py-1">FIRST SEEN</th>
                  <th class="text-left px-2 py-1">DETAILS</th>
                </tr>
              </thead>
              <tbody>
                <For each={entities()}>
                  {(entity) => (
                    <tr class="border-t border-border/20">
                      <td class="px-2 py-1 text-cyan whitespace-nowrap">{entity.key}</td>
                      <td class="px-2 py-1 text-text-dim whitespace-nowrap">
                        {formatTime(entity.lastSeenMs)}
                      </td>
                      <td class="px-2 py-1 text-text-dim whitespace-nowrap">
                        {formatTime(entity.firstSeenMs)}
                      </td>
                      <td class="px-2 py-1 text-text-primary break-all">
                        {entityDetail(entity.payload)}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>

          <Show when={!entityMode()}>
            <table class="w-full text-[10px] font-mono">
              <thead class="sticky top-0 z-10 bg-sdr-surface text-text-dim">
                <tr>
                  <th class="text-left px-2 py-1">TIME</th>
                  <th class="text-left px-2 py-1">DECODER</th>
                  <th class="text-left px-2 py-1">MESSAGE</th>
                  <th class="text-left px-2 py-1">GRID</th>
                  <th class="text-right px-2 py-1">RF</th>
                  <th class="text-right px-2 py-1">SNR</th>
                  <th class="text-right px-2 py-1">DT</th>
                </tr>
              </thead>
              <tbody>
                <For each={rows()}>
                  {(message) => (
                    <tr class="border-t border-border/20 align-top">
                      <td class="px-2 py-1 text-text-dim whitespace-nowrap">
                        {formatTime(message.receivedMs)}
                      </td>
                      <td class="px-2 py-1 text-text-muted truncate max-w-28">
                        {message.decoderId}
                      </td>
                      <td class="px-2 py-1 text-text-primary break-all">
                        {message.text}
                      </td>
                      <td
                        class="px-2 py-1 text-text-secondary whitespace-nowrap uppercase"
                        title={formatGridCenter(gridOf(message)) || undefined}
                      >
                        {gridOf(message)}
                      </td>
                      <td class="px-2 py-1 text-right text-text-secondary whitespace-nowrap">
                        {formatHz(message.frequencyHz)}
                      </td>
                      <td class="px-2 py-1 text-right text-text-dim">
                        {Number.isFinite(message.snrDb) ? Math.round(message.snrDb) : '—'}
                      </td>
                      <td class="px-2 py-1 text-right text-text-dim">
                        {Number.isFinite(message.dtSec) ? message.dtSec.toFixed(2) : '—'}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>

          <Show when={!loading() && (entityMode() ? entities().length === 0 : rows().length === 0)}>
            <p class="text-[10px] font-mono text-text-dim px-3 py-6 text-center">
              No stored {entityMode() ? 'entities' : 'messages'} for {props.mode.toUpperCase()} in this time range.
            </p>
          </Show>

          <Show when={loading()}>
            <p class="text-[10px] font-mono text-text-dim px-3 py-4 text-center animate-pulse">
              Loading history…
            </p>
          </Show>
        </div>

        <Show when={canLoadMore()}>
          <div class="px-3 py-2 border-t border-border/40 flex items-center justify-between shrink-0">
            <span class="text-[9px] font-mono text-text-dim">
              Showing {rows().length} of {total()}
            </span>
            <button
              class="px-2 py-0.5 text-[10px] font-mono uppercase rounded border border-accent/40 text-accent hover:bg-accent hover:text-text-inverse transition-colors"
              onClick={() => load(false)}
            >
              Load more
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default DecoderHistoryPanel;
