// ============================================================
// node-sdr — AX.25 packet monitor
// ============================================================
// Every AX.25 frame on the channel, not just APRS UI payloads. The left side
// is a conventional packet monitor; the right side shows the selected frame's
// addresses, type, PID and raw bytes.

import { Component, For, Show, createMemo, createSignal } from 'solid-js';
import { store } from '../store/index.js';
import type { PacketFrame } from '~/shared';

function formatTime(at: number): string {
  return new Date(at * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function path(frame: PacketFrame): string {
  return frame.via.length > 0 ? frame.via.join(',') : '—';
}

const PacketDisplay: Component = () => {
  const [selectedAt, setSelectedAt] = createSignal<number | null>(null);

  const frames = () => store.packetFrames();
  const status = () => store.packetStatus();
  const selected = createMemo(() => {
    const at = selectedAt();
    if (at === null) return null;
    return frames().find((frame) => frame.at === at) ?? null;
  });

  return (
    <div class="flex-1 min-h-0 flex flex-col md:flex-row">
      <div class="flex flex-col min-w-0 min-h-0 md:w-[58%] border-b md:border-b-0 md:border-r border-border/40">
        <div class="shrink-0 px-2 py-1 border-b border-border/30 text-[8px] font-mono leading-relaxed">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-text-dim">
            <span class="uppercase tracking-wider text-text-secondary">AX.25 PACKET</span>
            <span>{frames().length} FRAMES</span>
            <span>BAD FCS {status().badFcs}</span>
            <span>NON-AX25 {status().nonAx25}</span>
            <span>LVL {status().level.toFixed(2)}</span>
            <span>{status().baud} BAUD</span>
          </div>
        </div>

        <div class="flex-1 min-h-0 overflow-auto">
          <table class="w-full text-[8px] font-mono">
            <thead class="sticky top-0 z-10 bg-sdr-surface">
              <tr>
                <th class="text-left px-1.5 py-1 text-text-dim">TIME</th>
                <th class="text-left px-1.5 py-1 text-text-dim">FROM</th>
                <th class="text-left px-1.5 py-1 text-text-dim">TO</th>
                <th class="text-left px-1.5 py-1 text-text-dim">TYPE</th>
                <th class="text-left px-1.5 py-1 text-text-dim">VIA</th>
                <th class="text-left px-1.5 py-1 text-text-dim">PAYLOAD</th>
              </tr>
            </thead>
            <tbody>
              <For each={frames()}>
                {(frame) => {
                  const active = () => selectedAt() === frame.at;
                  return (
                    <tr
                      onClick={() => setSelectedAt(active() ? null : frame.at)}
                      class={`border-t border-border/20 cursor-pointer ${
                        active() ? 'bg-cyan/10 text-cyan' : ''
                      } hover:bg-cyan/5`}
                    >
                      <td class="px-1.5 py-1 whitespace-nowrap text-text-dim">{formatTime(frame.at)}</td>
                      <td class="px-1.5 py-1 whitespace-nowrap text-text-primary">{frame.from}</td>
                      <td class="px-1.5 py-1 whitespace-nowrap text-text-secondary">{frame.to}</td>
                      <td class="px-1.5 py-1 whitespace-nowrap text-cyan">{frame.type}</td>
                      <td class="px-1.5 py-1 break-all text-text-dim">{path(frame)}</td>
                      <td class="px-1.5 py-1 break-all">{frame.payload}</td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>

          <Show when={frames().length === 0}>
            <div class="px-2 py-3 text-[8px] font-mono text-text-dim">
              Waiting for AX.25 traffic. NBFM 12.5 kHz; 1200 baud Bell 202 by
              default, or set <code>settings.baud: 9600</code> on the decoder
              for G3RUH on a 9600 packet channel.
            </div>
          </Show>
        </div>
      </div>

      <div class="md:flex-1 min-h-0 overflow-auto bg-black/40">
        <Show
          when={selected()}
          fallback={
            <div class="h-full flex items-center justify-center px-4 text-center text-[9px] font-mono text-text-dim">
              Select a frame to inspect its AX.25 header and raw bytes.
            </div>
          }
        >
          {(frame) => (
            <div class="p-3 space-y-3">
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/30 pb-2">
                <span class="text-[10px] font-mono uppercase tracking-wider text-cyan">
                  {frame().from} → {frame().to}
                </span>
                <span class="text-[8px] font-mono text-text-secondary">{frame().type}</span>
                <span class="text-[8px] font-mono text-text-dim">
                  PID 0x{frame().pid.toString(16).toUpperCase().padStart(2, '0')}
                </span>
                <span class="text-[8px] font-mono text-text-dim">{frame().length} bytes</span>
                <span class="ml-auto text-[8px] font-mono text-text-dim">{formatTime(frame().at)}</span>
              </div>

              <div class="grid grid-cols-[5rem_1fr] gap-x-2 gap-y-1 text-[9px] font-mono">
                <span class="text-text-dim">FROM</span><span class="break-all">{frame().from}</span>
                <span class="text-text-dim">TO</span><span class="break-all">{frame().to}</span>
                <span class="text-text-dim">VIA</span><span class="break-all">{path(frame())}</span>
                <span class="text-text-dim">TYPE</span><span>{frame().type}</span>
                <span class="text-text-dim">PID</span>
                <span>0x{frame().pid.toString(16).toUpperCase().padStart(2, '0')}</span>
                <span class="text-text-dim">PAYLOAD</span>
                <span class="break-all whitespace-pre-wrap">{frame().payload || '—'}</span>
              </div>

              <div>
                <div class="text-[8px] font-mono uppercase tracking-wider text-text-dim mb-1">
                  Raw frame
                </div>
                <pre class="whitespace-pre-wrap break-all text-[9px] leading-relaxed font-mono text-text-secondary bg-black/30 border border-border/30 rounded-sm p-2">
                  {frame().raw}
                </pre>
              </div>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
};

export default PacketDisplay;
