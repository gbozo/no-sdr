// ============================================================
// node-sdr — AIS workspace
// ============================================================
// Vessel table on the left, OpenStreetMap on the right. The server re-sends
// the whole table twice a second; this component only renders it.

import { Component, For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { store } from '../store/index.js';
import AisMap from './AisMap.js';
import type { AisVessel } from '~/shared';

type SortKey = 'name' | 'speed' | 'seen';
type SortDir = 1 | -1;

function label(v: AisVessel): string {
  return v.name.trim() || String(v.mmsi);
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'ClassB': return 'CLS B';
    case 'BaseStation': return 'BASE';
    case 'SarAircraft': return 'SAR';
    case 'AidToNavigation': return 'ATON';
    case 'Sart': return 'SART';
    case 'Craft': return 'CRFT';
    default: return 'CLS A';
  }
}

function speed(v: AisVessel): string {
  return v.sog_kt == null ? '---' : v.sog_kt.toFixed(1);
}

function degrees(value: number | null | undefined): string {
  return value == null ? '---' : `${String(Math.round(value) % 360).padStart(3, '0')}°`;
}

function ageSeconds(v: AisVessel, nowSec: number): number {
  return Math.max(0, Math.round(nowSec - v.last_at));
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}`;
  return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}`;
}

const AisDisplay: Component = () => {
  const [selectedMmsi, setSelectedMmsi] = createSignal<number | null>(null);
  const [followSelected, setFollowSelected] = createSignal(true);
  const [sortKey, setSortKey] = createSignal<SortKey>('name');
  const [sortDir, setSortDir] = createSignal<SortDir>(1);
  const [nowSec, setNowSec] = createSignal(Date.now() / 1000);

  onMount(() => {
    const timer = window.setInterval(() => setNowSec(Date.now() / 1000), 1000);
    onCleanup(() => clearInterval(timer));
  });

  const status = () => store.aisStatus();
  const vessels = () => store.aisVessels();

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
    const rows = [...vessels()];
    rows.sort((a, b) => {
      let result = 0;
      switch (key) {
        case 'speed':
          result = (a.sog_kt ?? -1) - (b.sog_kt ?? -1);
          break;
        case 'seen':
          result = a.last_at - b.last_at;
          break;
        default:
          result = label(a).localeCompare(label(b), undefined, { numeric: true });
          break;
      }
      if (result === 0) result = a.mmsi - b.mmsi;
      return result * dir;
    });
    return rows;
  });

  const selected = createMemo(() => {
    const mmsi = selectedMmsi();
    if (mmsi == null) return null;
    return vessels().find((v) => v.mmsi === mmsi) ?? null;
  });

  const headerClass = (key: SortKey) =>
    `px-1.5 py-1 cursor-pointer select-none hover:text-cyan ${
      sortKey() === key ? 'text-cyan' : 'text-text-dim'
    }`;

  return (
    <div class="flex-1 min-h-0 flex flex-col md:flex-row">
      {/* ── Vessel table ── */}
      <div class="flex flex-col min-w-0 min-h-0 md:w-[46%] border-b md:border-b-0 md:border-r border-border/40">
        <div class="shrink-0 px-2 py-1 border-b border-border/30 text-[8px] font-mono leading-relaxed">
          <Show when={status()?.unavailable}>
            {(message) => (
              <div class="text-amber">
                <span class="uppercase tracking-wider">AIS unavailable:</span> {message()}
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
                Tune the dongle to {(hz() / 1e6).toFixed(3)} MHz with at least 100 kHz of span.
              </div>
            )}
          </Show>
          <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-text-dim">
            <span class="uppercase tracking-wider text-text-secondary">AIS</span>
            <span>{vessels().length} VESSELS</span>
            <Show when={status()}>
              {(s) => (
                <>
                  <span>MSG {s().messages}</span>
                  <span>BST {s().bursts}</span>
                  <span>FCS {s().badFcs}</span>
                  <span>UNS {s().unsupported}</span>
                  <span>SPB {s().samplesPerBit.toFixed(1)}</span>
                  <Show when={s().offsetHz != null}>
                    <span>OFF {Math.round(s().offsetHz as number)} Hz</span>
                  </Show>
                  <span>
                    {(s().windowCenterHz / 1e6).toFixed(3)} MHz ·{' '}
                    {(s().windowRateHz / 1e6).toFixed(2)} MSPS
                  </span>
                  <span>
                    {s().channels.map((c) => `${c.label}${c.live ? '' : '*'}`).join(' ')}
                  </span>
                </>
              )}
            </Show>
          </div>
        </div>

        <div class="flex-1 min-h-0 overflow-auto">
          <table class="w-full text-[8px] font-mono">
            <thead class="sticky top-0 z-10 bg-sdr-surface">
              <tr>
                <th class="text-left px-1.5 py-1 text-text-dim">MMSI</th>
                <th class={`text-left ${headerClass('name')}`} onClick={() => toggleSort('name', 1)}>
                  NAME
                </th>
                <th class="text-left px-1.5 py-1 text-text-dim">TYPE</th>
                <th class={`text-right ${headerClass('speed')}`} onClick={() => toggleSort('speed', -1)}>
                  SOG
                </th>
                <th class="text-right px-1.5 py-1 text-text-dim">COG</th>
                <th class="text-right px-1.5 py-1 text-text-dim">HDG</th>
                <th class="text-left px-1.5 py-1 text-text-dim">DEST</th>
                <th class={`text-right ${headerClass('seen')}`} onClick={() => toggleSort('seen', -1)}>
                  AGE
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={sorted()}>
                {(vessel) => {
                  const isSelected = () => selectedMmsi() === vessel.mmsi;
                  return (
                    <tr
                      onClick={() => setSelectedMmsi(isSelected() ? null : vessel.mmsi)}
                      class={`border-t border-border/20 cursor-pointer ${
                        isSelected() ? 'bg-cyan/10 text-cyan' : ''
                      } hover:bg-cyan/5`}
                    >
                      <td class="px-1.5 py-1 whitespace-nowrap text-text-dim">{vessel.mmsi}</td>
                      <td class="px-1.5 py-1 whitespace-nowrap text-text-primary">{label(vessel)}</td>
                      <td class="px-1.5 py-1 whitespace-nowrap text-text-secondary">
                        {kindLabel(vessel.kind)}
                      </td>
                      <td class="px-1.5 py-1 text-right whitespace-nowrap">{speed(vessel)}</td>
                      <td class="px-1.5 py-1 text-right whitespace-nowrap">{degrees(vessel.cog_deg)}</td>
                      <td class="px-1.5 py-1 text-right whitespace-nowrap">{degrees(vessel.heading_deg)}</td>
                      <td class="px-1.5 py-1 truncate max-w-[110px] text-text-secondary">
                        {vessel.destination || ''}
                      </td>
                      <td class="px-1.5 py-1 text-right whitespace-nowrap text-text-dim">
                        {formatAge(ageSeconds(vessel, nowSec()))}
                      </td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>

          <Show when={vessels().length === 0}>
            <div class="px-2 py-3 text-[8px] font-mono space-y-1">
              <Show
                when={status()?.unavailable}
                fallback={<p class="text-text-dim">No vessels heard</p>}
              >
                <p class="text-amber">No vessels heard — the receiver cannot decode AIS here.</p>
              </Show>
              <Show when={status() && !status()?.unavailable}>
                <p class="text-text-dim">
                  Waiting for an AIS burst. Tune to 162.000 MHz with at least 100 kHz of span;
                  marine VHF traffic is line-of-sight.
                </p>
              </Show>
              <Show when={!status()}>
                <p class="text-text-dim">Waiting for the first AIS snapshot…</p>
              </Show>
            </div>
          </Show>
        </div>

        <Show when={selected()}>
          {(vessel) => (
            <div class="shrink-0 border-t border-border/40 px-2 py-1.5 text-[8px] font-mono">
              <div class="flex items-center gap-2 mb-1">
                <span class="text-cyan uppercase tracking-wider">{label(vessel())}</span>
                <span class="text-text-dim">{vessel().mmsi}</span>
                <button
                  onClick={() => setSelectedMmsi(null)}
                  class="ml-auto text-text-dim hover:text-amber uppercase tracking-wider"
                >
                  Close
                </button>
              </div>
              <div class="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-0.5 text-text-secondary">
                <span>TYPE <span class="text-text-primary">{kindLabel(vessel().kind)}</span></span>
                <span>CALL <span class="text-text-primary">{vessel().call_sign || '---'}</span></span>
                <span>IMO <span class="text-text-primary">{vessel().imo ?? '---'}</span></span>
                <span>SOG <span class="text-text-primary">{speed(vessel())} kt</span></span>
                <span>COG <span class="text-text-primary">{degrees(vessel().cog_deg)}</span></span>
                <span>HDG <span class="text-text-primary">{degrees(vessel().heading_deg)}</span></span>
                <span>DEST <span class="text-text-primary">{vessel().destination || '---'}</span></span>
                <span>ETA <span class="text-text-primary">{vessel().eta || '---'}</span></span>
                <span>DRAUGHT <span class="text-text-primary">{vessel().draught_m ?? '---'} m</span></span>
                <span>RSSI <span class="text-text-primary">{vessel().rssi_dbfs.toFixed(1)} dBFS</span></span>
                <span>SNR <span class="text-text-primary">{vessel().snr_db.toFixed(1)} dB</span></span>
                <span>CH <span class="text-text-primary">{vessel().channel}</span></span>
                <span>FRM <span class="text-text-primary">{vessel().messages}</span></span>
                <span>TYPE# <span class="text-text-primary">{vessel().last_type}</span></span>
                <Show when={vessel().lat != null && vessel().lon != null}>
                  <span class="col-span-2">
                    POS{' '}
                    <span class="text-text-primary">
                      {(vessel().lat as number).toFixed(4)}, {(vessel().lon as number).toFixed(4)}
                    </span>
                  </span>
                </Show>
              </div>
              <Show when={vessel().nmea}>
                <div class="mt-1 text-text-dim truncate" title={vessel().nmea}>
                  {vessel().nmea}
                </div>
              </Show>
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
            title="Keep the map centred on the selected vessel"
          >
            Follow
          </button>
        </div>
        <div class="flex-1 min-h-0">
          <AisMap
            vessels={vessels()}
            selectedMmsi={selectedMmsi()}
            followSelected={followSelected()}
            onSelect={setSelectedMmsi}
          />
        </div>
      </div>
    </div>
  );
};

export default AisDisplay;
