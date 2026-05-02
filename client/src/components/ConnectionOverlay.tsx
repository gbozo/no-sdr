// ============================================================
// ConnectionOverlay — Visual feedback for connection states
// Shows over the main SDR view during disconnect/reconnect/unconfigured
// ============================================================

import { Component, Show, Switch, Match } from 'solid-js';
import { store } from '../store/index.js';

const ConnectionOverlay: Component = () => {
  const state = () => store.connectionState();
  const attempt = () => store.reconnectAttempt();

  // Only show overlay when NOT connected (connected state = no overlay)
  const visible = () => state() !== 'connected';

  return (
    <Show when={visible()}>
      <div class="absolute inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-sm">
        <div class="max-w-sm w-full mx-4 p-6 bg-sdr-surface border border-border rounded-md shadow-xl">
          <Switch>
            {/* Connecting / Reconnecting */}
            <Match when={state() === 'connecting'}>
              <div class="flex flex-col items-center gap-4 text-center">
                {/* Animated pulse ring */}
                <div class="relative w-12 h-12">
                  <div class="absolute inset-0 rounded-full border-2 border-[var(--sdr-accent)] animate-ping opacity-30" />
                  <div class="absolute inset-2 rounded-full border-2 border-[var(--sdr-accent)] animate-pulse" />
                  <div class="absolute inset-4 rounded-full bg-[var(--sdr-accent)] opacity-60" />
                </div>
                <div>
                  <h3 class="text-xs font-mono font-bold uppercase tracking-wider text-text-primary mb-1">
                    {attempt() > 0 ? 'Reconnecting' : 'Connecting'}
                  </h3>
                  <Show when={attempt() > 0}>
                    <p class="text-[10px] font-mono text-text-dim">
                      Attempt {attempt()} of 20
                    </p>
                  </Show>
                  <p class="text-[10px] font-mono text-text-dim mt-1">
                    Establishing connection to server...
                  </p>
                </div>
              </div>
            </Match>

            {/* Disconnected (max retries reached or initial) */}
            <Match when={state() === 'disconnected'}>
              <div class="flex flex-col items-center gap-4 text-center">
                {/* Error icon */}
                <div class="w-12 h-12 flex items-center justify-center">
                  <svg class="w-10 h-10 text-status-error" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M15 9l-6 6M9 9l6 6" stroke-linecap="round" />
                  </svg>
                </div>
                <div>
                  <h3 class="text-xs font-mono font-bold uppercase tracking-wider text-status-error mb-1">
                    Disconnected
                  </h3>
                  <p class="text-[10px] font-mono text-text-dim">
                    Unable to reach the server.
                  </p>
                  <Show when={attempt() >= 20}>
                    <p class="text-[10px] font-mono text-text-dim mt-1">
                      Max reconnection attempts reached.
                    </p>
                  </Show>
                </div>
                <button
                  class="mt-2 px-4 py-1.5 text-[10px] font-mono uppercase tracking-wider
                         rounded-sm border border-[var(--sdr-accent)] text-[var(--sdr-accent)]
                         hover:bg-[var(--sdr-accent)] hover:text-text-inverse transition-colors"
                  onClick={() => {
                    // Reset and retry from scratch
                    const engine = (globalThis as any).__sdrEngine;
                    if (engine) {
                      engine.reconnectAttempts = 0;
                      store.setReconnectAttempt(0);
                      engine.connect();
                    }
                  }}
                >
                  Retry Connection
                </button>
              </div>
            </Match>

            {/* Unconfigured — server has no dongles set up */}
            <Match when={state() === 'unconfigured'}>
              <div class="flex flex-col items-center gap-4 text-center">
                {/* Radio icon with question */}
                <div class="w-12 h-12 flex items-center justify-center">
                  <svg class="w-10 h-10 text-amber" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <rect x="3" y="7" width="18" height="13" rx="2" />
                    <circle cx="8" cy="13.5" r="3" />
                    <path d="M13 11h5M13 14h5M13 17h3" />
                    <path d="M6 7L16 3" stroke-linecap="round" />
                  </svg>
                </div>
                <div>
                  <h3 class="text-xs font-mono font-bold uppercase tracking-wider text-amber mb-1">
                    No Receivers Configured
                  </h3>
                  <p class="text-[10px] font-mono text-text-dim leading-relaxed">
                    The server is running but no SDR devices have been set up.
                    <br />
                    Open the admin panel to add and configure receivers.
                  </p>
                </div>
                <button
                  class="mt-2 px-4 py-1.5 text-[10px] font-mono uppercase tracking-wider
                         rounded-sm border border-amber text-amber
                         hover:bg-amber hover:text-text-inverse transition-colors"
                  onClick={() => {
                    window.location.href = '/admin';
                  }}
                >
                  Open Admin Panel
                </button>
              </div>
            </Match>
          </Switch>
        </div>
      </div>
    </Show>
  );
};

export default ConnectionOverlay;
