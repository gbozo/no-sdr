// ============================================================
// node-sdr — HFDL workspace
// ============================================================
// ARINC 635 ground-network log. HFDL is a message/position service rather
// than a map mode; the table is the primary view, with a details pane for the
// payload fields the parser surfaced.

import { Component, For, Show, createMemo, createSignal } from 'solid-js';
import { store } from '../store/index.js';
import type { HfdlDecode } from '~/shared';

const MAX_ROWS = 180;

function timeOf(unix: number): string {
  return new Date(unix * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function positionText(decode: HfdlDecode): string {
  const p = decode.position;
  if (!p) return '';
  const label = p.flight || p.icao || (p.aircraftId != null ? `#${p.aircraftId}` : '');
  return `${label ? `${label} ` : ''}${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}`;
}

const HfdlDisplay: Component = () => {
  const [selected, setSelected] = createSignal<number | null>(null);
  const status = () => store.hfdlStatus();
  const log = createMemo(() => store.hfdlLog().slice(0, MAX_ROWS));
  const selectedDecode = createMemo(() => {
    const at = selected();
    return at == null ? null : store.hfdlLog().find((entry) => entry.unix === at) ?? null;
  });

  return (
    <div class="flex-1 min-h-0 flex flex-col bg-sdr-surface/30">
      <div class="shrink-0 px-2 py-1 border-b border-border/30 text-[8px] font-mono leading-relaxed">
        <Show when={status()?.unavailable}>
          {(message) => (
            <div class="text-amber">
              <span class="uppercase tracking-wider">HFDL unavailable:</span> {message()}
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
              Tune the dongle near {(hz() / 1e3).toFixed(3)} kHz with a 24 kHz lane.
            </div>
          )}
        </Show>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-text-dim">
          <span class="uppercase tracking-wider text-text-secondary">HFDL</span>
          <span>{log().length} EVENTS</span>
          <Show when={status()}>
            {(s) => (
              <>
                <span>{s().running ? 'RUNNING' : 'STOPPED'}</span>
                <span>LVL {s().levelDbfs.toFixed(1)} dBFS</span>
                <span>BST {s().bursts}</span>
                <span>DEC {s().decodes}</span>
                <span>
                  {(s().windowCenterHz / 1e3).toFixed(3)} kHz ·{' '}
                  {(s().windowRateHz / 1e6).toFixed(2)} MSPS
                </span>
              </>
            )}
          </Show>
        </div>
      </div>

      <div class="flex-1 min-h-0 flex flex-col md:flex-row">
        <div class="flex flex-col min-w-0 min-h-0 md:flex-1 border-b md:border-b-0 md:border-r border-border/40">
          <div class="flex-1 min-h-0 overflow-auto">
            <table class="w-full text-[8px] font-mono">
              <thead class="sticky top-0 z-10 bg-sdr-surface">
                <tr>
                  <th class="text-left px-1.5 py-1 text-text-dim">TIME</th>
                  <th class="text-left px-1.5 py-1 text-text-dim">KIND</th>
                  <th class="text-left px-1.5 py-1 text-text-dim">GROUND</th>
                  <th class="text-right px-1.5 py-1 text-text-dim">kHz</th>
                  <th class="text-right px-1.5 py-1 text-text-dim">SNR</th>
                  <th class="text-left px-1.5 py-1 text-text-dim">POSITION / DETAIL</th>
                </tr>
              </thead>
              <tbody>
                <For each={log()}>
                  {(entry) => (
                    <tr
                      onClick={() => setSelected(selected() === entry.unix ? null : entry.unix)}
                      class={`border-t border-border/20 cursor-pointer hover:bg-cyan/5 ${
                        selected() === entry.unix ? 'bg-cyan/10 text-cyan' : ''
                      }`}
                    >
                      <td class="px-1.5 py-1 text-text-dim whitespace-nowrap">{timeOf(entry.unix)}</td>
                      <td class="px-1.5 py-1 text-text-primary whitespace-nowrap">{entry.kind}</td>
                      <td class="px-1.5 py-1 text-text-secondary whitespace-nowrap">{entry.gs ?? ''}</td>
                      <td class="px-1.5 py-1 text-right text-text-dim whitespace-nowrap">{entry.freqKhz}</td>
                      <td class="px-1.5 py-1 text-right text-text-dim whitespace-nowrap">
                        {entry.snrDb == null ? '' : entry.snrDb.toFixed(1)}
                      </td>
                      <td class="px-1.5 py-1 text-text-secondary break-all">
                        {positionText(entry) || entry.details}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>

            <Show when={log().length === 0}>
              <div class="px-2 py-3 text-[8px] font-mono space-y-1">
                <p class="text-text-dim">No HFDL events heard</p>
                <p class="text-text-dim/70">
                  HFDL uses 24 kHz lanes on HF. Tune an assigned channel such as
                  21.931 MHz; squitters repeat roughly every 32 seconds.
                </p>
              </div>
            </Show>
          </div>
        </div>

        <Show when={selectedDecode()}>
          {(entry) => (
            <div class="md:w-[34%] min-h-[120px] md:min-h-0 overflow-auto border-t md:border-t-0 border-border/40 px-2 py-1.5 text-[8px] font-mono">
              <div class="flex items-center gap-2 mb-1">
                <span class="text-cyan uppercase tracking-wider">HFDL {entry().kind}</span>
                <span class="text-text-dim">{timeOf(entry().unix)}</span>
                <button
                  onClick={() => setSelected(null)}
                  class="ml-auto text-text-dim hover:text-amber uppercase tracking-wider"
                >
                  Close
                </button>
              </div>
              <div class="space-y-0.5 text-text-secondary">
                <div>GROUND <span class="text-text-primary">{entry().gs ?? '—'}</span></div>
                <div>FREQ <span class="text-text-primary">{entry().freqKhz} kHz</span></div>
                <div>SNR <span class="text-text-primary">{entry().snrDb?.toFixed(1) ?? '—'} dB</span></div>
                <div>SKEW <span class="text-text-primary">{entry().freqSkewHz?.toFixed(1) ?? '—'} Hz</span></div>
                <div>FEC <span class="text-text-primary">{entry().fecCorrected ?? '—'}</span></div>
                <Show when={entry().position}>
                  {(p) => (
                    <div>
                      POS <span class="text-text-primary">{p().lat.toFixed(4)}, {p().lon.toFixed(4)}</span>
                      <span class="text-text-dim"> {p().flight || p().icao || ''}</span>
                    </div>
                  )}
                </Show>
              </div>
              <pre class="mt-1 text-text-dim whitespace-pre-wrap break-all">{entry().details}</pre>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
};

export default HfdlDisplay;
