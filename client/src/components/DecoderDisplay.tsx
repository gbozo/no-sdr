// ============================================================
// node-sdr — Decoder workspace
// ============================================================
// Replaces the lower half of the main waterfall when a foreground decoder is
// active: decode table on the left, receiver-span waterfall on the right.
// Later decoder types can swap the right pane for a map/image view.

import { Component, For, Show, createSignal, onMount, onCleanup } from 'solid-js';
import { store } from '../store/index.js';
import { engine } from '../engine/sdr-engine.js';
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
import MeteorDisplay from './MeteorDisplay.js';
import Js8Display from './Js8Display.js';
import TimeSignalDisplay from './TimeSignalDisplay.js';
import DecoderInfoPanel from './DecoderInfoPanel.js';
import DecoderScope from './DecoderScope.js';

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
  const stats = (data.stats ?? {}) as Record<string, unknown>;
  if (typeof stats.confidence === 'number') return stats.confidence;
  if (typeof stats.hardErrors === 'number') {
    const hard = stats.hardErrors;
    return hard === 0 ? 1 : Math.max(0, 1 - hard / 40);
  }
  return null;
}

const DecoderDisplay: Component = () => {
  const [showInfo, setShowInfo] = createSignal(false);

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
  const isText = () =>
    store.decoderMode() === 'olivia' ||
    store.decoderMode() === 'thor' ||
    store.decoderMode() === 'fsq' ||
    store.decoderMode() === 'psk31' ||
    store.decoderMode() === 'rtty';
  const isMeteor = () =>
    store.decoderMode() === 'msk144' ||
    store.decoderMode() === 'fsk441' ||
    store.decoderMode() === 'fst4' ||
    store.decoderMode() === 'q65' ||
    store.decoderMode() === 'jt65' ||
    store.decoderMode() === 'jt9' ||
    store.decoderMode() === 'wspr' ||
    store.decoderMode() === 'pi4';

  onMount(() => {
    // The decoder pane is mounted only while visible, so this is also the
    // natural place to opt in/out of the zoom-spectrum stream.
    engine.setDecoderScopeEnabled(true);

    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (event.key === 'Escape') {
        setShowInfo(false);
        return;
      }
      if (event.key.toLowerCase() === 'i' && store.decoderMode()) {
        setShowInfo((v) => !v);
        event.preventDefault();
      }
    };
    document.addEventListener('keydown', onKey);
    onCleanup(() => {
      engine.setDecoderScopeEnabled(false);
      document.removeEventListener('keydown', onKey);
    });
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
                }`}
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
            <button
              onClick={() => setShowInfo((v) => !v)}
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
      <div class="flex-1 min-h-0 flex flex-col md:flex-row">
        {/* Decode table */}
        <div class="flex-1 min-w-0 min-h-0 overflow-auto border-b md:border-b-0 md:border-r border-border/40">
          <table class="w-full text-[9px] font-mono">
            <thead class="sticky top-0 z-10 bg-sdr-surface text-text-dim">
              <tr>
                <th class="text-left px-2 py-1">TIME</th>
                <th class="text-left px-2 py-1">MESSAGE</th>
                <th class="text-right px-2 py-1">FREQ</th>
                <th class="text-right px-2 py-1">SNR</th>
                <th class="text-right px-2 py-1">CONF</th>
                <th class="text-right px-2 py-1">FEC</th>
              </tr>
            </thead>
            <tbody>
              <For
                each={store
                  .decoderMessages()
                  .filter((m) => !m.data.kind || m.data.kind === 'decode' || m.data.kind === 'message')
                  .slice(0, MAX_ROWS)}
              >
                {(message) => (
                  <tr class="border-t border-border/20">
                    <td class="px-2 py-1 text-text-dim whitespace-nowrap">
                      {new Date(message.receivedAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </td>
                    <td class="px-2 py-1 text-text-primary break-all">
                      {String(message.data.text ?? '')}
                    </td>
                    <td class="px-2 py-1 text-right text-text-secondary whitespace-nowrap">
                      {formatHz(message.data.rfHz)}
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
                        const stats = (message.data.stats ?? {}) as Record<string, unknown>;
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
          <Show when={store.decoderMessages().length === 0}>
            <p class="text-[9px] font-mono text-text-dim px-2 py-3">Waiting for a slot…</p>
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
      <Show when={isMeteor()}>
        <MeteorDisplay />
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
    </div>
  );
};

export default DecoderDisplay;
