// ============================================================
// JS8 — message table + heard-station list
// ============================================================

import { Component, For, Show, createMemo, createSignal } from 'solid-js';
import { store } from '../store/index.js';
import type { Js8Message } from '~/shared';

function formatTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '--:--:--';
  return new Date(at * 1000).toLocaleTimeString([], { hour12: false });
}

function formatHz(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return '';
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(6)} MHz`;
  return `${(hz / 1_000).toFixed(1)} kHz`;
}

const Js8Display: Component = () => {
  const [selected, setSelected] = createSignal<Js8Message | null>(null);
  const messages = () => store.js8Messages();
  const status = () => store.js8Status();
  const selectedMessage = createMemo(() => selected() ?? messages()[0] ?? null);

  return (
    <div class="flex-1 min-h-0 flex flex-col md:flex-row">
      <div class="flex-1 min-w-0 min-h-0 overflow-auto border-b md:border-b-0 md:border-r border-border/40">
        <div class="sticky top-0 z-10 bg-sdr-surface px-2 py-1 flex items-center gap-3 text-[8px] font-mono uppercase tracking-wider text-text-dim border-b border-border/30">
          <span class="text-cyan">JS8</span>
          <span>{status().speed.toUpperCase()}</span>
          <span>{status().period}s</span>
          <span>{status().decodes} decodes</span>
          <span class="ml-auto">{status().listening ? `LEVEL ${status().level.toFixed(0)} dB` : 'LISTENING'}</span>
        </div>
        <table class="w-full text-[8px] font-mono">
          <thead class="sticky top-[22px] z-10 bg-sdr-surface text-text-dim">
            <tr>
              <th class="text-left px-2 py-1">TIME</th>
              <th class="text-left px-2 py-1">FROM</th>
              <th class="text-left px-2 py-1">TO</th>
              <th class="text-left px-2 py-1">MESSAGE</th>
              <th class="text-right px-2 py-1">FREQ</th>
              <th class="text-right px-2 py-1">SNR</th>
            </tr>
          </thead>
          <tbody>
            <For each={messages().slice(0, 500)}>
              {(message) => (
                <tr
                  class={`border-t border-border/15 cursor-pointer hover:bg-cyan/5 ${
                    selectedMessage() === message ? 'bg-cyan/10' : ''
                  }`}
                  onClick={() => setSelected(message)}
                >
                  <td class="px-2 py-0.5 text-text-dim whitespace-nowrap">{formatTime(message.at)}</td>
                  <td class="px-2 py-0.5 text-cyan whitespace-nowrap">{message.from || '—'}</td>
                  <td class="px-2 py-0.5 text-amber whitespace-nowrap">{message.to || '—'}</td>
                  <td class="px-2 py-0.5 text-text-primary">
                    <Show when={message.toMe}><span class="text-green-400 mr-1">*</span></Show>
                    {message.cmd ? `${message.cmd} ` : ''}{message.text}
                  </td>
                  <td class="px-2 py-0.5 text-right text-text-dim whitespace-nowrap">{formatHz(message.rfHz)}</td>
                  <td class="px-2 py-0.5 text-right text-text-dim">{message.snrDb.toFixed(0)}</td>
                </tr>
              )}
            </For>
            <Show when={messages().length === 0}>
              <tr>
                <td colspan="6" class="px-3 py-6 text-center text-text-dim">
                  Waiting for JS8 traffic — tune 7.078 MHz USB. Default speed is NORMAL.
                </td>
              </tr>
            </Show>
          </tbody>
        </table>
      </div>

      <div class="w-full md:w-[320px] shrink-0 min-h-0 overflow-auto p-3 space-y-3">
        <div>
          <h4 class="text-[9px] font-mono uppercase tracking-wider text-text-dim mb-1">Heard stations</h4>
          <div class="flex flex-wrap gap-1">
            <For each={status().heard.slice(0, 60)}>
              {(heard) => (
                <span class="px-1.5 py-0.5 text-[8px] font-mono border border-border/40 rounded-sm text-text-primary">
                  {heard.call}
                </span>
              )}
            </For>
            <Show when={status().heard.length === 0}>
              <span class="text-[9px] font-mono text-text-dim">No stations decoded in this session.</span>
            </Show>
          </div>
        </div>

        <Show when={selectedMessage()}>
          {(message) => (
            <div class="border-t border-border/30 pt-3 space-y-1">
              <h4 class="text-[9px] font-mono uppercase tracking-wider text-text-dim">Message</h4>
              <div class="grid grid-cols-[70px_1fr] gap-x-2 gap-y-1 text-[9px] font-mono">
                <span class="text-text-dim">From</span><span class="text-cyan">{message().from || '—'}</span>
                <span class="text-text-dim">To</span><span class="text-amber">{message().to || '—'}</span>
                <span class="text-text-dim">Command</span><span>{message().cmd || '—'}</span>
                <span class="text-text-dim">Speed</span><span class="uppercase">{message().speed}</span>
                <span class="text-text-dim">Frames</span><span>{message().frames} {message().complete ? '(complete)' : '(partial)'}</span>
                <span class="text-text-dim">RF</span><span>{formatHz(message().rfHz)}</span>
                <span class="text-text-dim">Audio</span><span>{message().audioHz.toFixed(0)} Hz</span>
                <span class="text-text-dim">SNR</span><span>{message().snrDb.toFixed(1)} dB</span>
                <span class="text-text-dim">Directed</span><span>{message().toMe ? 'to this station' : 'group / undirected'}</span>
              </div>
              <pre class="mt-2 p-2 bg-black/30 border border-border/30 rounded-sm text-[9px] font-mono text-text-primary whitespace-pre-wrap break-words">{message().text}</pre>
            </div>
          )}
        </Show>

        <p class="text-[8px] font-mono text-text-dim leading-relaxed border-t border-border/20 pt-3">
          JS8 speeds: NORMAL 15 s, FAST 10 s, TURBO 6 s, SLOW 30 s. This receiver decodes the
          configured speed; default is NORMAL.
        </p>
      </div>
    </div>
  );
};

export default Js8Display;
