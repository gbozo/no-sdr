// ============================================================
// node-sdr — MSK144 / FSK441 / FST4 / Q65 weak-signal workspace
// ============================================================
// Meteor scatter and long-period weak-signal modes are decode lists, not maps
// or images: the useful view is the table with time, frequency, DT, SNR and
// text.

import { Component, For, Show } from 'solid-js';
import { store } from '../store/index.js';

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  return new Date(sec * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatHz(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return '—';
  return `${(hz / 1e6).toFixed(6)} MHz`;
}

const MeteorDisplay: Component = () => {
  const mode = () => store.decoderMode().toUpperCase();
  const status = () => store.meteorStatus();
  const messages = () => store.meteorMessages();
  const isFst4 = () => store.decoderMode().startsWith('fst4');
  const isQ65 = () => store.decoderMode().startsWith('q65');
  const isJt65 = () => store.decoderMode() === 'jt65';
  const isJt9 = () => store.decoderMode() === 'jt9';
  const isWspr = () => store.decoderMode() === 'wspr';
  const isPi4 = () => store.decoderMode() === 'pi4';
  const period = () => {
    const value = store.decoderMode().replace(/^fst4-?/, '').replace(/^q65-?/, '');
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    if (isFst4() || isJt65() || isJt9() || isPi4()) return 60;
    if (isQ65()) return 30;
    if (isWspr()) return 120;
    return status().period;
  };
  const decodes = () => Math.max(status().decodes, messages().length);
  const emptyText = () => {
    if (isFst4()) {
      return 'Waiting for FST4 decodes — tune to the FST4 calling frequency (e.g. 7.078 MHz USB) and match the period setting.';
    }
    if (isQ65()) {
      return 'Waiting for Q65 decodes — tune to the Q65 calling frequency (e.g. 50.275 MHz USB) and select the matching Q65 sub-mode.';
    }
    if (isJt65()) {
      return 'Waiting for JT65 decodes — tune to 14.076 MHz USB and wait for a 60-second period.';
    }
    if (isJt9()) {
      return 'Waiting for JT9 decodes — tune to 14.078 MHz USB and wait for a 60-second period.';
    }
    if (isWspr()) {
      return 'Waiting for WSPR spots — tune to 14.0956 MHz USB and wait for a 120-second period.';
    }
    if (isPi4()) {
      return 'Waiting for PI4 beacons — tune to 144.471 MHz USB and wait for the minute-boundary transmission.';
    }
    return "Waiting for meteor bursts — tune to 50.260 MHz USB (or the band's calling frequency) and keep the period setting matched to the stations you are hearing.";
  };

  return (
    <div class="flex-1 min-h-0 flex flex-col md:flex-row">
      <div class="flex-1 min-w-0 min-h-0 flex flex-col border-b md:border-b-0 md:border-r border-border/40">
        <div class="flex items-center gap-3 px-2 py-1 border-b border-border/30 bg-sdr-surface/40">
          <span class="text-[8px] font-mono uppercase tracking-wider text-cyan">{mode()}</span>
          <span class="text-[8px] font-mono text-text-dim">
            {status().listening ? 'LISTENING' : 'IDLE'}
          </span>
          <span class="text-[8px] font-mono text-text-dim">
            {status().level.toFixed(1)} dB
          </span>
          <span class="text-[8px] font-mono text-text-dim">
            {period()}s period
          </span>
          <span class="ml-auto text-[8px] font-mono text-text-dim">
            {decodes()} decodes
          </span>
          <button
            type="button"
            onClick={() => store.clearMeteor()}
            class="mil-btn text-[8px] px-1.5 py-0.5 text-red-400 border-red-500/30"
          >
            CLEAR
          </button>
        </div>

        <div class="flex-1 min-h-0 overflow-auto">
          <Show
            when={messages().length > 0}
            fallback={
              <div class="h-full flex items-center justify-center p-6 text-center text-[10px] font-mono text-text-dim leading-relaxed">
                {emptyText()}
              </div>
            }
          >
            <table class="w-full text-[9px] font-mono">
              <thead class="sticky top-0 z-10 bg-sdr-surface text-text-dim">
                <tr>
                  <th class="text-left px-2 py-1">TIME</th>
                  <th class="text-left px-2 py-1">MODE</th>
                  <th class="text-left px-2 py-1">TEXT</th>
                  <th class="text-right px-2 py-1">RF</th>
                  <th class="text-right px-2 py-1">DT</th>
                  <th class="text-right px-2 py-1">SNR</th>
                  <th class="text-right px-2 py-1">CONF/FIT</th>
                </tr>
              </thead>
              <tbody>
                <For each={messages()}>
                  {(message) => (
                    <tr class="border-t border-border/20 align-top">
                      <td class="px-2 py-1 text-text-dim whitespace-nowrap">
                        {formatTime(message.at)}
                      </td>
                      <td class="px-2 py-1 text-cyan/80 uppercase">{message.mode}</td>
                      <td class="px-2 py-1 text-text-primary whitespace-pre-wrap break-words">
                        {message.text}
                      </td>
                      <td class="px-2 py-1 text-right text-text-dim whitespace-nowrap">
                        {formatHz(message.rfHz)}
                      </td>
                      <td class="px-2 py-1 text-right text-text-dim">
                        {message.dtSec.toFixed(2)}s
                      </td>
                      <td class="px-2 py-1 text-right text-text-dim">
                        {message.snrDb.toFixed(0)} dB
                      </td>
                      <td class="px-2 py-1 text-right text-text-dim">
                        {message.variant
                          ? `${message.variant}${message.fit !== undefined ? ` ${Math.round(message.fit * 100)}%` : ''}`
                          : message.confidence !== undefined
                            ? `${Math.round(message.confidence * 100)}%`
                            : '—'}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </div>
      </div>

      <div class="w-full md:w-[280px] shrink-0 p-3 space-y-3 overflow-auto">
        <div class="text-[8px] font-mono uppercase tracking-wider text-text-dim">Mode</div>
        <div class="text-sm font-mono text-text-primary">{mode()}</div>

        <div class="grid grid-cols-2 gap-2 text-[9px] font-mono">
          <div class="border border-border/30 rounded-sm p-2">
            <div class="text-text-dim uppercase text-[8px]">Period</div>
            <div class="text-text-primary">{period()}s</div>
          </div>
          <div class="border border-border/30 rounded-sm p-2">
            <div class="text-text-dim uppercase text-[8px]">Level</div>
            <div class="text-text-primary">{status().level.toFixed(1)} dB</div>
          </div>
          <div class="border border-border/30 rounded-sm p-2">
            <div class="text-text-dim uppercase text-[8px]">Audio</div>
            <div class="text-text-primary">{Math.round(status().audioHz)} Hz</div>
          </div>
          <div class="border border-border/30 rounded-sm p-2">
            <div class="text-text-dim uppercase text-[8px]">Decodes</div>
            <div class="text-text-primary">{decodes()}</div>
          </div>
        </div>

        <div class="text-[9px] font-mono text-text-dim leading-relaxed border-t border-border/30 pt-3">
          <p>
            {isFst4()
              ? 'FST4 decodes one long WSJT period; choose FST4-15 through FST4-1800 in the decoder mode.'
              : isQ65()
                ? 'Q65 decodes one EME/scatter period; choose the Q65 sub-mode in the decoder mode.'
                : isWspr()
                  ? 'WSPR decodes one 120-second propagation-report period.'
                  : isPi4()
                    ? 'PI4 scans a one-minute beacon window for 4-FSK callsign beacons.'
                    : store.decoderMode() === 'fsk441'
                      ? 'FSK441 decodes short meteor pings over a 15 or 30 second period.'
                      : 'MSK144 scans a 15 second period for short meteor bursts.'}
          </p>
          <p class="mt-2">
            Typical tuning: 50.260 MHz USB for meteor scatter; FST4 around
            7.078 MHz, Q65 around 50.275 MHz, JT65/JT9 around 14.076/14.078 MHz,
            WSPR at 14.0956 MHz and PI4 beacons around 144.471 MHz. FSK441
            accepts <span class="text-text-primary">settings.period</span> of 15 or 30.
          </p>
        </div>
      </div>
    </div>
  );
};

export default MeteorDisplay;
