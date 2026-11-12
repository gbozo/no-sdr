// ============================================================
// node-sdr — ACARS workspace
// ============================================================
// VHF aircraft datalink messages: one row per block, with the decoded header
// fields and body text. ACARS is continuous, not slotted, so there is no
// waterfall pane here — the receiver meter and the rolling message table are
// the useful view.

import { Component, For, Show, createMemo } from 'solid-js';
import { store } from '../store/index.js';

const MAX_ROWS = 250;

function timeOf(at: number, receivedAt?: number): string {
  const ms = receivedAt ?? at * 1000;
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

const AcarsDisplay: Component = () => {
  const status = () => store.acarsStatus();
  const messages = createMemo(() => store.acarsMessages().slice(0, MAX_ROWS));
  const level = () => Math.round(Math.min(1, Math.max(0, status().level)) * 100);

  return (
    <div class="flex-1 min-h-0 flex flex-col bg-sdr-surface/30">
      <div class="shrink-0 px-2 py-1 border-b border-border/30 text-[8px] font-mono">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-text-dim">
          <span class="uppercase tracking-wider text-text-secondary">ACARS</span>
          <span>{messages().length} MSG</span>
          <span>FRM {status().frames}</span>
          <span>BAD {status().bad}</span>
          <span>LVL {level()}%</span>
          <span class="text-text-dim/70">131.550 MHz · AM · 2400 baud</span>
        </div>
      </div>

      <div class="flex-1 min-h-0 overflow-auto">
        <table class="w-full text-[8px] font-mono">
          <thead class="sticky top-0 z-10 bg-sdr-surface">
            <tr>
              <th class="text-left px-1.5 py-1 text-text-dim">TIME</th>
              <th class="text-left px-1.5 py-1 text-text-dim">MODE</th>
              <th class="text-left px-1.5 py-1 text-text-dim">ADDRESS</th>
              <th class="text-left px-1.5 py-1 text-text-dim">LABEL</th>
              <th class="text-left px-1.5 py-1 text-text-dim">BLK</th>
              <th class="text-left px-1.5 py-1 text-text-dim">TEXT</th>
              <th class="text-left px-1.5 py-1 text-text-dim">CRC</th>
            </tr>
          </thead>
          <tbody>
            <For each={messages()}>
              {(message) => (
                <tr class="border-t border-border/20 hover:bg-cyan/5 align-top">
                  <td class="px-1.5 py-1 text-text-dim whitespace-nowrap">
                    {timeOf(message.at, message.receivedAt)}
                  </td>
                  <td class="px-1.5 py-1 text-text-secondary whitespace-nowrap">{message.mode}</td>
                  <td class="px-1.5 py-1 text-text-primary whitespace-nowrap">{message.address}</td>
                  <td class="px-1.5 py-1 text-text-secondary whitespace-nowrap">{message.label}</td>
                  <td class="px-1.5 py-1 text-text-dim whitespace-nowrap">{message.blockId}</td>
                  <td class="px-1.5 py-1 text-text-primary break-all">{message.text}</td>
                  <td
                    class={`px-1.5 py-1 whitespace-nowrap ${
                      message.crcOk ? 'text-cyan' : 'text-amber'
                    }`}
                  >
                    {message.crcOk ? 'OK' : 'BAD'}
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>

        <Show when={messages().length === 0}>
          <div class="px-2 py-3 text-[8px] font-mono space-y-1">
            <p class="text-text-dim">Listening for ACARS…</p>
            <p class="text-text-dim/70">
              Tune to 131.550 / 131.725 MHz in AM mode with a VHF airband antenna. Messages
              arrive as short bursts; a failed block check is still shown (CRC BAD).
            </p>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default AcarsDisplay;
