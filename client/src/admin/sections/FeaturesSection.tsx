// ============================================================
// Features Section — Build info, supported codecs, SDR hardware, demodulators
// ============================================================

import { Component, createSignal, onMount, For, Show } from 'solid-js';

interface SystemInfo {
  version: string;
  goVersion: string;
  os: string;
  arch: string;
  uptime: number;
  memory: {
    allocMB: number;
    sysMB: number;
    numGC: number;
    goroutines: number;
  };
  features: {
    opusSupport: boolean;
    rtlsdrNative: boolean;
    allowedFftCodecs: string[];
    allowedIqCodecs: string[];
    supportedSources: string[];
    supportedModes: string[];
    supportedFftCodecs: string[];
    supportedIqCodecs: string[];
  };
  dongles: {
    configured: number;
    clients: number;
  };
  dongleStates?: Record<string, any>;
}

// ---- Helpers ----
function formatUptime(secs: number): string {
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

// ---- Sub-components ----

const InfoGroup: Component<{ title: string; children: any }> = (props) => (
  <div class="space-y-2">
    <h3 class="text-[9px] font-mono uppercase tracking-wider text-text-dim border-b border-border/30 pb-1">
      {props.title}
    </h3>
    {props.children}
  </div>
);

const InfoRow: Component<{ label: string; value: string; accent?: boolean }> = (props) => (
  <div class="flex items-center justify-between py-0.5">
    <span class="text-[10px] font-mono text-text-dim">{props.label}</span>
    <span class={`text-[10px] font-mono ${props.accent ? 'text-accent' : 'text-text-primary'}`}>
      {props.value}
    </span>
  </div>
);

const FeatureBadge: Component<{ name: string; enabled: boolean }> = (props) => (
  <span
    class={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-mono uppercase border ${
      props.enabled
        ? 'text-green-400 border-green-400/30 bg-green-400/5'
        : 'text-text-dim/50 border-border/30 bg-sdr-base/30'
    }`}
  >
    <span class={`w-1.5 h-1.5 rounded-full ${props.enabled ? 'bg-green-400' : 'bg-text-dim/30'}`} />
    {props.name}
  </span>
);

const CodecList: Component<{ codecs: string[]; allowed: string[]; label: string }> = (props) => (
  <div class="space-y-1">
    <span class="text-[9px] font-mono uppercase tracking-wider text-text-dim">{props.label}</span>
    <div class="flex flex-wrap gap-1">
      <For each={props.codecs}>
        {(codec) => {
          const isAllowed = props.allowed.includes(codec);
          return (
            <span
              class={`px-1.5 py-0.5 rounded text-[9px] font-mono border ${
                isAllowed
                  ? 'text-accent border-accent/30 bg-accent/5'
                  : 'text-text-dim/40 border-border/20 bg-sdr-base/20 line-through'
              }`}
            >
              {codec}
            </span>
          );
        }}
      </For>
    </div>
  </div>
);

const SourceList: Component<{ sources: string[] }> = (props) => (
  <div class="flex flex-wrap gap-1.5">
    <For each={props.sources}>
      {(src) => (
        <span class="px-2 py-0.5 rounded text-[9px] font-mono uppercase border border-border/30 text-text-primary bg-sdr-base/30">
          {src}
        </span>
      )}
    </For>
  </div>
);

const ModeList: Component<{ modes: string[] }> = (props) => (
  <div class="flex flex-wrap gap-1.5">
    <For each={props.modes}>
      {(mode) => (
        <span class="px-2 py-0.5 rounded text-[9px] font-mono uppercase border border-accent/20 text-accent bg-accent/5">
          {mode}
        </span>
      )}
    </For>
  </div>
);

// ---- Main Section ----
const FeaturesSection: Component = () => {
  const [info, setInfo] = createSignal<SystemInfo | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');

  async function fetchSystemInfo() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/system-info', { credentials: 'same-origin' });
      if (res.ok) {
        setInfo(await res.json());
      } else {
        setError(`HTTP ${res.status}`);
      }
    } catch (e) {
      setError('Connection error');
    }
    setLoading(false);
  }

  onMount(fetchSystemInfo);

  return (
    <div class="max-w-2xl">
      <div class="flex items-center justify-between mb-4">
        <div>
          <h2 class="text-sm font-mono uppercase tracking-wider text-text-primary mb-0.5">Feature Report</h2>
          <p class="text-[9px] font-mono text-text-dim">
            Build info, supported codecs, SDR hardware, and demodulators
          </p>
        </div>
        <button
          class="px-2 py-0.5 text-[9px] font-mono uppercase rounded border border-border/50 text-text-dim hover:text-text-primary hover:border-accent/50 transition-colors"
          onClick={fetchSystemInfo}
        >
          Refresh
        </button>
      </div>

      {/* Loading */}
      <Show when={loading()}>
        <div class="flex items-center justify-center h-32">
          <span class="text-[9px] font-mono text-text-dim uppercase animate-pulse">Loading system info...</span>
        </div>
      </Show>

      {/* Error */}
      <Show when={!loading() && error()}>
        <div class="p-3 border border-red-400/30 rounded-md bg-red-400/5">
          <span class="text-[9px] font-mono text-red-400">Failed to load: {error()}</span>
        </div>
      </Show>

      {/* Content */}
      <Show when={!loading() && info()}>
        {(data) => (
          <div class="space-y-5">
            {/* Build Info */}
            <InfoGroup title="Build Information">
              <InfoRow label="Version" value={data().version} accent />
              <InfoRow label="Go Version" value={data().goVersion} />
              <InfoRow label="Platform" value={`${data().os}/${data().arch}`} />
              <InfoRow label="Uptime" value={formatUptime(data().uptime)} />
            </InfoGroup>

            {/* Runtime */}
            <InfoGroup title="Runtime">
              <InfoRow label="Memory (allocated)" value={`${data().memory.allocMB.toFixed(1)} MB`} />
              <InfoRow label="Memory (system)" value={`${data().memory.sysMB.toFixed(1)} MB`} />
              <InfoRow label="Goroutines" value={String(data().memory.goroutines)} />
              <InfoRow label="GC Cycles" value={String(data().memory.numGC)} />
            </InfoGroup>

            {/* Compile-time Features */}
            <InfoGroup title="Compile-time Features">
              <div class="flex flex-wrap gap-2 py-1">
                <FeatureBadge name="Opus (libopus)" enabled={data().features.opusSupport} />
                <FeatureBadge name="RTL-SDR Native" enabled={data().features.rtlsdrNative} />
              </div>
            </InfoGroup>

            {/* Codecs */}
            <InfoGroup title="Codecs">
              <div class="space-y-3 py-1">
                <CodecList
                  codecs={data().features.supportedFftCodecs}
                  allowed={data().features.allowedFftCodecs}
                  label="FFT Codecs (enabled = active)"
                />
                <CodecList
                  codecs={data().features.supportedIqCodecs}
                  allowed={data().features.allowedIqCodecs}
                  label="IQ Codecs (enabled = active)"
                />
              </div>
            </InfoGroup>

            {/* SDR Sources */}
            <InfoGroup title="Supported SDR Sources">
              <div class="py-1">
                <SourceList sources={data().features.supportedSources} />
              </div>
            </InfoGroup>

            {/* Demodulation Modes */}
            <InfoGroup title="Demodulation Modes">
              <div class="py-1">
                <ModeList modes={data().features.supportedModes} />
              </div>
            </InfoGroup>

            {/* Dongles Summary */}
            <InfoGroup title="Current State">
              <InfoRow label="Configured dongles" value={String(data().dongles.configured)} />
              <InfoRow label="Connected clients" value={String(data().dongles.clients)} accent />
            </InfoGroup>
          </div>
        )}
      </Show>
    </div>
  );
};

export default FeaturesSection;
