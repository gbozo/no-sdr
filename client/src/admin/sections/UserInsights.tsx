// ============================================================
// User presence map and session analytics
// ============================================================
// Live OSM map: current listeners plus anyone who disconnected in the last
// configured window (one hour by default). History: coloured region bubbles
// plus frequency/mode hot lists from the persisted user_sessions table.

import { Component, For, Show, createSignal, onCleanup, onMount } from 'solid-js';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

interface LiveUser {
  id: string;
  persistentId: string;
  connIndex: number;
  connectedAtMs: number;
  lastSeenMs: number;
  disconnectedAtMs?: number | null;
  active: boolean;
  ip: string;
  realIp: string;
  countryCode: string;
  country: string;
  region: string;
  regionCode: string;
  city: string;
  latitude?: number | null;
  longitude?: number | null;
  continent: string;
  dongleId: string;
  profileId: string;
  frequencyHz: number;
  mode: string;
  bandwidth: number;
}

interface LiveResponse {
  generatedAtMs: number;
  recentMinutes: number;
  users: LiveUser[];
}

interface CountRow {
  count: number;
}

interface CountryRow extends CountRow {
  countryCode: string;
  country: string;
  region?: string;
  regionCode?: string;
  city?: string;
  continent: string;
  topMode?: string;
  topFrequencyHz?: number | null;
}

interface ModeRow extends CountRow {
  mode: string;
}

interface FrequencyRow extends CountRow {
  frequencyHz: number;
}

interface MapPoint extends CountryRow {
  latitude: number;
  longitude: number;
}

interface TimelineRow {
  startMs: number;
  count: number;
}

interface Analytics {
  sessions: number;
  uniqueUsers: number;
  countries: number;
  regions: number;
  peakConcurrent: number;
  avgSessionSecs: number;
  concurrency: TimelineRow[];
  topCountries: CountryRow[];
  topRegions: CountryRow[];
  topModes: ModeRow[];
  topFrequencies: FrequencyRow[];
  mapPoints: MapPoint[];
}

type Range = '1h' | '24h' | '7d' | '30d' | '90d';

const RANGE_MS: Record<Range, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
};

function formatFrequency(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return '—';
  if (hz >= 1_000_000_000) return `${(hz / 1_000_000_000).toFixed(4)} GHz`;
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(4)} MHz`;
  if (hz >= 1_000) return `${(hz / 1_000).toFixed(1)} kHz`;
  return `${hz.toFixed(0)} Hz`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 120) return `${Math.round(seconds)}s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)}m`;
  const hours = seconds / 3600;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function countryFlag(code?: string): string {
  const cc = (code ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(...cc.split('').map((c) => 127397 + c.charCodeAt(0)));
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c] ?? c,
  );
}

function popupStyle(): string {
  return 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.45';
}

function heatColor(count: number, max: number): string {
  const ratio = max > 0 ? Math.min(1, count / max) : 0;
  const hue = 190 - ratio * 190; // cyan -> red
  return `hsl(${hue} 82% 55%)`;
}

const UserInsights: Component = () => {
  const [tab, setTab] = createSignal<'live' | 'history'>('live');
  const [range, setRange] = createSignal<Range>('24h');
  const [live, setLive] = createSignal<LiveResponse | null>(null);
  const [analytics, setAnalytics] = createSignal<Analytics | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [message, setMessage] = createSignal('');

  let mapEl: HTMLDivElement | undefined;
  let map: L.Map | undefined;
  let layer: L.LayerGroup | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let fitPending = true;
  let requestSeq = 0;
  let disposed = false;

  const setupMap = () => {
    if (!mapEl || map) return;
    map = L.map(mapEl, { worldCopyJump: true, zoomControl: true }).setView([20, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    layer = L.layerGroup().addTo(map);
    setTimeout(() => map?.invalidateSize(), 0);
  };

  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  const refresh = async () => {
    const seq = ++requestSeq;
    setLoading(true);
    setError('');
    try {
      if (tab() === 'live') {
        const res = await fetch('/api/admin/users/map', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as LiveResponse;
        if (disposed || seq !== requestSeq) return;
        setLive(data);
        drawLive(data.users);
      } else {
        const until = Date.now();
        const since = until - RANGE_MS[range()];
        const res = await fetch(
          `/api/admin/users/analytics?since=${since}&until=${until}`,
          { credentials: 'same-origin' },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as Analytics;
        if (disposed || seq !== requestSeq) return;
        setAnalytics(data);
        drawHistory(data.mapPoints);
      }
    } catch (cause) {
      if (!disposed && seq === requestSeq) {
        setError(cause instanceof Error ? cause.message : 'request failed');
      }
    } finally {
      if (!disposed && seq === requestSeq) setLoading(false);
    }
  };

  const drawLive = (users: LiveUser[]) => {
    if (!map || !layer) return;
    layer.clearLayers();
    const points: L.LatLngExpression[] = [];
    for (const user of users) {
      if (user.latitude == null || user.longitude == null) continue;
      const active = user.active;
      const marker = L.circleMarker([user.latitude, user.longitude], {
        radius: active ? 7 : 6,
        color: active ? '#22d3ee' : '#f59e0b',
        fillColor: active ? '#22d3ee' : '#f59e0b',
        fillOpacity: active ? 0.55 : 0.35,
        weight: 2,
      });
      marker.bindPopup(livePopup(user));
      marker.addTo(layer);
      points.push([user.latitude, user.longitude]);
    }
    fit(points);
  };

  const drawHistory = (points: MapPoint[]) => {
    if (!map || !layer) return;
    layer.clearLayers();
    const max = points.reduce((value, point) => Math.max(value, point.count), 0);
    const latlngs: L.LatLngExpression[] = [];
    for (const point of points) {
      const color = heatColor(point.count, max);
      const marker = L.circleMarker([point.latitude, point.longitude], {
        radius: 7 + Math.sqrt(point.count) * 5,
        color,
        fillColor: color,
        fillOpacity: 0.35,
        weight: 1.5,
      });
      marker.bindPopup(historyPopup(point));
      marker.addTo(layer);
      latlngs.push([point.latitude, point.longitude]);
    }
    fit(latlngs);
  };

  const fit = (points: L.LatLngExpression[]) => {
    if (!map || !fitPending || points.length === 0) return;
    fitPending = false;
    map.fitBounds(L.latLngBounds(points), { padding: [32, 32], maxZoom: 7 });
  };

  const livePopup = (user: LiveUser): string => {
    const state = user.active
      ? 'Online'
      : `Disconnected ${formatDuration((Date.now() - (user.disconnectedAtMs ?? user.lastSeenMs)) / 1000)} ago`;
    const location = [user.country, user.region, user.city].filter(Boolean).join(' · ');
    return `<div style="${popupStyle()}">
      <b>${countryFlag(user.countryCode)} ${escapeHtml(location || 'Unknown location')}</b><br>
      Frequency: <b>${formatFrequency(user.frequencyHz)}</b><br>
      Mode: <b>${escapeHtml((user.mode || '—').toUpperCase())}</b> · BW ${formatFrequency(user.bandwidth)}<br>
      Status: <b>${escapeHtml(state)}</b><br>
      IP: ${escapeHtml(user.realIp || user.ip || '—')}<br>
      Receiver: ${escapeHtml(user.dongleId || '—')} / ${escapeHtml(user.profileId || '—')}<br>
      Session: ${formatDuration((Date.now() - user.connectedAtMs) / 1000)}
    </div>`;
  };

  const historyPopup = (point: MapPoint): string => {
    const location = [point.country, point.region].filter(Boolean).join(' · ');
    return `<div style="${popupStyle()}">
      <b>${countryFlag(point.countryCode)} ${escapeHtml(location || 'Unknown region')}</b><br>
      Users: <b>${point.count}</b><br>
      Top mode: ${escapeHtml((point.topMode || '—').toUpperCase())}<br>
      Top frequency: ${formatFrequency(point.topFrequencyHz ?? 0)}
    </div>`;
  };

  const startPolling = () => {
    stopTimer();
    if (!disposed && tab() === 'live') {
      timer = setInterval(refresh, 10_000);
    }
  };

  const switchTab = (next: 'live' | 'history') => {
    if (tab() === next) return;
    fitPending = true;
    setTab(next);
    stopTimer();
    refresh().then(startPolling);
  };

  const switchRange = (next: Range) => {
    if (range() === next) return;
    fitPending = true;
    setRange(next);
    if (tab() === 'history') refresh();
  };

  const purge = async (all: boolean) => {
    if (all && !window.confirm('Delete all closed session history? Current users stay on the live map.')) return;
    setMessage('');
    try {
      const res = await fetch('/api/admin/users/purge', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(all ? { all: true } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setMessage(`Purged ${data.deleted ?? 0} session${data.deleted === 1 ? '' : 's'}.`);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'purge failed');
    }
  };

  onMount(() => {
    disposed = false;
    setupMap();
    refresh().then(startPolling);
    onCleanup(() => {
      disposed = true;
      requestSeq += 1;
      stopTimer();
      map?.remove();
      map = undefined;
      layer = undefined;
    });
  });

  const activeNow = () => live()?.users.filter((user) => user.active).length ?? 0;
  const recentDisconnected = () =>
    live()?.users.filter((user) => !user.active).length ?? 0;
  const maxTimeline = () =>
    analytics()?.concurrency.reduce((value, row) => Math.max(value, row.count), 0) ?? 0;

  return (
    <div class="space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <div class="flex rounded border border-border/40 overflow-hidden">
          <button
            onClick={() => switchTab('live')}
            class={`px-2 py-0.5 text-[10px] font-mono uppercase ${tab() === 'live' ? 'bg-cyan/15 text-cyan' : 'text-text-dim hover:text-text-primary'}`}
          >
            Live map
          </button>
          <button
            onClick={() => switchTab('history')}
            class={`px-2 py-0.5 text-[10px] font-mono uppercase border-l border-border/40 ${tab() === 'history' ? 'bg-cyan/15 text-cyan' : 'text-text-dim hover:text-text-primary'}`}
          >
            History
          </button>
        </div>
        <Show when={tab() === 'live'}>
          <span class="text-[9px] font-mono text-text-dim">
            {activeNow()} online · {recentDisconnected()} recent · last {live()?.recentMinutes ?? 60} min kept
          </span>
          <span class="text-[9px] font-mono text-cyan">● online</span>
          <span class="text-[9px] font-mono text-amber">● disconnected</span>
        </Show>
        <Show when={tab() === 'history'}>
          <select
            class="admin-input w-28"
            value={range()}
            onChange={(event) => switchRange(event.currentTarget.value as Range)}
          >
            <option value="1h">Last 1h</option>
            <option value="24h">Last 24h</option>
            <option value="7d">Last 7d</option>
            <option value="30d">Last 30d</option>
            <option value="90d">Last 90d</option>
          </select>
          <span class="text-[9px] font-mono text-text-dim">bubble size/colour = users per region</span>
        </Show>
        <div class="ml-auto flex items-center gap-1">
          <button
            onClick={refresh}
            disabled={loading()}
            class="px-2 py-0.5 text-[10px] font-mono uppercase rounded border border-border/50 text-text-dim hover:text-text-primary disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
      </div>

      <Show when={error()}>
        <div class="px-2 py-1 border border-red-400/20 bg-red-400/5 text-[10px] font-mono text-red-400">
          {error()}
        </div>
      </Show>
      <Show when={message()}>
        <div class="px-2 py-1 border border-cyan/20 bg-cyan/5 text-[10px] font-mono text-cyan">
          {message()}
        </div>
      </Show>

      <div class="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
        <Show when={tab() === 'live'}>
          <Stat label="Online now" value={String(activeNow())} />
          <Stat label="Recent disconnects" value={String(recentDisconnected())} />
        </Show>
        <Show when={tab() === 'history'}>
          <Stat label="Unique users" value={String(analytics()?.uniqueUsers ?? 0)} />
          <Stat label="Sessions" value={String(analytics()?.sessions ?? 0)} />
          <Stat label="Countries" value={String(analytics()?.countries ?? 0)} />
          <Stat label="Regions" value={String(analytics()?.regions ?? 0)} />
          <Stat label="Peak concurrent" value={String(analytics()?.peakConcurrent ?? 0)} />
        </Show>
      </div>

      <div
        ref={mapEl}
        class="w-full h-[380px] rounded border border-border/40 bg-sdr-base/40"
        style="min-height:380px"
      />

      <Show when={tab() === 'history' && analytics()}>
        {(data) => (
          <>
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-2">
              <div class="border border-border/30 rounded p-2">
                <div class="text-[9px] font-mono uppercase tracking-wider text-text-dim mb-1">
                  Concurrent users
                </div>
                <div class="flex items-end gap-px h-20">
                  <For each={data().concurrency}>
                    {(bucket) => (
                      <div
                        class="flex-1 min-w-px bg-cyan/45 hover:bg-cyan"
                        style={{
                          height:
                            bucket.count === 0
                              ? '0%'
                              : `${Math.max(2, (bucket.count / Math.max(1, maxTimeline())) * 100)}%`,
                        }}
                        title={`${new Date(bucket.startMs).toLocaleString()} · ${bucket.count} online`}
                      />
                    )}
                  </For>
                  <Show when={data().concurrency.length === 0}>
                    <span class="text-[9px] font-mono text-text-dim">No sessions in range.</span>
                  </Show>
                </div>
                <div class="text-[8px] font-mono text-text-dim mt-1">
                  Avg session {formatDuration(data().avgSessionSecs)}
                </div>
              </div>

              <div class="border border-border/30 rounded p-2">
                <div class="text-[9px] font-mono uppercase tracking-wider text-text-dim mb-1">
                  Top modes
                </div>
                <For each={data().topModes.slice(0, 8)}>
                  {(row) => (
                    <div class="flex items-center gap-2 text-[9px] font-mono">
                      <span class="w-14 uppercase text-text-secondary">{row.mode || '—'}</span>
                      <div class="flex-1 h-1.5 bg-border/20 rounded">
                        <div
                          class="h-full bg-cyan/60 rounded"
                          style={{
                            width: `${(row.count / Math.max(1, data().topModes[0]?.count ?? 1)) * 100}%`,
                          }}
                        />
                      </div>
                      <span class="text-text-dim w-8 text-right">{row.count}</span>
                    </div>
                  )}
                </For>
              </div>

              <div class="border border-border/30 rounded p-2">
                <div class="text-[9px] font-mono uppercase tracking-wider text-text-dim mb-1">
                  Top frequencies
                </div>
                <For each={data().topFrequencies.slice(0, 8)}>
                  {(row) => (
                    <div class="flex items-center gap-2 text-[9px] font-mono">
                      <span class="w-20 text-text-secondary">{formatFrequency(row.frequencyHz)}</span>
                      <div class="flex-1 h-1.5 bg-border/20 rounded">
                        <div
                          class="h-full bg-amber/60 rounded"
                          style={{
                            width: `${(row.count / Math.max(1, data().topFrequencies[0]?.count ?? 1)) * 100}%`,
                          }}
                        />
                      </div>
                      <span class="text-text-dim w-8 text-right">{row.count}</span>
                    </div>
                  )}
                </For>
              </div>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-2 gap-2">
              <Ranking title="Top countries" rows={data().topCountries} />
              <Ranking title="Top regions" rows={data().topRegions} />
            </div>

            <div class="flex flex-wrap items-center gap-2 pt-1 border-t border-border/20">
              <span class="text-[9px] font-mono text-text-dim">
                Closed sessions auto-purge after the configured retention (90 days default).
              </span>
              <button
                onClick={() => purge(false)}
                class="ml-auto px-2 py-0.5 text-[9px] font-mono uppercase rounded border border-amber/40 text-amber hover:bg-amber/10"
              >
                Purge old
              </button>
              <button
                onClick={() => purge(true)}
                class="px-2 py-0.5 text-[9px] font-mono uppercase rounded border border-red-400/40 text-red-400 hover:bg-red-400/10"
              >
                Clear history
              </button>
            </div>
          </>
        )}
      </Show>
    </div>
  );
};

const Stat: Component<{ label: string; value: string }> = (props) => (
  <div class="p-2 border border-border/30 rounded bg-sdr-base/50">
    <div class="text-[9px] font-mono uppercase tracking-wider text-text-dim">{props.label}</div>
    <div class="text-sm font-mono text-accent">{props.value}</div>
  </div>
);

const Ranking: Component<{ title: string; rows: CountryRow[] }> = (props) => (
  <div class="border border-border/30 rounded p-2">
    <div class="text-[9px] font-mono uppercase tracking-wider text-text-dim mb-1">
      {props.title}
    </div>
    <For each={props.rows.slice(0, 10)}>
      {(row) => (
        <div class="flex items-center gap-2 text-[9px] font-mono">
          <span class="min-w-0 flex-1 truncate text-text-secondary">
            {countryFlag(row.countryCode)} {row.country}
            <Show when={row.region}> · {row.region}</Show>
          </span>
          <div class="w-16 h-1.5 bg-border/20 rounded">
            <div
              class="h-full bg-cyan/60 rounded"
              style={{
                width: `${(row.count / Math.max(1, props.rows[0]?.count ?? 1)) * 100}%`,
              }}
            />
          </div>
          <span class="text-text-dim w-8 text-right">{row.count}</span>
        </div>
      )}
    </For>
    <Show when={props.rows.length === 0}>
      <span class="text-[9px] font-mono text-text-dim">No sessions in range.</span>
    </Show>
  </div>
);

export default UserInsights;
