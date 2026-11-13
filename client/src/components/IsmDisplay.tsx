// ============================================================
// node-sdr — ISM sensor / meter workspace
// ============================================================
// Device table on the left, selected device details on the right. The server
// re-sends the whole device table about twice a second and a status snapshot
// with the channel plan.

import { Component, For, Show, createMemo, createSignal } from 'solid-js';
import { store } from '../store/index.js';
import type { IsmDevice } from '~/shared';

function formatTime(at: number): string {
  if (!at) return '—';
  return new Date(at * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatHz(hz: number): string {
  return `${(hz / 1e6).toFixed(3)} MHz`;
}

const IsmDisplay: Component = () => {
  const [selectedId, setSelectedId] = createSignal<number | null>(null);

  const devices = createMemo(() =>
    [...store.ismDevices()].sort((a, b) => b.lastAt - a.lastAt)
  );
  const status = () => store.ismStatus();
  const selected = createMemo(() => {
    const wanted = selectedId();
    if (wanted == null) return null;
    return devices().find((d) => d.id === wanted) ?? null;
  });
  const liveChannels = () =>
    (status()?.channels ?? []).filter((channel) => channel.live);

  return (
    <div class="flex-1 min-h-0 flex flex-col md:flex-row">
      {/* Device table */}
      <div class="flex flex-col min-w-0 min-h-0 md:w-[54%] border-b md:border-b-0 md:border-r border-border/40">
        <div class="shrink-0 px-2 py-1 border-b border-border/30 text-[8px] font-mono leading-relaxed">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-text-dim">
            <span class="uppercase tracking-wider text-text-secondary">ISM</span>
            <span>{devices().length} DEVICES</span>
            <span>{status()?.decodes ?? 0} DECODES</span>
            <span>{status()?.bursts ?? 0} BURSTS</span>
            <span>
              {liveChannels().length}/{status()?.channels.length ?? 0} CHANNELS
            </span>
            <span class={status()?.unavailable ? 'text-amber' : 'text-green-400'}>
              {status()?.unavailable ? 'UNAVAILABLE' : 'LISTENING'}
            </span>
          </div>
          <Show when={status()?.unavailable}>
            <div class="text-amber/90 mt-0.5">
              {status()?.unavailable}
              {status()?.suggestCenterHz
                ? ` — tune near ${formatHz(status()!.suggestCenterHz!)}`
                : ''}
            </div>
          </Show>
        </div>

        <div class="flex-1 min-h-0 overflow-auto">
          <table class="w-full text-[8px] font-mono">
            <thead class="sticky top-0 z-10 bg-sdr-surface">
              <tr>
                <th class="text-left px-1.5 py-1 text-text-dim">TIME</th>
                <th class="text-left px-1.5 py-1 text-text-dim">KIND</th>
                <th class="text-left px-1.5 py-1 text-text-dim">DEVICE</th>
                <th class="text-right px-1.5 py-1 text-text-dim">MHz</th>
                <th class="text-right px-1.5 py-1 text-text-dim">SNR</th>
                <th class="text-right px-1.5 py-1 text-text-dim">N</th>
                <th class="text-left px-1.5 py-1 text-text-dim">READINGS</th>
              </tr>
            </thead>
            <tbody>
              <For each={devices()}>
                {(device) => {
                  const active = () => selectedId() === device.id;
                  return (
                    <tr
                      onClick={() => setSelectedId(active() ? null : device.id)}
                      class={`border-t border-border/20 cursor-pointer ${
                        active() ? 'bg-cyan/10 text-cyan' : ''
                      } hover:bg-cyan/5`}
                    >
                      <td class="px-1.5 py-1 whitespace-nowrap text-text-dim">
                        {formatTime(device.lastAt)}
                      </td>
                      <td class="px-1.5 py-1 whitespace-nowrap text-text-primary">
                        {device.kind}
                      </td>
                      <td class="px-1.5 py-1 whitespace-nowrap text-text-secondary">
                        {device.device}
                      </td>
                      <td class="px-1.5 py-1 whitespace-nowrap text-right text-text-dim">
                        {(device.freqHz / 1e6).toFixed(3)}
                      </td>
                      <td class="px-1.5 py-1 whitespace-nowrap text-right text-text-dim">
                        {device.snrDb} dB
                      </td>
                      <td class="px-1.5 py-1 whitespace-nowrap text-right text-text-dim">
                        {device.count}
                      </td>
                      <td class="px-1.5 py-1 text-text-secondary break-words">
                        {device.readingsText || (device.encrypted ? 'encrypted' : '—')}
                      </td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>

          <Show when={devices().length === 0}>
            <div class="px-2 py-3 text-[8px] font-mono text-text-dim">
              Waiting for an ISM device. Tune the receiver near 868.95 MHz with
              a window wide enough to cover the 868 MHz sensor and meter
              channels. Weather sensors, wireless M-Bus meters, Z-Wave and
              Homematic frames are reported as they repeat.
            </div>
          </Show>
        </div>
      </div>

      {/* Device details */}
      <div class="md:flex-1 min-h-0 overflow-auto bg-black/40">
        <Show
          when={selected()}
          fallback={
            <div class="h-full flex flex-col items-center justify-center gap-2 px-4 text-center text-[9px] font-mono text-text-dim">
              <span>Select a device to inspect its readings and raw frame.</span>
              <Show when={status()?.channels?.length}>
                <div class="text-[8px] text-text-dim/80">
                  <For each={status()!.channels}>
                    {(channel) => (
                      <div>
                        {formatHz(channel.freqHz)} · {channel.label} ·{' '}
                        {channel.live ? 'live' : channel.reason || 'off'}
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          }
        >
          {(device) => (
            <div class="p-3 space-y-3">
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/30 pb-2">
                <span class="text-[10px] font-mono uppercase tracking-wider text-cyan">
                  {device().kind}
                </span>
                <span class="text-[8px] font-mono text-text-secondary">
                  {device().device}
                </span>
                <span class="text-[8px] font-mono text-text-dim">
                  {formatHz(device().freqHz)} · {device().snrDb} dB · heard{' '}
                  {device().count}×
                </span>
                <span class="ml-auto text-[8px] font-mono text-text-dim">
                  first {formatTime(device().firstAt)} · last {formatTime(device().lastAt)}
                </span>
              </div>

              <Show when={device().encrypted}>
                <div class="text-[8px] font-mono text-amber/90">
                  Encrypted payload — identity and raw frame only.
                </div>
              </Show>

              <Show when={device().readings.length > 0}>
                <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  <For each={device().readings}>
                    {(reading) => (
                      <div class="border border-border/30 rounded-sm px-2 py-1">
                        <div class="text-[8px] font-mono uppercase tracking-wider text-text-dim">
                          {reading.quantity}
                        </div>
                        <div class="text-[11px] font-mono text-text-primary">
                          {reading.value.toFixed(reading.decimals)}
                          {reading.unit ? ` ${reading.unit}` : ''}
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>

              <Show when={device().extra.length > 0}>
                <div class="space-y-1">
                  <div class="text-[8px] font-mono uppercase tracking-wider text-text-dim">
                    Extra
                  </div>
                  <For each={device().extra}>
                    {([name, value]) => (
                      <div class="flex gap-2 text-[9px] font-mono">
                        <span class="text-text-dim">{name}</span>
                        <span class="text-text-primary">{value}</span>
                      </div>
                    )}
                  </For>
                </div>
              </Show>

              <div class="space-y-1">
                <div class="text-[8px] font-mono uppercase tracking-wider text-text-dim">
                  Raw frame
                </div>
                <pre class="whitespace-pre-wrap break-all text-[9px] leading-relaxed font-mono text-text-secondary">
                  {device().rawHex || '—'}
                </pre>
              </div>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
};

export default IsmDisplay;
