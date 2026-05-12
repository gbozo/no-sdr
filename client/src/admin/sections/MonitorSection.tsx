// ============================================================
// Monitor Section — Active clients, resource usage, streaming stats
// ============================================================

import { Component, createSignal, onMount, onCleanup, For, Show } from 'solid-js';

interface ClientInfo {
  id: string;
  persistentId: string;
  connIndex: number;
  ip: string;
  realIp?: string;  // raw proxy header value; present only when behind a proxy
  dongleId: string;
  dongleName?: string;
  profileId: string;
  profileName?: string;
  centerFrequency?: number;
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
  cpuCores: number;
  cpuUsage: number;
}

interface GpuStats {
  active: boolean;
  fftFrames: number;
  iqDispatches: number;
  fmDispatches: number;
  iqPipelineReady: boolean;
  fmPipelineReady: boolean;
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

function formatFrequency(hz: number): string {
  if (hz >= 1_000_000_000) return `${(hz / 1_000_000_000).toFixed(3)} GHz`;
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(3)} MHz`;
  if (hz >= 1_000) return `${(hz / 1_000).toFixed(1)} kHz`;
  return `${hz} Hz`;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ---- Sub-components ----

const StatCard: Component<{ label: string; value: string; sub?: string; accent?: boolean }> = (props) => (
  <div class="p-2.5 border border-border/30 rounded-md bg-sdr-base/50">
    <div class="text-[9px] font-mono uppercase tracking-wider text-text-dim mb-1">{props.label}</div>
    <div class={`text-sm font-mono ${props.accent ? 'text-green-400' : 'text-accent'}`}>{props.value}</div>
    <Show when={props.sub}>
      <div class="text-[8px] font-mono text-text-dim/50 mt-0.5">{props.sub}</div>
    </Show>
  </div>
);

const ClientRow: Component<{ client: ClientInfo }> = (props) => (
  <div class="p-2 border border-border/20 rounded bg-sdr-base/30 hover:bg-sdr-base/50 transition-colors">
    {/* Row 1: Status + ID + Receiver/Profile + Mode + Codecs + Duration */}
    <div class="flex items-center gap-2">
      {/* Status LED */}
      <div class="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />

      {/* Client ID (persistent, 8 chars + conn index) */}
      <div class="w-20 shrink-0">
        <span class="text-[9px] font-mono text-text-dim">
          {props.client.persistentId?.slice(0, 8) || props.client.id.slice(0, 8)}
          <Show when={props.client.connIndex > 0}>
            <span class="text-text-dim/50">:{props.client.connIndex}</span>
          </Show>
        </span>
      </div>

      {/* Dongle + Profile + Frequency */}
      <div class="w-44 shrink-0">
        <Show when={props.client.dongleName || props.client.dongleId} fallback={
          <span class="text-[9px] font-mono text-text-dim/40">—</span>
        }>
          <div class="text-[9px] font-mono text-text-primary truncate">
            {props.client.dongleName || props.client.dongleId}
          </div>
          <Show when={props.client.profileName || props.client.centerFrequency}>
            <div class="text-[8px] font-mono text-accent/80 truncate">
              {props.client.profileName || props.client.profileId}
              <Show when={props.client.centerFrequency}>
                {' '}<span class="text-text-dim">@ {formatFrequency(props.client.centerFrequency!)}</span>
              </Show>
            </div>
          </Show>
        </Show>
      </div>

      {/* Mode */}
      <div class="w-10 shrink-0">
        <Show when={props.client.mode}>
          <span class="text-[9px] font-mono uppercase text-accent">{props.client.mode}</span>
        </Show>
      </div>

      {/* Codecs */}
      <div class="flex-1 flex gap-1.5 flex-wrap">
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

    {/* Row 2: IP address (full width, handles IPv6 gracefully) */}
    <div class="flex items-center gap-2 mt-1 pl-[22px]">
      <span class="text-[9px] font-mono text-text-dim/70 break-all">
        {props.client.realIp || props.client.ip}
      </span>
      <Show when={props.client.realIp}>
        <span class="text-[8px] font-mono text-text-dim/40 break-all">
          (tcp: {props.client.ip})
        </span>
      </Show>
    </div>
  </div>
);

// ---- Main Section ----
const MonitorSection: Component = () => {
  const [clients, setClients] = createSignal<ClientInfo[]>([]);
  const [stats, setStats] = createSignal<SystemStats | null>(null);
  const [gpuStats, setGpuStats] = createSignal<GpuStats | null>(null);
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
          cpuCores: data.cpu?.cores || 0,
          cpuUsage: data.cpu?.usagePerc || 0,
        });
        if (data.gpu?.stats) {
          setGpuStats(data.gpu.stats);
        } else {
          setGpuStats(null);
        }
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
    <div class="max-w-4xl">
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
            <div class="grid grid-cols-5 gap-2 mb-5">
              <StatCard label="Clients" value={String(clients().length)} sub="connected" />
              <StatCard label="CPU" value={`${s().cpuUsage.toFixed(0)}%`} sub={`${s().cpuCores} cores`} />
              <StatCard label="Memory" value={`${s().allocMB.toFixed(1)} MB`} sub={`${s().sysMB.toFixed(0)} MB sys`} />
              <StatCard label="Goroutines" value={String(s().goroutines)} />
              <StatCard label="Uptime" value={formatDuration(s().uptime)} sub={`${s().numGC} GCs`} />
            </div>
          )}
        </Show>

        {/* GPU Stats */}
        <Show when={gpuStats()}>
          {(g) => (
            <div class="mb-5 p-3 border border-border/30 rounded-md bg-sdr-base/50">
              <div class="flex items-center gap-2 mb-2">
                <h3 class="text-[9px] font-mono uppercase tracking-wider text-text-dim">GPU Offload</h3>
                <span class={`px-1.5 py-0.5 text-[8px] font-mono rounded border ${g().active ? 'bg-green-400/10 text-green-400 border-green-400/20' : 'bg-red-400/10 text-red-400 border-red-400/20'}`}>
                  {g().active ? 'ACTIVE' : 'PAUSED'}
                </span>
              </div>
              <div class="grid grid-cols-3 gap-3">
                <div>
                  <div class="text-[8px] font-mono text-text-dim/70 uppercase">FFT Frames</div>
                  <div class="text-[11px] font-mono text-accent">{formatCount(g().fftFrames)}</div>
                </div>
                <div>
                  <div class="text-[8px] font-mono text-text-dim/70 uppercase">IQ Dispatches</div>
                  <div class="text-[11px] font-mono text-accent">{formatCount(g().iqDispatches)}</div>
                </div>
                <div>
                  <div class="text-[8px] font-mono text-text-dim/70 uppercase">FM Dispatches</div>
                  <div class="text-[11px] font-mono text-accent">{formatCount(g().fmDispatches)}</div>
                </div>
              </div>
              <div class="flex gap-3 mt-2">
                <span class={`text-[8px] font-mono ${g().iqPipelineReady ? 'text-green-400/70' : 'text-text-dim/40'}`}>
                  IQ Pipeline: {g().iqPipelineReady ? 'Ready' : 'N/A'}
                </span>
                <span class={`text-[8px] font-mono ${g().fmPipelineReady ? 'text-green-400/70' : 'text-text-dim/40'}`}>
                  FM Pipeline: {g().fmPipelineReady ? 'Ready' : 'N/A'}
                </span>
              </div>
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
              <div class="w-20 shrink-0">Client</div>
              <div class="w-44 shrink-0">Receiver / Profile</div>
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
