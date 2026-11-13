// ============================================================
// node-sdr — NAVTEX workspace
// ============================================================
// Message table on the left, full SITOR-B text on the right. The server
// sends one event per completed ZCZC/NNNN message plus a 1 Hz status.

import { Component, For, Show, createMemo, createSignal } from 'solid-js';
import { store } from '../store/index.js';
import type { NavtexMessage } from '~/shared';

function formatTime(at: number): string {
  return new Date(at * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function key(message: NavtexMessage): string {
  return `${message.station}|${message.subject}|${message.serial}`;
}

function subjectLabel(subject: string): string {
  const labels: Record<string, string> = {
    A: 'Navigational warning',
    B: 'Meteorological warning',
    C: 'Ice report',
    D: 'Search and rescue',
    E: 'Weather forecast',
    F: 'Pilot service',
    G: 'AIS service',
    H: 'LORAN',
    I: 'Omega',
    J: 'SATNAV',
    K: 'Other electronic navaid',
    L: 'Navigational warning (additional)',
    M: 'Meteorological warning (additional)',
    N: 'Ice report (additional)',
    O: 'Search and rescue (additional)',
    P: 'Weather forecast (additional)',
    Q: 'Pilot service (additional)',
    R: 'AIS service (additional)',
    S: 'SATNAV (additional)',
    T: 'Other (additional)',
    U: 'Special services',
    V: 'Special services',
    W: 'Special services',
    X: 'Special services',
    Y: 'Special services',
    Z: 'No message on hand',
  };
  return labels[subject] ?? `Subject ${subject}`;
}

const NavtexDisplay: Component = () => {
  const [selectedKey, setSelectedKey] = createSignal<string | null>(null);

  const messages = () => store.navtexMessages();
  const status = () => store.navtexStatus();
  const selected = createMemo(() => {
    const wanted = selectedKey();
    if (!wanted) return null;
    return messages().find((m) => key(m) === wanted) ?? null;
  });

  return (
    <div class="flex-1 min-h-0 flex flex-col md:flex-row">
      {/* Message table */}
      <div class="flex flex-col min-w-0 min-h-0 md:w-[44%] border-b md:border-b-0 md:border-r border-border/40">
        <div class="shrink-0 px-2 py-1 border-b border-border/30 text-[8px] font-mono leading-relaxed">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-text-dim">
            <span class="uppercase tracking-wider text-text-secondary">NAVTEX</span>
            <span>{messages().length} MESSAGES</span>
            <span class={status().inSync ? 'text-green-400' : 'text-amber'}>
              {status().inSync ? 'SYNC' : 'SEARCH'}
            </span>
            <span>LVL {status().level.toFixed(2)}</span>
            <span>DIR {status().direct}</span>
            <span>REP {status().repaired}</span>
            <span>LOST {status().lost}</span>
            <span>518 kHz · SITOR-B</span>
          </div>
        </div>

        <div class="flex-1 min-h-0 overflow-auto">
          <table class="w-full text-[8px] font-mono">
            <thead class="sticky top-0 z-10 bg-sdr-surface">
              <tr>
                <th class="text-left px-1.5 py-1 text-text-dim">TIME</th>
                <th class="text-left px-1.5 py-1 text-text-dim">STN</th>
                <th class="text-left px-1.5 py-1 text-text-dim">SUBJ</th>
                <th class="text-left px-1.5 py-1 text-text-dim">SER</th>
                <th class="text-left px-1.5 py-1 text-text-dim">MESSAGE</th>
              </tr>
            </thead>
            <tbody>
              <For each={messages()}>
                {(message) => {
                  const active = () => selectedKey() === key(message);
                  return (
                    <tr
                      onClick={() => setSelectedKey(active() ? null : key(message))}
                      class={`border-t border-border/20 cursor-pointer ${
                        active() ? 'bg-cyan/10 text-cyan' : ''
                      } hover:bg-cyan/5`}
                    >
                      <td class="px-1.5 py-1 whitespace-nowrap text-text-dim">{formatTime(message.at)}</td>
                      <td class="px-1.5 py-1 whitespace-nowrap text-text-primary">{message.station}</td>
                      <td class="px-1.5 py-1 whitespace-nowrap text-text-secondary">{message.subject}</td>
                      <td class="px-1.5 py-1 whitespace-nowrap text-text-dim">{message.serial}</td>
                      <td class="px-1.5 py-1 break-all">
                        {message.text.split('\n')[0]}
                        {!message.complete && <span class="text-amber"> …</span>}
                      </td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>

          <Show when={messages().length === 0}>
            <div class="px-2 py-3 text-[8px] font-mono text-text-dim">
              Waiting for a NAVTEX message. Tune 518 kHz (English international),
              490 kHz (national language) or 4209.5 kHz (tropical) in USB with a
              3 kHz profile. The receiver needs a few seconds of phasing before
              the first ZCZC header.
            </div>
          </Show>
        </div>
      </div>

      {/* Full message */}
      <div class="md:flex-1 min-h-0 overflow-auto bg-black/40">
        <Show
          when={selected()}
          fallback={
            <div class="h-full flex items-center justify-center px-4 text-center text-[9px] font-mono text-text-dim">
              Select a message to read the full safety broadcast.
            </div>
          }
        >
          {(message) => (
            <div class="p-3 space-y-2">
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/30 pb-2">
                <span class="text-[10px] font-mono uppercase tracking-wider text-cyan">
                  {message().station}
                  {message().subject}
                  {String(message().serial).padStart(2, '0')}
                </span>
                <span class="text-[8px] font-mono text-text-secondary">
                  {subjectLabel(message().subject)}
                </span>
                <span class="text-[8px] font-mono text-text-dim">
                  {formatTime(message().at)}
                </span>
                <span class="ml-auto text-[8px] font-mono text-text-dim">
                  {message().complete ? 'COMPLETE' : 'PARTIAL'}
                  {message().lost > 0 ? ` · ${message().lost} LOST` : ''}
                </span>
              </div>
              <pre class="whitespace-pre-wrap break-words text-[10px] leading-relaxed font-mono text-text-primary">
                {message().text.trim()}
              </pre>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
};

export default NavtexDisplay;
