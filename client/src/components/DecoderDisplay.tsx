// ============================================================
// node-sdr — Decoder workspace
// ============================================================
// Replaces the lower half of the main waterfall when a foreground decoder is
// active: decode table on the left, receiver-span waterfall on the right.
// Later decoder types can swap the right pane for a map/image view.

import { Component, For, Show, createEffect, createSignal, onMount, onCleanup } from 'solid-js';
import { store } from '../store/index.js';
import { engine } from '../engine/sdr-engine.js';
import { fetchDecoderHistory, type DecoderHistoryMessage } from '../engine/decoder-history.js';
import { formatGridCenter, extractGridFromText } from '~/shared';
import AdsbDisplay from './AdsbDisplay.js';
import AcarsDisplay from './AcarsDisplay.js';
import AisDisplay from './AisDisplay.js';
import Vdl2Display from './Vdl2Display.js';
import HfdlDisplay from './HfdlDisplay.js';
import AprsDisplay from './AprsDisplay.js';
import NavtexDisplay from './NavtexDisplay.js';
import IsmDisplay from './IsmDisplay.js';
import PacketDisplay from './PacketDisplay.js';
import WefaxDisplay from './WefaxDisplay.js';
import SstvDisplay from './SstvDisplay.js';
import HellDisplay from './HellDisplay.js';
import TextModeDisplay from './TextModeDisplay.js';
import Js8Display from './Js8Display.js';
import TimeSignalDisplay from './TimeSignalDisplay.js';
import DecoderInfoPanel from './DecoderInfoPanel.js';
import DecoderHistoryPanel from './DecoderHistoryPanel.js';
import DecoderScope from './DecoderScope.js';
import DecoderDetails from './DecoderDetails.js';

const DECODERS = [
  { id: 'ft8', label: 'FT8' },
  { id: 'ft4', label: 'FT4' },
  { id: 'ft2', label: 'FT2' },
  { id: 'fst4', label: 'FST4' },
  { id: 'q65', label: 'Q65' },
  { id: 'jt65', label: 'JT65' },
  { id: 'jt9', label: 'JT9' },
  { id: 'wspr', label: 'WSPR' },
  { id: 'pi4', label: 'PI4' },
  { id: 'adsb', label: 'ADS-B' },
  { id: 'acars', label: 'ACARS' },
  { id: 'ais', label: 'AIS' },
  { id: 'vdl2', label: 'VDL2' },
  { id: 'hfdl', label: 'HFDL' },
  { id: 'aprs', label: 'APRS' },
  { id: 'navtex', label: 'NAVTEX' },
  { id: 'packet', label: 'PACKET' },
  { id: 'ism', label: 'ISM' },
  { id: 'wefax', label: 'WEFAX' },
  { id: 'sstv', label: 'SSTV' },
  { id: 'hell', label: 'HELL' },
  { id: 'msk144', label: 'MSK144' },
  { id: 'fsk441', label: 'FSK441' },
  { id: 'olivia', label: 'OLIVIA' },
  { id: 'thor', label: 'THOR' },
  { id: 'fsq', label: 'FSQ' },
  { id: 'psk31', label: 'PSK31' },
  { id: 'rtty', label: 'RTTY' },
  { id: 'js8', label: 'JS8' },
  { id: 'dcf77', label: 'DCF77' },
  { id: 'als162', label: 'ALS162' },
] as const;

const MAX_ROWS = 160;

function formatHz(hz: unknown): string {
  const value = typeof hz === 'number' ? hz : Number(hz);
  if (!Number.isFinite(value)) return '';
  return `${(value / 1e6).toFixed(6)}`;
}

function decodeConfidence(data: Record<string, unknown>): number | null {
  if (typeof data.confidence === 'number') return data.confidence;
  const stats = (data.stats ?? {}) as Record<string, unknown>;
  if (typeof stats.confidence === 'number') return stats.confidence;
  if (typeof stats.hardErrors === 'number') {
    const hard = stats.hardErrors;
    return hard === 0 ? 1 : Math.max(0, 1 - hard / 40);
  }
  return null;
}

/** Matches base modes and their period/sub-mode variants (fst4-60, q65-30). */
function modeMatches(candidate: string, active: string): boolean {
  const c = candidate.trim().toLowerCase();
  const a = active.trim().toLowerCase();
  return c === a || c.startsWith(`${a}-`) || a.startsWith(`${c}-`);
}

/** Mode-specific hint shown while the weak-signal table is empty. */
function weakSignalEmptyText(mode: string): string {
  const m = mode.toLowerCase();
  if (m.startsWith('fst4')) {
    return 'Waiting for FST4 decodes — tune to the FST4 calling frequency (e.g. 7.078 MHz USB) and match the period setting.';
  }
  if (m.startsWith('q65')) {
    return 'Waiting for Q65 decodes — tune to the Q65 calling frequency (e.g. 50.275 MHz USB) and select the matching Q65 sub-mode.';
  }
  if (m === 'jt65') {
    return 'Waiting for JT65 decodes — tune to 14.076 MHz USB and wait for a 60-second period.';
  }
  if (m === 'jt9') {
    return 'Waiting for JT9 decodes — tune to 14.078 MHz USB and wait for a 60-second period.';
  }
  if (m === 'wspr') {
    return 'Waiting for WSPR spots — tune to 14.0956 MHz USB and wait for a 120-second period.';
  }
  if (m === 'pi4') {
    return 'Waiting for PI4 beacons — tune to 144.471 MHz USB and wait for the minute-boundary transmission.';
  }
  if (m === 'msk144' || m === 'fsk441') {
    return "Waiting for meteor bursts — tune to 50.260 MHz USB (or the band's calling frequency) and keep the period setting matched to the stations you are hearing.";
  }
  return 'Waiting for a slot…';
}

interface TableRow {
  decoderType: string;
  data: Record<string, unknown>;
  receivedAt: number;
  historical?: boolean;
}

/** Live rows and persisted rows describe the same decode when the mode,
 *  slot/period, RF offset and text match. Used to keep the merged table free
 *  of duplicates while a slot is being written and broadcast. */
function decodeKey(decoderType: string, data: Record<string, unknown>): string {
  return [
    decoderType.toLowerCase(),
    Math.round(Number(data.rfHz ?? data.frequencyHz ?? 0)),
    String(data.period ?? ''),
    String(data.text ?? ''),
  ].join('|');
}

const DecoderDisplay: Component = () => {
  const [showInfo, setShowInfo] = createSignal(false);
  const [showHistory, setShowHistory] = createSignal(false);
  const [historyRows, setHistoryRows] = createSignal<DecoderHistoryMessage[]>([]);

  const isAdsb = () => store.decoderMode() === 'adsb';
  const isAcars = () => store.decoderMode() === 'acars';
  const isAis = () => store.decoderMode() === 'ais';
  const isVdl2 = () => store.decoderMode() === 'vdl2';
  const isHfdl = () => store.decoderMode() === 'hfdl';
  const isAprs = () => store.decoderMode() === 'aprs';
  const isNavtex = () => store.decoderMode() === 'navtex';
  const isPacket = () => store.decoderMode() === 'packet';
  const isIsm = () => store.decoderMode() === 'ism';
  const isWefax = () => store.decoderMode() === 'wefax';
  const isSstv = () => store.decoderMode() === 'sstv';
  const isHell = () => store.decoderMode() === 'hell';
  const isJs8 = () => store.decoderMode() === 'js8';
  const isTimeSignal = () => store.decoderMode() === 'dcf77' || store.decoderMode() === 'als162';
  /** WSJT-family / weak-signal modes share the decode table + zoom scope UI. */
  const isWeakSignal = () => {
    const mode = store.decoderMode();
    return (
      mode === 'ft8' ||
      mode === 'ft4' ||
      mode === 'ft2' ||
      mode === 'jt65' ||
      mode === 'jt9' ||
      mode === 'wspr' ||
      mode === 'pi4' ||
      mode === 'msk144' ||
      mode === 'fsk441' ||
      mode.startsWith('fst4') ||
      mode.startsWith('q65')
    );
  };
  /** These modes arrive through the dedicated meteor message store. */
  const usesMeteorMessages = () =>
    isWeakSignal() && !['ft8', 'ft4', 'ft2'].includes(store.decoderMode());
  /** True when any published frequency for this decoder is inside the profile span. */
  const decoderInRange = (id: string): boolean => {
    const frequencies = store.decoderFrequenciesFor(id);
    const half = store.sampleRate() / 2;
    const center = store.centerFrequency();
    if (half <= 0 || frequencies.length === 0) return false;
    return frequencies.some((f) => f.hz >= center - half && f.hz <= center + half);
  };
  const isText = () =>
    store.decoderMode() === 'olivia' ||
    store.decoderMode() === 'thor' ||
    store.decoderMode() === 'fsq' ||
    store.decoderMode() === 'psk31' ||
    store.decoderMode() === 'rtty';

  // Load previous decodes for the active mode. The history panel offers deep
  // browsing (search/date range); this copy is merged into the live table so
  // switching to FT8 immediately shows the stored log instead of an empty pane.
  createEffect(() => {
    const mode = store.decoderMode();
    if (!mode) {
      setHistoryRows([]);
      return;
    }
    let active = true;
    const until = Date.now();
    fetchDecoderHistory({ mode, limit: 500, until })
      .then((page) => {
        if (active) setHistoryRows(page.messages);
      })
      .catch(() => {
        if (active) setHistoryRows([]);
      });
    onCleanup(() => {
      active = false;
    });
  });

  /** Convert weak-signal meteor-store decodes into generic table rows. */
  const meteorTableRows = (): TableRow[] => {
    if (!usesMeteorMessages()) return [];
    return store.meteorMessages()
      .filter((message) => modeMatches(message.mode, store.decoderMode()))
      .map((message) => ({
        decoderType: message.mode || store.decoderMode(),
        receivedAt:
          (message.at > 0 ? message.at : Date.now() / 1000) * 1000,
        data: {
          kind: 'decode',
          text: message.text,
          rfHz: message.rfHz,
          audioHz: message.audioHz,
          snrDb: message.snrDb,
          dtSec: message.dtSec,
          period: message.period,
          confidence: message.confidence,
          variant: message.variant,
          fit: message.fit,
          stats: {
            crcOk: true,
            confidence: message.confidence,
            hardErrors: message.hardErrors,
          },
        } as Record<string, unknown>,
      }));
  };

  const liveRows = (): TableRow[] => {
    const mode = store.decoderMode();
    const generic = store.decoderMessages().filter((message) => {
      const kindOk =
        !message.data.kind ||
        message.data.kind === 'decode' ||
        message.data.kind === 'message';
      return kindOk && (!mode || modeMatches(message.decoderType, mode));
    });
    return [...generic, ...meteorTableRows()];
  };

  const historyTableRows = (): TableRow[] =>
    historyRows()
      .filter(
        (message) =>
          !store.decoderMode() || modeMatches(message.mode, store.decoderMode()),
      )
      .map((message) => ({
        decoderType: message.mode,
        receivedAt: message.receivedMs,
        historical: true,
        data: {
          ...(message.payload ?? {}),
          text: message.text,
          rfHz: message.frequencyHz,
          audioHz: message.audioHz,
          snrDb: message.snrDb,
          dtSec: message.dtSec,
          period: message.period,
        },
      }));

  const mergedRows = (): TableRow[] => {
    const live = liveRows();
    const seen = new Set(
      live.map((message) => decodeKey(message.decoderType, message.data)),
    );
    const older = historyTableRows().filter(
      (message) => !seen.has(decodeKey(message.decoderType, message.data)),
    );
    return [...live, ...older]
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .slice(0, MAX_ROWS);
  };

  const gridOf = (message: TableRow): string => {
    const fromServer = message.data.grid;
    if (typeof fromServer === 'string' && fromServer) return fromServer.toUpperCase();
    return extractGridFromText(message.decoderType, String(message.data.text ?? ''));
  };

  onMount(() => {
    // The decoder pane is mounted only while visible, so this is also the
    // natural place to opt in/out of the zoom-spectrum stream.
    engine.setDecoderScopeEnabled(true);

    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (event.key === 'Escape') {
        if (showHistory()) {
          setShowHistory(false);
          return;
        }
        setShowInfo(false);
        return;
      }
      if (event.key.toLowerCase() === 'i' && store.decoderMode()) {
        setShowHistory(false);
        setShowInfo((v) => !v);
        event.preventDefault();
      }
      if (event.key.toLowerCase() === 'h' && store.decoderMode()) {
        setShowInfo(false);
        setShowHistory((v) => !v);
        event.preventDefault();
      }
    };
    document.addEventListener('keydown', onKey);
    onCleanup(() => {
      engine.setDecoderScopeEnabled(false);
      document.removeEventListener('keydown', onKey);
    });
  });

  // Leaving the decoder workspace should not leave an overlay armed for the
  // next mode the user selects.
  createEffect(() => {
    if (!store.decoderMode()) {
      setShowHistory(false);
      setShowInfo(false);
    }
  });

  const select = (id: string) => {
    engine.setDecoder(store.decoderMode() === id ? '' : id);
  };

  const choose = (id: string) => {
    if (!id) return;
    engine.setDecoder(id);
  };

  return (
    <div class="relative flex flex-col h-full min-h-0 bg-sdr-surface/30">
      <div class="flex items-center gap-2 px-2 py-1 border-b border-border/40 shrink-0 min-w-0">
        <span class="hidden sm:inline text-[9px] font-mono uppercase tracking-wider text-text-dim shrink-0">Digital Decoder</span>
        {/* Small screens: one compact picker instead of a full chip row. */}
        <select
          class="lg:hidden flex-1 min-w-0 bg-sdr-base border border-border/50 rounded-sm text-[10px] font-mono text-text-secondary px-1 py-0.5"
          value={store.decoderMode()}
          onChange={(e) => choose(e.currentTarget.value)}
          title="Select digital decoder"
        >
          <option value="">Decoder…</option>
          <For each={DECODERS}>
            {(decoder) => <option value={decoder.id}>{decoder.label}</option>}
          </For>
        </select>
        <div class="hidden lg:flex flex-1 min-w-0 items-center gap-1 overflow-x-auto">
          <For each={DECODERS}>
            {(decoder) => (
              <button
                onClick={() => select(decoder.id)}
                class={`mil-btn text-[10px] px-2 py-0.5 shrink-0 ${
                  store.decoderMode() === decoder.id ? 'active border-cyan text-cyan' : ''
                } ${decoderInRange(decoder.id) ? 'decoder-in-range' : ''}`}
                title={
                  decoderInRange(decoder.id)
                    ? `${decoder.label} — has typical frequencies in the current receiver span`
                    : decoder.label
                }
              >
                {decoder.label}
              </button>
            )}
          </For>
        </div>
        <div class="ml-auto flex items-center gap-1 shrink-0">
          <Show when={store.pushServerConfig()?.identifyEnabled !== false}>
            <button
              onClick={() => store.setIdentifierOpen(true)}
              class="mil-btn text-[9px] px-1.5 py-0.5"
              title="Capture raw IQ and identify the tuned signal"
            >
              Identify
            </button>
          </Show>
          <Show when={store.decoderMode()}>
            <Show when={usesMeteorMessages()}>
              <button
                onClick={() => store.clearMeteor()}
                class="mil-btn text-[9px] px-1.5 py-0.5 text-red-400/80 border-red-500/30 hover:text-red-400"
                title="Clear live decodes for this mode"
              >
                Clear
              </button>
            </Show>
            <button
              onClick={() => {
                setShowInfo(false);
                setShowHistory((v) => !v);
              }}
              class={`mil-btn text-[9px] px-1.5 py-0.5 ${showHistory() ? 'active border-cyan text-cyan' : ''}`}
              title="Browse decodes stored by the background decoder (H)"
            >
              History
            </button>
            <button
              onClick={() => {
                setShowHistory(false);
                setShowInfo((v) => !v);
              }}
              class={`mil-btn text-[9px] px-1.5 py-0.5 ${showInfo() ? 'active border-cyan text-cyan' : ''}`}
              title="Decoder information and typical frequencies (I)"
            >
              ⓘ Info
            </button>
            <button
              onClick={() => engine.setDecoder('')}
              class="text-[9px] font-mono uppercase tracking-wider text-text-dim hover:text-amber px-1"
            >
              Off
            </button>
          </Show>
        </div>
      </div>

      <Show when={!isAdsb() && !isAcars() && !isAis() && !isVdl2() && !isHfdl() && !isAprs() && !isNavtex() && !isPacket() && !isIsm() && !isWefax() && !isSstv() && !isHell() && !isText() && !isJs8() && !isTimeSignal()}>
      {/* All WSJT weak-signal modes share the reference/live details strip,
          decode table and secondary waterfall. */}
      <Show when={isWeakSignal()}>
        <DecoderDetails mode={store.decoderMode()} />
      </Show>
      <div class="flex-1 min-h-0 flex flex-col md:flex-row">
        {/* Decode table */}
        <div class="flex-1 min-w-0 min-h-0 overflow-auto border-b md:border-b-0 md:border-r border-border/40">
          <table class="w-full text-[9px] font-mono">
            <thead class="sticky top-0 z-10 bg-sdr-surface text-text-dim">
              <tr>
                <th class="text-left px-2 py-1">TIME</th>
                <th class="text-left px-2 py-1">MESSAGE</th>
                <th class="text-left px-2 py-1">GRID</th>
                <th class="text-right px-2 py-1">FREQ</th>
                <th class="text-right px-2 py-1">DT</th>
                <th class="text-right px-2 py-1">SNR</th>
                <th class="text-right px-2 py-1">CONF</th>
                <th class="text-right px-2 py-1">FEC</th>
              </tr>
            </thead>
            <tbody>
              <For each={mergedRows()}>
                {(message) => (
                  <tr class="border-t border-border/20">
                    <td class="px-2 py-1 text-text-dim whitespace-nowrap">
                      {new Date(message.receivedAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                      <Show when={message.historical}>
                        <span class="text-cyan/50 ml-1" title="Restored from stored history">·</span>
                      </Show>
                    </td>
                    <td class="px-2 py-1 text-text-primary break-all">
                      {String(message.data.text ?? '')}
                    </td>
                    <td
                      class="px-2 py-1 text-text-secondary whitespace-nowrap uppercase"
                      title={formatGridCenter(gridOf(message)) || undefined}
                    >
                      {gridOf(message)}
                    </td>
                    <td class="px-2 py-1 text-right text-text-secondary whitespace-nowrap">
                      {formatHz(message.data.rfHz)}
                    </td>
                    <td class="px-2 py-1 text-right text-text-dim">
                      {typeof message.data.dtSec === 'number'
                        ? `${message.data.dtSec.toFixed(2)}s`
                        : ''}
                    </td>
                    <td class="px-2 py-1 text-right text-text-dim">
                      {typeof message.data.snrDb === 'number'
                        ? `${Math.round(message.data.snrDb)}`
                        : ''}
                    </td>
                    <td class="px-2 py-1 text-right text-text-dim">
                      {(() => {
                        const confidence = decodeConfidence(message.data);
                        return confidence === null ? '' : `${Math.round(confidence * 100)}%`;
                      })()}
                    </td>
                    <td class="px-2 py-1 text-right whitespace-nowrap">
                      {(() => {
                        const data = message.data;
                        const variant = typeof data.variant === 'string' ? data.variant : '';
                        if (variant) {
                          const fit = typeof data.fit === 'number'
                            ? ` ${Math.round(data.fit * 100)}%`
                            : '';
                          return <span class="text-cyan/80">{variant}{fit}</span>;
                        }
                        const stats = (data.stats ?? {}) as Record<string, unknown>;
                        const hard = typeof stats.hardErrors === 'number' ? stats.hardErrors : 0;
                        if (stats.crcOk === false) {
                          return <span class="text-amber">BAD</span>;
                        }
                        return hard > 0 ? (
                          <span class="text-amber">FEC {hard}</span>
                        ) : (
                          <span class="text-cyan/80">OK</span>
                        );
                      })()}
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
          <Show when={mergedRows().length === 0}>
            <p class="text-[9px] font-mono text-text-dim px-2 py-3">
              {weakSignalEmptyText(store.decoderMode())}
            </p>
          </Show>
        </div>

        <DecoderScope />
      </div>
      </Show>
      <Show when={isAdsb()}>
        <AdsbDisplay />
      </Show>
      <Show when={isAcars()}>
        <AcarsDisplay />
      </Show>
      <Show when={isAis()}>
        <AisDisplay />
      </Show>
      <Show when={isVdl2()}>
        <Vdl2Display />
      </Show>
      <Show when={isHfdl()}>
        <HfdlDisplay />
      </Show>
      <Show when={isAprs()}>
        <AprsDisplay />
      </Show>
      <Show when={isNavtex()}>
        <NavtexDisplay />
      </Show>
      <Show when={isPacket()}>
        <PacketDisplay />
      </Show>
      <Show when={isIsm()}>
        <IsmDisplay />
      </Show>
      <Show when={isWefax()}>
        <WefaxDisplay />
      </Show>
      <Show when={isSstv()}>
        <SstvDisplay />
      </Show>
      <Show when={isHell()}>
        <HellDisplay />
      </Show>
      <Show when={isText()}>
        <TextModeDisplay />
      </Show>
      <Show when={isJs8()}>
        <Js8Display />
      </Show>
      <Show when={isTimeSignal()}>
        <TimeSignalDisplay />
      </Show>
      <Show when={showInfo() && store.decoderMode()}>
        <DecoderInfoPanel mode={store.decoderMode()} onClose={() => setShowInfo(false)} />
      </Show>
      <Show when={showHistory() && store.decoderMode()}>
        <DecoderHistoryPanel
          mode={store.decoderMode()}
          onClose={() => setShowHistory(false)}
        />
      </Show>
    </div>
  );
};

export default DecoderDisplay;
