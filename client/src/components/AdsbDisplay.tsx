// ============================================================
// node-sdr — ADS-B workspace
// ============================================================
// Aircraft table on the left, OpenStreetMap on the right. The server re-sends
// the whole table about twice a second; this component only renders state, it
// never appends rows or rebuilds the map.

import { Component, For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { store } from '../store/index.js';
import AdsbMap, { icaoHex } from './AdsbMap.js';
import type { AdsbAircraft } from '~/shared';

type SortKey = 'callsign' | 'altitude' | 'seen';
type SortDir = 1 | -1;

function label(ac: AdsbAircraft): string {
  return ac.callsign.trim() || icaoHex(ac.icao);
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function altitude(ac: AdsbAircraft): string {
  if (ac.on_ground) return 'GND';
  const ft = ac.altitude_ft;
  if (ft == null) return '---';
  const hundreds = Math.round(ft / 100);
  return ft >= 18_000 ? `F${pad(hundreds, 3)}` : pad(hundreds, 3);
}

function speed(ac: AdsbAircraft): string {
  return ac.ground_speed_kt == null ? '---' : String(Math.round(ac.ground_speed_kt));
}

function heading(ac: AdsbAircraft): string {
  return ac.track_deg == null ? '---' : `${pad(Math.round(ac.track_deg) % 360, 3)}°`;
}

function verticalRate(ac: AdsbAircraft): string {
  if (ac.vertical_rate_fpm == null) return '---';
  if (ac.vertical_rate_fpm === 0) return '0';
  return `${ac.vertical_rate_fpm > 0 ? '+' : ''}${ac.vertical_rate_fpm}`;
}

function squawk(ac: AdsbAircraft): string {
  return ac.squawk == null ? '----' : pad(ac.squawk, 4);
}

function ageSeconds(ac: AdsbAircraft, nowSec: number): number {
  return Math.max(0, Math.round(nowSec - ac.last_at));
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${pad(seconds % 60, 2)}`;
}

const AdsbDisplay: Component = () => {
  const [selectedIcao, setSelectedIcao] = createSignal<string | null>(null);
  const [followSelected, setFollowSelected] = createSignal(true);
  const [sortKey, setSortKey] = createSignal<SortKey>('callsign');
  const [sortDir, setSortDir] = createSignal<SortDir>(1);
  const [nowSec, setNowSec] = createSignal(Date.now() / 1000);

  onMount(() => {
    const timer = window.setInterval(() => setNowSec(Date.now() / 1000), 1000);
    onCleanup(() => clearInterval(timer));
  });

  const status = () => store.adsbStatus();
  const aircraft = () => store.adsbAircraft();

  const toggleSort = (key: SortKey, defaultDir: SortDir) => {
    if (sortKey() === key) {
      setSortDir((dir) => (dir === 1 ? -1 : 1));
    } else {
      setSortKey(key);
      setSortDir(defaultDir);
    }
  };

  const sorted = createMemo(() => {
    const key = sortKey();
    const dir = sortDir();
    const rows = [...aircraft()];
    rows.sort((a, b) => {
      let result = 0;
      switch (key) {
        case 'altitude':
          result = (a.altitude_ft ?? -1) - (b.altitude_ft ?? -1);
          break;
        case 'seen':
          result = a.last_at - b.last_at;
          break;
        default:
          result = label(a).localeCompare(label(b), undefined, { numeric: true });
          break;
      }
      if (result === 0) result = label(a).localeCompare(label(b));
      return result * dir;
    });
    return rows;
  });

  const selected = createMemo(() => {
    const key = selectedIcao();
    if (!key) return null;
    return aircraft().find((ac) => icaoHex(ac.icao) === key) ?? null;
  });

  const headerClass = (key: SortKey) =>
    `px-1.5 py-1 cursor-pointer select-none hover:text-cyan ${
      sortKey() === key ? 'text-cyan' : 'text-text-dim'
    }`;

  return (
    <div class="flex-1 min-h-0 flex flex-col md:flex-row">
      {/* ── Aircraft table ── */}
      <div class="flex flex-col min-w-0 min-h-0 md:w-[46%] border-b md:border-b-0 md:border-r border-border/40">
        {/* Diagnostics */}
        <div class="shrink-0 px-2 py-1 border-b border-border/30 text-[8px] font-mono leading-relaxed">
          <Show when={status()?.unavailable}>
            {(message) => (
              <div class="text-amber">
                <span class="uppercase tracking-wider">ADS-B unavailable:</span> {message()}
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
                Tune the dongle to {(hz() / 1e6).toFixed(3)} MHz with a 2.40 MSPS profile.
              </div>
            )}
          </Show>
          <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-text-dim">
            <span class="uppercase tracking-wider text-text-secondary">ADS-B</span>
            <span>{aircraft().length} ACFT</span>
            <Show when={status()}>
              {(s) => (
                <>
                  <span>PRE {s().preambles}</span>
                  <span>FRM {s().frames}</span>
                  <span>REP {s().repaired}</span>
                  <span>CRC {s().badCrc}</span>
                  <span>UNM {s().unmatched}</span>
                  <span>
                    {(s().windowCenterHz / 1e6).toFixed(3)} MHz ·{' '}
                    {(s().windowRateHz / 1e6).toFixed(2)} MSPS
                  </span>
                </>
              )}
            </Show>
          </div>
        </div>

        {/* Table */}
        <div class="flex-1 min-h-0 overflow-auto">
          <table class="w-full text-[8px] font-mono">
            <thead class="sticky top-0 z-10 bg-sdr-surface">
              <tr>
                <th class="text-left px-1.5 py-1 text-text-dim">ICAO</th>
                <th class={`text-left ${headerClass('callsign')}`} onClick={() => toggleSort('callsign', 1)}>
                  CALLSIGN
                </th>
                <th class={`text-right ${headerClass('altitude')}`} onClick={() => toggleSort('altitude', -1)}>
                  ALT
                </th>
                <th class="text-right px-1.5 py-1 text-text-dim">GS</th>
                <th class="text-right px-1.5 py-1 text-text-dim">TRK</th>
                <th class="text-right px-1.5 py-1 text-text-dim">V/S</th>
                <th class="text-right px-1.5 py-1 text-text-dim">SQK</th>
                <th class={`text-right ${headerClass('seen')}`} onClick={() => toggleSort('seen', -1)}>
                  AGE
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={sorted()}>
                {(ac) => {
                  const key = icaoHex(ac.icao);
                  const isSelected = () => selectedIcao() === key;
                  return (
                    <tr
                      onClick={() => setSelectedIcao(isSelected() ? null : key)}
                      class={`border-t border-border/20 cursor-pointer ${
                        isSelected() ? 'bg-cyan/10 text-cyan' : ac.emergency ? 'text-amber' : ''
                      } hover:bg-cyan/5`}
                      title={ac.emergency ?? undefined}
                    >
                      <td class="px-1.5 py-1 whitespace-nowrap text-text-dim">{key}</td>
                      <td class="px-1.5 py-1 whitespace-nowrap text-text-primary">{label(ac)}</td>
                      <td class="px-1.5 py-1 text-right whitespace-nowrap">{altitude(ac)}</td>
                      <td class="px-1.5 py-1 text-right whitespace-nowrap">{speed(ac)}</td>
                      <td class="px-1.5 py-1 text-right whitespace-nowrap">{heading(ac)}</td>
                      <td class="px-1.5 py-1 text-right whitespace-nowrap">{verticalRate(ac)}</td>
                      <td class="px-1.5 py-1 text-right whitespace-nowrap">{squawk(ac)}</td>
                      <td class="px-1.5 py-1 text-right whitespace-nowrap text-text-dim">
                        {formatAge(ageSeconds(ac, nowSec()))}
                      </td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>

          <Show when={aircraft().length === 0}>
            <div class="px-2 py-3 text-[8px] font-mono space-y-1">
              <Show
                when={status()?.unavailable}
                fallback={<p class="text-text-dim">No aircraft heard</p>}
              >
                <p class="text-amber">No aircraft heard — the receiver cannot decode ADS-B here.</p>
              </Show>
              <Show when={status() && !status()?.unavailable}>
                <p class="text-text-dim">
                  Waiting for a Mode S squitter. Check the antenna and that the profile is
                  centred on 1090 MHz at 2.4 MSPS.
                </p>
              </Show>
              <Show when={!status()}>
                <p class="text-text-dim">Waiting for the first ADS-B snapshot…</p>
              </Show>
            </div>
          </Show>
        </div>

        {/* Selected aircraft details */}
        <Show when={selected()}>
          {(ac) => (
            <div class="shrink-0 border-t border-border/40 px-2 py-1.5 text-[8px] font-mono">
              <div class="flex items-center gap-2 mb-1">
                <span class="text-cyan uppercase tracking-wider">{label(ac())}</span>
                <span class="text-text-dim">{icaoHex(ac().icao)}</span>
                <Show when={ac().emergency}>
                  <span class="text-amber uppercase">{ac().emergency}</span>
                </Show>
                <button
                  onClick={() => setSelectedIcao(null)}
                  class="ml-auto text-text-dim hover:text-amber uppercase tracking-wider"
                >
                  Close
                </button>
              </div>
              <div class="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-0.5 text-text-secondary">
                <span>ALT <span class="text-text-primary">{altitude(ac())}</span></span>
                <span>GS <span class="text-text-primary">{speed(ac())} kt</span></span>
                <span>TRK <span class="text-text-primary">{heading(ac())}</span></span>
                <span>V/S <span class="text-text-primary">{verticalRate(ac())} fpm</span></span>
                <span>SQK <span class="text-text-primary">{squawk(ac())}</span></span>
                <span>TYPE <span class="text-text-primary">{ac().category ?? '---'}</span></span>
                <span>RSSI <span class="text-text-primary">{ac().rssi_dbfs.toFixed(1)} dBFS</span></span>
                <span>FRM <span class="text-text-primary">{ac().frames}</span></span>
                <span>SRC <span class="text-text-primary">{ac().source === 'Reply' ? 'reply' : 'ES'}</span></span>
                <Show when={ac().lat != null && ac().lon != null}>
                  <span class="col-span-2">
                    POS{' '}
                    <span class="text-text-primary">
                      {(ac().lat as number).toFixed(4)}, {(ac().lon as number).toFixed(4)}
                    </span>
                  </span>
                </Show>
              </div>
            </div>
          )}
        </Show>
      </div>

      {/* ── Map ── */}
      <div class="flex-1 min-h-[220px] md:min-h-0 flex flex-col">
        <div class="shrink-0 flex items-center gap-2 px-2 py-1 border-b border-border/30">
          <span class="text-[8px] font-mono uppercase tracking-wider text-text-dim">OpenStreetMap</span>
          <button
            onClick={() => setFollowSelected((v) => !v)}
            class={`mil-btn text-[8px] px-2 py-0.5 ml-auto ${
              followSelected() ? 'active border-cyan text-cyan' : ''
            }`}
            title="Keep the map centred on the selected aircraft"
          >
            Follow
          </button>
        </div>
        <div class="flex-1 min-h-0">
          <AdsbMap
            aircraft={aircraft()}
            selectedIcao={selectedIcao()}
            followSelected={followSelected()}
            onSelect={setSelectedIcao}
          />
        </div>
      </div>
    </div>
  );
};

export default AdsbDisplay;
