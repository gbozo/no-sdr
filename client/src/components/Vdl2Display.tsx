// ============================================================
// node-sdr — VDL Mode 2 workspace
// ============================================================
// Message log on the left, station table on the right. VDL2 is a message
// service, not a position mode, so there is no map.

import { Component, For, Show, createMemo, createSignal } from 'solid-js';
import { store } from '../store/index.js';
import type { Vdl2Message } from '~/shared';

const MAX_ROWS = 220;

function timeOf(at: number): string {
  return new Date(at * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function stationLabel(registration: string, flight: string, hex: string): string {
  const flightText = flight.trim();
  if (flightText) return flightText;
  const registrationText = registration.trim();
  if (registrationText) return registrationText;
  return hex;
}

function acarsText(message: Vdl2Message): string | null {
  const payload = message.payload as { Acars?: { text?: string } } | null | undefined;
  const text = payload?.Acars?.text;
  return typeof text === 'string' && text.trim() ? text.trim() : null;
}

const Vdl2Display: Component = () => {
  const [selected, setSelected] = createSignal<string | null>(null);
  const [filterSrc, setFilterSrc] = createSignal<number | null>(null);

  const status = () => store.vdl2Status();
  const stations = () => store.vdl2Stations();

  const messages = createMemo(() => {
    const filter = filterSrc();
    return store
      .vdl2Messages()
      .filter((m) => filter == null || m.src === filter)
      .slice()
      .reverse()
      .slice(0, MAX_ROWS);
  });

  const selectedMessage = createMemo(() => {
    const key = selected();
    if (!key) return null;
    return store.vdl2Messages().find((m) => `${m.at}-${m.raw_hex}` === key) ?? null;
  });

  const rowKey = (m: Vdl2Message) => `${m.at}-${m.raw_hex}`;

  const sortedStations = createMemo(() =>
    [...stations()].sort((a, b) => b.last_at - a.last_at),
  );

  return (
    <div class="flex-1 min-h-0 flex flex-col bg-sdr-surface/30">
      <div class="shrink-0 px-2 py-1 border-b border-border/30 text-[8px] font-mono leading-relaxed">
        <Show when={status()?.unavailable}>
          {(message) => (
            <div class="text-amber">
              <span class="uppercase tracking-wider">VDL2 unavailable:</span> {message()}
            </div>
          )}
        </Show>
        <Show when={!status()?.unavailable && status()?.degraded}>
          {(message) => (
            <div class="text-amber/90">
              <span class="uppercase tracking-wider">Degraded:</span> {message()}
            </div>
          )}
        </Show>
        <Show when={status()?.suggestCenterHz}>
          {(hz) => (
            <div class="text-text-secondary">
              Tune the dongle to {(hz() / 1e6).toFixed(4)} MHz with at least 350 kHz of span.
            </div>
          )}
        </Show>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-text-dim">
          <span class="uppercase tracking-wider text-text-secondary">VDL2</span>
          <span>{stations().length} STATIONS</span>
          <span>{messages().length} MSG</span>
          <Show when={status()}>
            {(s) => (
              <>
                <span>FRM {s().frames}</span>
                <span>BST {s().bursts}</span>
                <span>SYN {s().syncs}</span>
                <span>HDR {s().headers}</span>
                <span>FCS {s().fcsBad}</span>
                <span>SPB {s().samplesPerSymbol.toFixed(1)}</span>
                <span>
                  {(s().windowCenterHz / 1e6).toFixed(4)} MHz ·{' '}
                  {(s().windowRateHz / 1e6).toFixed(2)} MSPS
                </span>
                <span>
                  {s().channels.filter((c) => c.live).length}/{s().channels.length} CH
                </span>
              </>
            )}
          </Show>
          <Show when={filterSrc()}>
            {(src) => (
              <button
                onClick={() => setFilterSrc(null)}
                class="text-cyan hover:text-amber uppercase tracking-wider"
              >
                SRC {src().toString(16).toUpperCase()} ×
              </button>
            )}
          </Show>
        </div>
      </div>

      <div class="flex-1 min-h-0 flex flex-col md:flex-row">
        {/* Message log + details */}
        <div class="flex flex-col min-w-0 min-h-0 md:flex-1 border-b md:border-b-0 md:border-r border-border/40">
          <div class="flex-1 min-h-0 overflow-auto">
            <table class="w-full text-[8px] font-mono">
              <thead class="sticky top-0 z-10 bg-sdr-surface">
                <tr>
                  <th class="text-left px-1.5 py-1 text-text-dim">TIME</th>
                  <th class="text-right px-1.5 py-1 text-text-dim">MHz</th>
                  <th class="text-left px-1.5 py-1 text-text-dim">SRC → DST</th>
                  <th class="text-left px-1.5 py-1 text-text-dim">FRAME</th>
                  <th class="text-left px-1.5 py-1 text-text-dim">SUMMARY</th>
                  <th class="text-right px-1.5 py-1 text-text-dim">SNR</th>
                </tr>
              </thead>
              <tbody>
                <For each={messages()}>
                  {(message) => (
                    <tr
                      onClick={() => setSelected(rowKey(message) === selected() ? null : rowKey(message))}
                      class={`border-t border-border/20 cursor-pointer hover:bg-cyan/5 ${
                        rowKey(message) === selected() ? 'bg-cyan/10 text-cyan' : ''
                      }`}
                    >
                      <td class="px-1.5 py-1 text-text-dim whitespace-nowrap">{timeOf(message.at)}</td>
                      <td class="px-1.5 py-1 text-right text-text-dim whitespace-nowrap">
                        {(message.freq_hz / 1e6).toFixed(3)}
                      </td>
                      <td class="px-1.5 py-1 whitespace-nowrap text-text-secondary">
                        {message.srcHex} → {message.dstHex}
                      </td>
                      <td class="px-1.5 py-1 whitespace-nowrap text-text-dim">{message.frameLabel}</td>
                      <td class="px-1.5 py-1 text-text-primary break-all">{message.summary}</td>
                      <td class="px-1.5 py-1 text-right whitespace-nowrap text-text-dim">
                        {Math.round(message.snr_db)}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>

            <Show when={messages().length === 0}>
              <div class="px-2 py-3 text-[8px] font-mono space-y-1">
                <p class="text-text-dim">No VDL2 frames heard</p>
                <p class="text-text-dim/70">
                  Tune to 136.8125 MHz with at least 350 kHz of span. VDL2 carries
                  ACARS between aircraft and ground stations; frames are bursty.
                </p>
              </div>
            </Show>
          </div>

          <Show when={selectedMessage()}>
            {(message) => (
              <div class="shrink-0 border-t border-border/40 px-2 py-1.5 text-[8px] font-mono">
                <div class="flex items-center gap-2 mb-1">
                  <span class="text-cyan uppercase tracking-wider">VDL2 FRAME</span>
                  <span class="text-text-dim">{timeOf(message().at)}</span>
                  <button
                    onClick={() => setSelected(null)}
                    class="ml-auto text-text-dim hover:text-amber uppercase tracking-wider"
                  >
                    Close
                  </button>
                </div>
                <div class="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-0.5 text-text-secondary">
                  <span>SRC <span class="text-text-primary">{message().srcHex}</span></span>
                  <span>DST <span class="text-text-primary">{message().dstHex}</span></span>
                  <span>FRAME <span class="text-text-primary">{message().frameLabel}</span></span>
                  <span>SNR <span class="text-text-primary">{message().snr_db.toFixed(1)} dB</span></span>
                  <span>RSSI <span class="text-text-primary">{message().rssi_dbfs.toFixed(1)} dBFS</span></span>
                  <span>EVM <span class="text-text-primary">{message().evm_deg.toFixed(1)}°</span></span>
                  <span>OFFSET <span class="text-text-primary">{Math.round(message().freq_err_hz)} Hz</span></span>
                  <span>RS <span class="text-text-primary">{message().rs_corrected}</span></span>
                </div>
                <Show when={acarsText(message())}>
                  {(text) => (
                    <p class="mt-1 text-text-primary break-all whitespace-pre-wrap">{text()}</p>
                  )}
                </Show>
                <div class="mt-1 text-text-dim break-all" title={message().raw_hex}>
                  {message().raw_hex}
                </div>
              </div>
            )}
          </Show>
        </div>

        {/* Station table */}
        <div class="md:w-[30%] min-h-[120px] md:min-h-0 overflow-auto">
          <table class="w-full text-[8px] font-mono">
            <thead class="sticky top-0 z-10 bg-sdr-surface">
              <tr>
                <th class="text-left px-1.5 py-1 text-text-dim">STATION</th>
                <th class="text-left px-1.5 py-1 text-text-dim">KIND</th>
                <th class="text-left px-1.5 py-1 text-text-dim">LAST</th>
                <th class="text-right px-1.5 py-1 text-text-dim">FRM</th>
              </tr>
            </thead>
            <tbody>
              <For each={sortedStations()}>
                {(station) => (
                  <tr
                    onClick={() =>
                      setFilterSrc(filterSrc() === station.addr ? null : station.addr)
                    }
                    class={`border-t border-border/20 cursor-pointer hover:bg-cyan/5 ${
                      filterSrc() === station.addr ? 'bg-cyan/10 text-cyan' : ''
                    }`}
                  >
                    <td class="px-1.5 py-1 text-text-primary whitespace-nowrap">
                      {stationLabel(station.registration, station.flight, station.addr.toString(16).toUpperCase().padStart(6, '0'))}
                    </td>
                    <td class="px-1.5 py-1 text-text-secondary whitespace-nowrap">{station.kind}</td>
                    <td class="px-1.5 py-1 text-text-dim whitespace-nowrap">
                      {Math.max(0, Math.round(Date.now() / 1000 - station.last_at))}s
                    </td>
                    <td class="px-1.5 py-1 text-right text-text-dim">{station.messages}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
          <Show when={stations().length === 0}>
            <p class="text-[8px] font-mono text-text-dim px-2 py-3">No stations heard</p>
          </Show>
        </div>
      </div>
    </div>
  );
};

export default Vdl2Display;
