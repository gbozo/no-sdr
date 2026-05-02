// ============================================================
// Monitor Section — Active clients, resource usage, streaming stats
// ============================================================

import { Component, createSignal, onMount, onCleanup, For, Show } from 'solid-js';

interface ClientInfo {
  id: string;
  ip: string;
  dongleId: string;
  fftCodec: string;
  iqCodec: string;
  mode: string;
  tuneOffset: number;
  bandwidth: number;
  audioEnabled: boolean;
  connectedAt: string;
}

interface SystemStats {
  allocMB: number;
  sysMB: number;
  goroutines: number;
  numGC: number;
  uptime: number;
}

// ---- Helpers ----
function formatDuration(isoOrSecs: string | number): string {
  let ms: number;
  if (typeof isoOrSecs === 'string') {
    ms = Date.now() - new Date(isoOrSecs).getTime();
  } else {
    ms = isoOrSecs * 1000;
  }
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

// ---- Sub-components ----

const StatCard: Component<{ label: string; value: string; sub?: string }> = (props) => (
  <div class="p-2.5 border border-border/30 rounded-md bg-sdr-base/50">
    <div class="text-[9px] font-mono uppercase tracking-wider text-text-dim mb-1">{props.label}</div>
    <div class="text-sm font-mono text-accent">{props.value}</div>
    <Show when={props.sub}>
      <div class="text-[8px] font-mono text-text-dim/50 mt-0.5">{props.sub}</div>
    </Show>
  </div>
);

const ClientRow: Component<{ client: ClientInfo }> = (props) => (
  <div class="flex items-center gap-2 p-2 border border-border/20 rounded bg-sdr-base/30 hover:bg-sdr-base/50 transition-colors">
    {/* Status LED */}
    <div class="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />

    {/* IP */}
    <div class="w-28 shrink-0">
      <span class="text-[10px] font-mono text-text-primary">{props.client.ip}</span>
    </div>

    {/* Dongle */}
    <div class="w-24 shrink-0">
      <span class="text-[9px] font-mono text-text-dim">
        {props.client.dongleId || '—'}
      </span>
    </div>

    {/* Mode */}
    <div class="w-10 shrink-0">
      <Show when={props.client.mode}>
        <span class="text-[9px] font-mono uppercase text-accent">{props.client.mode}</span>
      </Show>
    </div>

    {/* Codecs */}
    <div class="flex-1 flex gap-1.5">
      <Show when={props.client.fftCodec}>
        <span class="text-[8px] font-mono px-1 py-0.5 rounded border border-border/20 text-text-dim">
          fft:{props.client.fftCodec}
        </span>
      </Show>
      <Show when={props.client.iqCodec}>
        <span class="text-[8px] font-mono px-1 py-0.5 rounded border border-border/20 text-text-dim">
          iq:{props.client.iqCodec}
        </span>
      </Show>
      <Show when={props.client.audioEnabled}>
        <span class="text-[8px] font-mono px-1 py-0.5 rounded border border-green-400/20 text-green-400/80">
          audio
        </span>
      </Show>
    </div>

    {/* Connected duration */}
    <div class="w-16 shrink-0 text-right">
      <span class="text-[9px] font-mono text-text-dim">{formatDuration(props.client.connectedAt)}</span>
    </div>
  </div>
);

// ---- Main Section ----
const MonitorSection: Component = () => {
  const [clients, setClients] = createSignal<ClientInfo[]>([]);
  const [stats, setStats] = createSignal<SystemStats | null>(null);
  const [loading, setLoading] = createSignal(true);
  let pollInterval: ReturnType<typeof setInterval>;

  async function fetchData() {
    try {
      const [clientsRes, infoRes] = await Promise.all([
        fetch('/api/admin/clients', { credentials: 'same-origin' }),
        fetch('/api/admin/system-info', { credentials: 'same-origin' }),
      ]);
      if (clientsRes.ok) {
        const data = await clientsRes.json();
        setClients(Array.isArray(data) ? data : []);
      }
      if (infoRes.ok) {
        const data = await infoRes.json();
        setStats({
          allocMB: data.memory?.allocMB || 0,
          sysMB: data.memory?.sysMB || 0,
          goroutines: data.memory?.goroutines || 0,
          numGC: data.memory?.numGC || 0,
          uptime: data.uptime || 0,
        });
      }
    } catch {}
    setLoading(false);
  }

  onMount(() => {
    fetchData();
    pollInterval = setInterval(fetchData, 5000); // 5s polling for admin
  });

  onCleanup(() => {
    if (pollInterval) clearInterval(pollInterval);
  });

  return (
    <div class="max-w-3xl">
      <div class="flex items-center justify-between mb-4">
        <div>
          <h2 class="text-sm font-mono uppercase tracking-wider text-text-primary mb-0.5">System Monitor</h2>
          <p class="text-[9px] font-mono text-text-dim">
            Active clients, resource usage, and streaming stats — auto-refreshes every 5s
          </p>
        </div>
        <button
          class="px-2 py-0.5 text-[9px] font-mono uppercase rounded border border-border/50 text-text-dim hover:text-text-primary hover:border-accent/50 transition-colors"
          onClick={fetchData}
        >
          Refresh
        </button>
      </div>

      {/* Loading */}
      <Show when={loading()}>
        <div class="flex items-center justify-center h-32">
          <span class="text-[9px] font-mono text-text-dim uppercase animate-pulse">Loading...</span>
        </div>
      </Show>

      <Show when={!loading()}>
        {/* Stats Grid */}
        <Show when={stats()}>
          {(s) => (
            <div class="grid grid-cols-4 gap-2 mb-5">
              <StatCard label="Clients" value={String(clients().length)} sub="connected" />
              <StatCard label="Memory" value={`${s().allocMB.toFixed(1)} MB`} sub={`${s().sysMB.toFixed(0)} MB sys`} />
              <StatCard label="Goroutines" value={String(s().goroutines)} />
              <StatCard label="Uptime" value={formatDuration(s().uptime)} sub={`${s().numGC} GCs`} />
            </div>
          )}
        </Show>

        {/* Connected Clients */}
        <div class="space-y-1.5">
          <div class="flex items-center gap-2 mb-2">
            <h3 class="text-[9px] font-mono uppercase tracking-wider text-text-dim">
              Connected Clients
            </h3>
            <span class="px-1.5 py-0.5 text-[8px] font-mono rounded bg-accent/10 text-accent border border-accent/20">
              {clients().length}
            </span>
          </div>

          {/* Empty state */}
          <Show when={clients().length === 0}>
            <div class="flex items-center justify-center h-20 border border-border/20 rounded-md bg-sdr-base/20">
              <span class="text-[9px] font-mono text-text-dim/50 uppercase">No clients connected</span>
            </div>
          </Show>

          {/* Header */}
          <Show when={clients().length > 0}>
            <div class="flex items-center gap-2 px-2 py-1 text-[8px] font-mono uppercase tracking-wider text-text-dim/50">
              <div class="w-1.5 shrink-0" />
              <div class="w-28 shrink-0">IP</div>
              <div class="w-24 shrink-0">Dongle</div>
              <div class="w-10 shrink-0">Mode</div>
              <div class="flex-1">Codecs</div>
              <div class="w-16 shrink-0 text-right">Duration</div>
            </div>
          </Show>

          {/* Client rows */}
          <For each={clients()}>
            {(client) => <ClientRow client={client} />}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default MonitorSection;
