// ============================================================
// node-sdr — Olivia / THOR / FSQ / PSK31 / RTTY text workspace
// ============================================================
// Continuous keyboard modes have no slots and no map. The useful view is a
// running text log plus the modem's tuning/level diagnostics.

import { Component, For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import { store } from '../store/index.js';

const MODE_NAMES: Record<string, string> = {
  olivia: 'OLIVIA',
  thor: 'THOR',
  fsq: 'FSQ',
  psk31: 'PSK31',
  rtty: 'RTTY',
};

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

const TextModeDisplay: Component = () => {
  let logRef: HTMLPreElement | undefined;
  const [showChunks, setShowChunks] = createSignal(false);
  const mode = () => MODE_NAMES[store.decoderMode()] ?? store.decoderMode().toUpperCase();
  const status = () => store.textStatus();
  const messages = () => store.textMessages();
  const joined = createMemo(() => messages().map((message) => message.text).join(''));

  createEffect(() => {
    // Read the length so the effect reruns as text arrives.
    messages().length;
    if (logRef) logRef.scrollTop = logRef.scrollHeight;
  });

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
            {Math.round(status().audioHz)} Hz audio
          </span>
          <span class="ml-auto text-[8px] font-mono text-text-dim">
            {messages().length} chunks
          </span>
          <button
            type="button"
            onClick={() => setShowChunks((value) => !value)}
            class="mil-btn text-[8px] px-1.5 py-0.5"
          >
            {showChunks() ? 'TEXT' : 'CHUNKS'}
          </button>
          <button
            type="button"
            onClick={() => store.clearText()}
            class="mil-btn text-[8px] px-1.5 py-0.5 text-red-400 border-red-500/30"
          >
            CLEAR
          </button>
        </div>

        <Show
          when={showChunks()}
          fallback={
            <pre
              ref={logRef}
              class="flex-1 min-h-0 overflow-auto px-3 py-2 text-[11px] leading-[1.45] font-mono whitespace-pre-wrap break-words text-text-primary bg-sdr-base/30"
            >
              {joined() || 'Waiting for text — tune to the signal and check the mode parameters.'}
            </pre>
          }
        >
          <div class="flex-1 min-h-0 overflow-auto">
            <table class="w-full text-[8px] font-mono">
              <thead class="sticky top-0 z-10 bg-sdr-surface text-text-dim">
                <tr>
                  <th class="text-left px-2 py-1">TIME</th>
                  <th class="text-left px-2 py-1">MODE</th>
                  <th class="text-left px-2 py-1">TEXT</th>
                  <th class="text-right px-2 py-1">RF</th>
                  <th class="text-right px-2 py-1">LEVEL</th>
                </tr>
              </thead>
              <tbody>
                <For each={messages()}>
                  {(message) => (
                    <tr class="border-t border-border/20 align-top">
                      <td class="px-2 py-1 text-text-dim whitespace-nowrap">
                        {formatTime(message.at)}
                      </td>
                      <td class="px-2 py-1 text-cyan/80">{message.mode.toUpperCase()}</td>
                      <td class="px-2 py-1 text-text-primary whitespace-pre-wrap break-words">
                        {message.text}
                      </td>
                      <td class="px-2 py-1 text-right text-text-dim whitespace-nowrap">
                        {formatHz(message.rfHz)}
                      </td>
                      <td class="px-2 py-1 text-right text-text-dim">
                        {message.level.toFixed(1)}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </div>

      <div class="w-full md:w-[310px] shrink-0 p-3 space-y-3 overflow-auto">
        <div class="text-[8px] font-mono uppercase tracking-wider text-text-dim">Mode</div>
        <div class="text-sm font-mono text-text-primary">{mode()}</div>

        <div class="grid grid-cols-2 gap-2 text-[9px] font-mono">
          <div class="border border-border/30 rounded-sm p-2">
            <div class="text-text-dim uppercase text-[8px]">Audio</div>
            <div class="text-text-primary">{Math.round(status().audioHz)} Hz</div>
          </div>
          <div class="border border-border/30 rounded-sm p-2">
            <div class="text-text-dim uppercase text-[8px]">Level</div>
            <div class="text-text-primary">{status().level.toFixed(1)} dB</div>
          </div>
          <div class="border border-border/30 rounded-sm p-2">
            <div class="text-text-dim uppercase text-[8px]">State</div>
            <div class="text-text-primary">{status().listening ? 'Listening' : 'Idle'}</div>
          </div>
          <div class="border border-border/30 rounded-sm p-2">
            <div class="text-text-dim uppercase text-[8px]">Chunks</div>
            <div class="text-text-primary">{messages().length}</div>
          </div>
          <Show when={status().baud !== undefined}>
            <div class="border border-border/30 rounded-sm p-2">
              <div class="text-text-dim uppercase text-[8px]">
                {store.decoderMode() === 'rtty' ? 'Baud' : 'Symbol rate'}
              </div>
              <div class="text-text-primary">{status().baud?.toFixed(2)} Bd</div>
            </div>
          </Show>
          <Show when={status().shiftHz !== undefined}>
            <div class="border border-border/30 rounded-sm p-2">
              <div class="text-text-dim uppercase text-[8px]">Shift</div>
              <div class="text-text-primary">{Math.round(status().shiftHz ?? 0)} Hz</div>
            </div>
          </Show>
          <Show when={status().afcHz !== undefined}>
            <div class="border border-border/30 rounded-sm p-2">
              <div class="text-text-dim uppercase text-[8px]">AFC</div>
              <div class="text-text-primary">{Math.round(status().afcHz ?? 0)} Hz</div>
            </div>
          </Show>
          <Show when={status().reverse !== undefined}>
            <div class="border border-border/30 rounded-sm p-2">
              <div class="text-text-dim uppercase text-[8px]">Tones</div>
              <div class={status().reverse ? 'text-amber' : 'text-text-primary'}>
                {status().reverse ? 'Reversed' : 'Normal'}
              </div>
            </div>
          </Show>
        </div>

        <div class="text-[9px] font-mono text-text-dim leading-relaxed border-t border-border/30 pt-3">
          <p>
            Continuous keyboard modes: text appears as it is decoded; there is no
            slot timer or map.
          </p>
          <p class="mt-2">
            Typical tuning: 14.070 MHz USB for Olivia/THOR/PSK31, 14.080 MHz for RTTY,
            7.104 MHz for FSQ. Olivia supports <span class="text-text-primary">tones</span> and{' '}
            <span class="text-text-primary">bandwidthHz</span>; THOR/FSQ/PSK31 support{' '}
            <span class="text-text-primary">baud</span>; RTTY adds{' '}
            <span class="text-text-primary">shiftHz</span>, <span class="text-text-primary">reverse</span>{' '}
            and <span class="text-text-primary">afc</span>.
          </p>
        </div>
      </div>
    </div>
  );
};

export default TextModeDisplay;
