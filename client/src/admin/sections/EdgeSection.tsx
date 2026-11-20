// ============================================================
// Cloudflare Edge Settings — DO fan-out config + live status
// ============================================================

import { Component, For, Show, createMemo, onCleanup, onMount } from 'solid-js';
import { adminStore } from '../admin-store';

const EdgeSection: Component = () => {
  const cfg = () => adminStore.edgeConfig();
  const status = () => adminStore.edgeStatus();

  const historyBytes = createMemo(() => cfg().history.bins * cfg().history.frames);
  const historySeconds = createMemo(() => (cfg().history.frames / 12).toFixed(1));

  onMount(() => {
    void adminStore.fetchEdgeStatus();
    const timer = setInterval(() => void adminStore.fetchEdgeStatus(), 3000);
    onCleanup(() => clearInterval(timer));
  });

  const toggleDongle = (id: string) => {
    const current = cfg().dongles;
    adminStore.updateEdgeField(
      'dongles',
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );
  };

  const statusLabel = () => {
    if (!cfg().enabled) return 'Disabled';
    const s = status();
    if (!s) return 'Not started';
    return s.publishers && Object.keys(s.publishers).length > 0 ? 'Configured' : 'No publishers';
  };

  return (
    <div class="max-w-2xl">
      <h2 class="text-sm font-mono uppercase tracking-wider text-text-primary mb-1">
        Cloudflare Edge
      </h2>
      <p class="text-[11px] font-mono text-text-dim mb-6">
        Serve the waterfall through a Cloudflare Durable Object; control and audio stay on this server.
      </p>

      <div class="space-y-8">
        <SettingsGroup title="Status" description="Origin-side publisher state (live)">
          <FieldRow label="State">
            <span class="text-[11px] font-mono text-text-primary">{statusLabel()}</span>
            <Show when={status()?.publishers}>
              <div class="mt-2 space-y-1">
                <For each={Object.entries(status()!.publishers ?? {})}>
                  {([dongle, p]) => (
                    <div class="text-[10px] font-mono text-text-dim">
                      <span class="text-text-primary">{dongle}</span>:{' '}
                      <span class={p.connected ? 'text-green' : 'text-amber'}>
                        {p.connected ? 'connected' : 'disconnected'}
                      </span>{' '}
                      · {p.framesSent} frames · {p.dropped} dropped · {p.reconnects} reconnects
                      <Show when={p.lastError}>
                        <div class="text-amber/80">{p.lastError}</div>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </FieldRow>
          <FieldRow label="Test">
            <button
              type="button"
              class="mil-btn px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider"
              disabled={adminStore.edgeTesting()}
              onClick={() => void adminStore.testEdge()}
            >
              {adminStore.edgeTesting() ? 'Testing…' : 'Test connection'}
            </button>
            <Show when={adminStore.edgeTestResult()}>
              <pre class="mt-2 p-2 bg-black/30 border border-border/40 text-[9px] font-mono text-text-dim overflow-auto max-h-40">
                {JSON.stringify(adminStore.edgeTestResult(), null, 2)}
              </pre>
            </Show>
          </FieldRow>
        </SettingsGroup>

        <SettingsGroup title="Connection" description="Worker URL and origin ingest authentication">
          <FieldRow label="Enable edge">
            <label class="flex items-center gap-2 text-[11px] font-mono text-text-primary">
              <input
                type="checkbox"
                checked={cfg().enabled}
                onChange={(e) => adminStore.updateEdgeField('enabled', e.currentTarget.checked)}
              />
              Publish FFT to Cloudflare
            </label>
          </FieldRow>
          <FieldRow label="Edge URL" help="Worker base URL, e.g. wss://fft.example.com">
            <input
              class="w-full bg-black/30 border border-border/60 px-2 py-1.5 text-[11px] font-mono text-text-primary"
              value={cfg().url}
              placeholder="wss://fft.example.com"
              onInput={(e) => adminStore.updateEdgeField('url', e.currentTarget.value)}
            />
          </FieldRow>
          <FieldRow label="Instance ID" help="Stable name used in the edge topic path">
            <input
              class="w-full bg-black/30 border border-border/60 px-2 py-1.5 text-[11px] font-mono text-text-primary"
              value={cfg().instanceId}
              placeholder="home-berlin"
              onInput={(e) => adminStore.updateEdgeField('instanceId', e.currentTarget.value)}
            />
          </FieldRow>
          <FieldRow
            label="Ingest token"
            help={cfg().hasIngestToken ? 'Configured; type a new value to replace it' : 'Must match the Worker secret'}
          >
            <input
              type="password"
              class="w-full bg-black/30 border border-border/60 px-2 py-1.5 text-[11px] font-mono text-text-primary"
              value={cfg().ingestToken}
              placeholder={cfg().hasIngestToken ? '••••••••' : 'Bearer token'}
              onInput={(e) => adminStore.updateEdgeField('ingestToken', e.currentTarget.value)}
            />
          </FieldRow>
          <FieldRow label="Codec" help="Edge FFT codec; the DO decodes it for history">
            <select
              class="w-full bg-black/30 border border-border/60 px-2 py-1.5 text-[11px] font-mono text-text-primary"
              value={cfg().codec}
              onChange={(e) => adminStore.updateEdgeField('codec', e.currentTarget.value)}
            >
              <option value="range">range (0x10, smallest)</option>
              <option value="deflate-smooth">deflate-smooth (0x0B)</option>
            </select>
          </FieldRow>
          <FieldRow label="Max viewers / DO" help="Reject new viewers above this per-dongle cap">
            <input
              type="number"
              class="w-32 bg-black/30 border border-border/60 px-2 py-1.5 text-[11px] font-mono text-text-primary"
              value={cfg().maxViewers}
              min={1}
              max={1000}
              onInput={(e) => adminStore.updateEdgeField('maxViewers', Number(e.currentTarget.value))}
            />
          </FieldRow>
        </SettingsGroup>

        <SettingsGroup title="Dongles" description="Empty selection publishes every configured dongle">
          <div class="space-y-1">
            <For each={adminStore.dongles()}>
              {(dongle) => (
                <label class="flex items-center gap-2 text-[11px] font-mono text-text-primary">
                  <input
                    type="checkbox"
                    checked={cfg().dongles.includes(dongle.id)}
                    onChange={() => toggleDongle(dongle.id)}
                  />
                  {dongle.name || dongle.id}
                </label>
              )}
            </For>
            <Show when={adminStore.dongles().length === 0}>
              <p class="text-[10px] font-mono text-text-dim">No dongles configured.</p>
            </Show>
          </div>
        </SettingsGroup>

        <SettingsGroup title="History" description="DO-side ring served to new viewers">
          <FieldRow label="Mode">
            <select
              class="w-full bg-black/30 border border-border/60 px-2 py-1.5 text-[11px] font-mono text-text-primary"
              value={cfg().history.mode}
              onChange={(e) =>
                adminStore.updateEdgeHistory(
                  'mode',
                  e.currentTarget.value as 'do-ring' | 'origin-snapshot' | 'off',
                )
              }
            >
              <option value="do-ring">DO ring (decode live frames)</option>
              <option value="off">Off</option>
            </select>
          </FieldRow>
          <FieldRow label="History bins">
            <select
              class="w-full bg-black/30 border border-border/60 px-2 py-1.5 text-[11px] font-mono text-text-primary"
              value={String(cfg().history.bins)}
              onChange={(e) => adminStore.updateEdgeHistory('bins', Number(e.currentTarget.value))}
            >
              <option value="1024">1024</option>
              <option value="2048">2048</option>
              <option value="4096">4096</option>
            </select>
          </FieldRow>
          <FieldRow label="History frames" help={`≈ ${historySeconds()} s at 12 fps`}>
            <input
              type="number"
              class="w-32 bg-black/30 border border-border/60 px-2 py-1.5 text-[11px] font-mono text-text-primary"
              value={cfg().history.frames}
              min={32}
              max={2048}
              onInput={(e) => adminStore.updateEdgeHistory('frames', Number(e.currentTarget.value))}
            />
          </FieldRow>
          <FieldRow label="Ring memory">
            <span class="text-[11px] font-mono text-text-dim">
              {(historyBytes() / 1_000_000).toFixed(2)} MB per dongle
            </span>
          </FieldRow>
        </SettingsGroup>

        <SettingsGroup title="Client fallback" description="When the edge is unavailable, return to origin FFT">
          <FieldRow label="Default transport">
            <select
              class="w-full bg-black/30 border border-border/60 px-2 py-1.5 text-[11px] font-mono text-text-primary"
              value={cfg().clientDefaultTransport}
              onChange={(e) =>
                adminStore.updateEdgeField(
                  'clientDefaultTransport',
                  e.currentTarget.value as 'auto' | 'origin' | 'edge',
                )
              }
            >
              <option value="auto">Auto (edge, then origin)</option>
              <option value="origin">Origin only</option>
              <option value="edge">Edge preferred</option>
            </select>
          </FieldRow>
          <FieldRow label="Connect timeout">
            <NumberInput
              value={cfg().fallback.connectTimeoutMs}
              onChange={(v) => adminStore.updateEdgeFallback('connectTimeoutMs', v)}
              min={500}
              max={30000}
            />
          </FieldRow>
          <FieldRow label="First frame">
            <NumberInput
              value={cfg().fallback.firstFrameTimeoutMs}
              onChange={(v) => adminStore.updateEdgeFallback('firstFrameTimeoutMs', v)}
              min={500}
              max={30000}
            />
          </FieldRow>
          <FieldRow label="Stale stream">
            <NumberInput
              value={cfg().fallback.staleTimeoutMs}
              onChange={(v) => adminStore.updateEdgeFallback('staleTimeoutMs', v)}
              min={1000}
              max={60000}
            />
          </FieldRow>
          <FieldRow label="Retry interval">
            <NumberInput
              value={cfg().fallback.retryMs}
              onChange={(v) => adminStore.updateEdgeFallback('retryMs', v)}
              min={5000}
              max={300000}
            />
          </FieldRow>
        </SettingsGroup>

        <div class="px-3 py-2 bg-amber/5 border border-amber/20 rounded-sm">
          <p class="text-[10px] font-mono text-amber uppercase tracking-wider">
            Free-tier target: one dongle at 12 fps, ~51.8k DO requests/day, ~10.8k GB-s/day,
            ~1 MB history per viewer. Measure the raw-vs-billed quota before enabling publicly.
          </p>
        </div>

        <Show when={adminStore.saveError()}>
          <p class="text-[10px] font-mono text-red">{adminStore.saveError()}</p>
        </Show>
      </div>
    </div>
  );
};

// ---- Local form primitives (match GeneralSection's visual language) ----

const SettingsGroup: Component<{ title: string; description: string; children: any }> = (props) => (
  <div class="pb-6 border-b border-border/40 last:border-b-0">
    <h3 class="text-[12px] font-mono uppercase tracking-wider text-text-secondary mb-0.5">
      {props.title}
    </h3>
    <p class="text-[10px] font-mono text-text-dim mb-4">{props.description}</p>
    <div class="space-y-3">{props.children}</div>
  </div>
);

const FieldRow: Component<{ label: string; help?: string; children: any }> = (props) => (
  <div class="flex items-start gap-4">
    <div class="w-36 shrink-0 pt-2">
      <label class="text-[11px] font-mono text-text-primary">{props.label}</label>
      <Show when={props.help}>
        <p class="text-[9px] font-mono text-text-dim mt-0.5">{props.help}</p>
      </Show>
    </div>
    <div class="flex-1">{props.children}</div>
  </div>
);

const NumberInput: Component<{
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}> = (props) => (
  <input
    type="number"
    class="w-32 bg-black/30 border border-border/60 px-2 py-1.5 text-[11px] font-mono text-text-primary"
    value={props.value}
    min={props.min}
    max={props.max}
    onInput={(e) => props.onChange(Number(e.currentTarget.value))}
  />
);

export default EdgeSection;
