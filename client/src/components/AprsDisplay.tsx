// ============================================================
// node-sdr — APRS workspace
// ============================================================
// Packet table on the left, OpenStreetMap on the right. The server sends one
// event per decoded AX.25 UI frame; the store keeps a rolling history.

import { Component, For, Show, createMemo, createSignal } from 'solid-js';
import { store } from '../store/index.js';
import AprsMap from './AprsMap.js';
import type { AprsPacket } from '~/shared';

function formatTime(at: number): string {
  const date = new Date(at * 1000);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function position(packet: AprsPacket): string {
  if (typeof packet.lat !== 'number' || typeof packet.lon !== 'number') return '';
  return `${packet.lat.toFixed(4)}, ${packet.lon.toFixed(4)}`;
}

function via(packet: AprsPacket): string {
  return packet.via.length ? packet.via.join(',') : 'direct';
}

function packetText(packet: AprsPacket): string {
  return packet.text ?? packet.raw;
}

const AprsDisplay: Component = () => {
  const [selectedFrom, setSelectedFrom] = createSignal<string | null>(null);
  const [followSelected, setFollowSelected] = createSignal(true);

  const packets = () => store.aprsPackets();
  const status = () => store.aprsStatus();

  const withPosition = createMemo(() => packets().filter((p) => typeof p.lat === 'number' && typeof p.lon === 'number'));

  const selectedPackets = createMemo(() => {
    const from = selectedFrom();
    if (!from) return [];
    return packets().filter((p) => p.from === from);
  });

  const selected = createMemo(() => selectedPackets()[0] ?? null);

  return (
    <div class="flex-1 min-h-0 flex flex-col md:flex-row">
      {/* Packet table */}
      <div class="flex flex-col min-w-0 min-h-0 md:w-[52%] border-b md:border-b-0 md:border-r border-border/40">
        <div class="shrink-0 px-2 py-1 border-b border-border/30 text-[8px] font-mono leading-relaxed">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-text-dim">
            <span class="uppercase tracking-wider text-text-secondary">APRS</span>
            <span>{packets().length} PACKETS</span>
            <span>{withPosition().length} POS</span>
            <span>FRM {status().frames}</span>
            <span>FCS {status().badFcs}</span>
            <span>NON {status().nonAprs}</span>
            <span>LVL {status().level.toFixed(2)}</span>
            <span>144.390 MHz · 12.5 kHz</span>
          </div>
        </div>

        <div class="flex-1 min-h-0 overflow-auto">
          <table class="w-full text-[8px] font-mono">
            <thead class="sticky top-0 z-10 bg-sdr-surface">
              <tr>
                <th class="text-left px-1.5 py-1 text-text-dim">TIME</th>
                <th class="text-left px-1.5 py-1 text-text-dim">FROM</th>
                <th class="text-left px-1.5 py-1 text-text-dim">KIND</th>
                <th class="text-left px-1.5 py-1 text-text-dim">PACKET</th>
                <th class="text-left px-1.5 py-1 text-text-dim">POS</th>
                <th class="text-left px-1.5 py-1 text-text-dim">VIA</th>
              </tr>
            </thead>
            <tbody>
              <For each={packets().slice(0, 300)}>
                {(packet) => {
                  const active = () => selectedFrom() === packet.from;
                  return (
                    <tr
                      onClick={() => setSelectedFrom(active() ? null : packet.from)}
                      class={`border-t border-border/20 cursor-pointer ${
                        active() ? 'bg-cyan/10 text-cyan' : ''
                      } hover:bg-cyan/5`}
                    >
                      <td class="px-1.5 py-1 whitespace-nowrap text-text-dim">{formatTime(packet.at)}</td>
                      <td class="px-1.5 py-1 whitespace-nowrap text-text-primary">{packet.from}</td>
                      <td class="px-1.5 py-1 whitespace-nowrap text-text-secondary">{packet.kind}</td>
                      <td class="px-1.5 py-1 break-all">{packetText(packet)}</td>
                      <td class="px-1.5 py-1 whitespace-nowrap text-text-dim">{position(packet)}</td>
                      <td class="px-1.5 py-1 whitespace-nowrap text-text-dim truncate max-w-[110px]">{via(packet)}</td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>

          <Show when={packets().length === 0}>
            <div class="px-2 py-3 text-[8px] font-mono text-text-dim">
              Waiting for an APRS packet. Tune 144.390 MHz (regional channel) with a 12.5 kHz
              NFM profile; APRS is 1200 baud Bell 202 AX.25.
            </div>
          </Show>
        </div>

        <Show when={selected()}>
          {(packet) => (
            <div class="shrink-0 border-t border-border/40 px-2 py-1.5 text-[8px] font-mono">
              <div class="flex items-center gap-2 mb-1">
                <span class="text-cyan uppercase tracking-wider">{packet().from}</span>
                <span class="text-text-dim">{packet().to}</span>
                <span class="text-text-dim">{packet().kind}</span>
                <button
                  onClick={() => setSelectedFrom(null)}
                  class="ml-auto text-text-dim hover:text-amber uppercase tracking-wider"
                >
                  Close
                </button>
              </div>
              <div class="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-0.5 text-text-secondary">
                <span>POS <span class="text-text-primary">{position(packet()) || '---'}</span></span>
                <span>VIA <span class="text-text-primary">{via(packet())}</span></span>
                <span>SYMBOL <span class="text-text-primary">{packet().symbol || '---'}</span></span>
                <Show when={packet().comment}>
                  <span class="col-span-2 sm:col-span-4">COMMENT <span class="text-text-primary">{packet().comment}</span></span>
                </Show>
                <Show when={packet().message}>
                  {(message) => (
                    <span class="col-span-2 sm:col-span-4">
                      MESSAGE <span class="text-text-primary">{message().addressee}: {message().text}</span>
                    </span>
                  )}
                </Show>
                <Show when={packet().status}>
                  <span class="col-span-2 sm:col-span-4">STATUS <span class="text-text-primary">{packet().status}</span></span>
                </Show>
                <span class="col-span-2 sm:col-span-4 text-text-dim">RAW <span class="text-text-primary break-all">{packet().raw}</span></span>
              </div>
            </div>
          )}
        </Show>
      </div>

      {/* Map */}
      <div class="md:flex-1 min-h-[220px] md:min-h-0 relative bg-black">
        <AprsMap
          packets={withPosition()}
          selectedFrom={selectedFrom()}
          followSelected={followSelected()}
          onSelect={(from) => setSelectedFrom((current) => (current === from ? null : from))}
        />
        <div class="absolute top-1 left-1.5 z-[400] flex items-center gap-2 pointer-events-auto">
          <span class="text-[8px] font-mono text-cyan/80 bg-black/50 px-1">APRS STATIONS</span>
          <button
            onClick={() => setFollowSelected((v) => !v)}
            class="text-[8px] font-mono uppercase tracking-wider bg-black/50 px-1 text-text-dim hover:text-cyan"
          >
            {followSelected() ? 'follow' : 'free'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AprsDisplay;
