// ============================================================
// node-sdr — Main App Layout
// ============================================================

import { Component, onMount, onCleanup, Show, createSignal, For, createMemo, createEffect } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { store } from './store/index.js';
import { engine } from './engine/sdr-engine.js';
import WaterfallDisplay from './components/WaterfallDisplay.js';
import FrequencyDisplay from './components/FrequencyDisplay.js';
import ControlPanel from './components/ControlPanel.js';
import ConnectionOverlay from './components/ConnectionOverlay.js';

const App: Component = () => {
  const navigate = useNavigate();
  const [installPrompt, setInstallPrompt] = createSignal<any>(null);
  const [installed, setInstalled] = createSignal(false);
  const [reconnectedFlash, setReconnectedFlash] = createSignal(false);

  // Flash "Reconnected" briefly when coming back online after a disconnect
  let wasDisconnected = false;
  createEffect(() => {
    const state = store.connectionState();
    if (state === 'disconnected' || state === 'connecting') {
      if (store.reconnectAttempt() > 0) wasDisconnected = true;
    }
    if (state === 'connected' && wasDisconnected) {
      wasDisconnected = false;
      setReconnectedFlash(true);
      setTimeout(() => setReconnectedFlash(false), 3000);
    }
  });

  // Expose engine globally for frequency display component
  (globalThis as any).__sdrEngine = engine;

  onMount(() => {
    // Connect to WebSocket
    engine.connect();

    // Apply UI theme
    document.documentElement.setAttribute('data-theme', store.uiTheme());

    // Capture PWA install prompt — do not call preventDefault() so Chrome
    // doesn't log the "Banner not shown" DevTools message. Modern Chrome (105+)
    // no longer auto-shows the mini-infobar so deferring is not required.
    const onBeforeInstall = (e: Event) => {
      setInstallPrompt(e);
    };
    const onAppInstalled = () => {
      setInstallPrompt(null);
      setInstalled(true);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onAppInstalled);
    // Already installed if running in standalone mode
    if (window.matchMedia('(display-mode: standalone)').matches) {
      setInstalled(true);
    }

    onCleanup(() => {
      engine.destroy();
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onAppInstalled);
    });
  });

  // Start audio on first user interaction
  const handleStartAudio = async () => {
    if (!store.audioStarted()) {
      try {
        await engine.initAudio();
        store.setAudioStarted(true);
      } catch (err) {
        alert((err as Error).message);
      }
    }
  };

  const handleInstall = async () => {
    const prompt = installPrompt();
    if (!prompt) return;
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === 'accepted') setInstalled(true);
    setInstallPrompt(null);
  };

  return (
    <div class="h-screen flex flex-col bg-sdr-base text-text-primary select-none">
      {/* Top Bar */}
      <header class="h-11 bg-sdr-surface border-b border-border flex items-center px-4 relative shrink-0">
        {/* Top accent gradient line */}
        <div class="absolute top-0 inset-x-0 h-[2px]
                    bg-gradient-to-r from-cyan via-amber to-cyan opacity-70" />

        <div class="flex items-center gap-3 flex-1">
          <h1 class="font-mono text-xs font-bold tracking-[0.15em] text-text-primary uppercase">
            <span class="text-cyan">NO</span><span class="text-text-dim">(DE)</span><span class="text-cyan">-SDR</span>
          </h1>

          {/* PWA Install Icon */}
          <div class="relative group">
            <button
              disabled={installed() || !installPrompt()}
              onClick={handleInstall}
              class={`w-4 h-4 rounded-full flex items-center justify-center transition-colors
                ${installed() || !installPrompt()
                  ? 'text-text-dim cursor-default'
                  : 'text-status-online hover:brightness-125 cursor-pointer'}`}
              aria-label="Install app"
            >
              {/* Circle with down-arrow — standard install icon */}
              <svg viewBox="0 0 16 16" fill="none" class="w-3.5 h-3.5">
                <circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/>
                <path d="M8 4.5v4M5.5 7l2.5 2.5L10.5 7" stroke="currentColor" stroke-width="1.5"
                      stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
            {/* Tooltip — only when installable */}
            <Show when={!installed() && !!installPrompt()}>
              <div class="absolute left-1/2 -translate-x-1/2 top-6 z-50
                          px-2 py-1 rounded text-[9px] font-mono whitespace-nowrap
                          bg-sdr-elevated border border-border text-text-secondary
                          opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity">
                Install app
              </div>
            </Show>
          </div>

          {/* Connection indicator */}
          <div class="flex items-center gap-1.5">
            <div class={`w-1.5 h-1.5 rounded-full ${
              store.connectionState() === 'connected' ? 'bg-status-online animate-pulse-glow' :
              store.connectionState() === 'connecting' ? 'bg-amber animate-pulse' :
              store.connectionState() === 'unconfigured' ? 'bg-amber' :
              'bg-status-error'
            }`} />
            <span class="text-[9px] font-mono text-text-dim">
              {reconnectedFlash() ? 'Reconnected' :
               store.connectionState() === 'connected' ? 'Online' :
               store.connectionState() === 'connecting' ? 'Connecting...' :
               store.connectionState() === 'unconfigured' ? 'No Receivers' :
               'Offline'}
            </span>
          </div>
        </div>

        {/* Theme Selector */}
        <div class="flex items-center gap-1">
          <ThemeButton theme="default" label="LCD" />
          <ThemeButton theme="crt" label="CRT" />
          <ThemeButton theme="vfd" label="VFD" />
        </div>

        {/* Enable Audio button — shown until first interaction */}
        <Show when={!store.audioStarted()}>
          <button
            class="ml-4 px-3 py-1 text-[9px] font-mono uppercase tracking-wider
                   rounded-sm border border-[var(--sdr-accent)] text-[var(--sdr-accent)]
                   hover:bg-[var(--sdr-accent)] hover:text-text-inverse
                   transition-colors animate-pulse-glow"
            onClick={handleStartAudio}
          >
            Enable Audio
          </button>
        </Show>

        {/* Admin Button */}
        <button
          class="ml-4 p-1.5 border border-border rounded-sm
                 text-text-dim hover:text-amber hover:border-amber
                 transition-colors"
          onClick={() => navigate('/admin')}
          title="Admin Settings"
        >
          <svg class="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 10a2 2 0 100-4 2 2 0 000 4z"/>
            <path d="M13.3 10a1.1 1.1 0 00.2 1.2l.04.04a1.34 1.34 0 11-1.9 1.9l-.04-.04a1.1 1.1 0 00-1.2-.2 1.1 1.1 0 00-.67 1.01v.11a1.34 1.34 0 11-2.68 0v-.06a1.1 1.1 0 00-.72-1.01 1.1 1.1 0 00-1.2.2l-.04.04a1.34 1.34 0 11-1.9-1.9l.04-.04a1.1 1.1 0 00.2-1.2 1.1 1.1 0 00-1.01-.67h-.11a1.34 1.34 0 110-2.68h.06a1.1 1.1 0 001.01-.72 1.1 1.1 0 00-.2-1.2l-.04-.04a1.34 1.34 0 111.9-1.9l.04.04a1.1 1.1 0 001.2.2h.05a1.1 1.1 0 00.67-1.01v-.11a1.34 1.34 0 112.68 0v.06a1.1 1.1 0 00.72 1.01 1.1 1.1 0 001.2-.2l.04-.04a1.34 1.34 0 111.9 1.9l-.04.04a1.1 1.1 0 00-.2 1.2v.05a1.1 1.1 0 001.01.67h.11a1.34 1.34 0 110 2.68h-.06a1.1 1.1 0 00-1.01.72z"/>
          </svg>
        </button>
      </header>

      {/* Main Content */}
      <div class="flex-1 flex min-h-0 relative">
        {/* Connection state overlay */}
        <ConnectionOverlay />

        {/* Sidebar */}
        <Show when={store.sidebarOpen()}>
          <aside class="w-[300px] bg-sdr-surface border-r border-border overflow-y-auto shrink-0">
            <ControlPanel />
          </aside>
        </Show>

        {/* Main Area */}
        <div class="flex-1 flex flex-col min-w-0">
          {/* Frequency Display */}
          <div class="shrink-0 p-2 pb-0">
            <FrequencyDisplay />
          </div>

          {/* Waterfall + Spectrum */}
          <div class="flex-1 min-h-0 p-2 flex flex-col">
            <div class="flex-1 min-h-0 rounded-md overflow-hidden border border-border bg-black flex flex-col">
              <WaterfallDisplay />
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Status Bar */}
      <footer class="h-7 bg-sdr-surface border-t border-border flex items-center px-4 shrink-0">
        <div class="flex items-center gap-4 text-[8px] font-mono text-text-dim uppercase tracking-wider w-full">
          <span>
            Mode: <span class="text-text-secondary">{store.mode().toUpperCase()}</span>
          </span>
          <span>
            BW: <span class="text-text-secondary">{(store.bandwidth() / 1000).toFixed(1)}k</span>
          </span>
          <span>
            Vol: <span class="text-text-secondary">{Math.round(store.volume() * 100)}%</span>
          </span>
          <Show when={store.squelch() !== null}>
            <span>
              SQL: <span class="text-text-secondary">{store.squelch()} dB</span>
            </span>
          </Show>
          <div class="flex-1" />

          {/* Client ID (persistent UUID, first 8 chars) + connection index */}
          <Show when={store.localClientId()}>
            <span class="border-r border-border pr-4">
              ID: <span class="text-text-secondary">{store.localClientId().slice(0, 8)}</span>
              <Show when={store.connIndex() > 0}>
                <span class="text-text-dim">:{store.connIndex()}</span>
              </Show>
            </span>
          </Show>

          {/* Bandwidth Meter with sparkline */}
          <BandwidthMeter />

          {/* Server CPU / memory */}
          <ServerStatsMeter />

          <Show when={store.isAdmin()}>
            <span class="text-amber">ADMIN</span>
          </Show>
        </div>
      </footer>
    </div>
  );
};

// Bandwidth meter with sparkline histogram
const BandwidthMeter: Component = () => {
  const formatRate = (bytes: number): string => {
    if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB/s`;
    if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB/s`;
    return `${bytes} B/s`;
  };

  const history = () => store.wsBytesHistory();
  const histMax = createMemo(() => {
    const h = history();
    if (h.length === 0) return 1;
    return Math.max(...h, 1);
  });

  const barCount = 30;
  const barWidth = 2;
  const barGap = 1;
  const sparkWidth = barCount * (barWidth + barGap) - barGap;
  const sparkHeight = 14;

  return (
    <div class="flex items-center gap-2 border-l border-border pl-4">
      {/* Mini sparkline histogram */}
      <svg
        width={sparkWidth}
        height={sparkHeight}
        class="opacity-70"
        aria-label="Bandwidth history"
      >
        <For each={history().slice(-barCount)}>
          {(value, i) => {
            const h = () => Math.max(1, (value / histMax()) * sparkHeight);
            const x = () => i() * (barWidth + barGap);
            const isLast = () => i() === history().slice(-barCount).length - 1;
            return (
              <rect
                x={x()}
                y={sparkHeight - h()}
                width={barWidth}
                height={h()}
                rx={0.5}
                fill={isLast() ? 'var(--sdr-accent, #4aa3ff)' : 'var(--color-text-dim, #6f7f94)'}
                opacity={isLast() ? 1 : 0.6}
              />
            );
          }}
        </For>
      </svg>

      {/* Rate text */}
      <div class="flex flex-col leading-[1.1]">
        <span class="text-text-secondary normal-case">
          {formatRate(store.wsBytes())}
        </span>
        <span class="text-text-muted text-[7px] normal-case">
          FFT {store.fftRate()}/s
        </span>
      </div>
    </div>
  );
};

// Server process CPU + memory display
const ServerStatsMeter: Component = () => {
  const cpu = () => store.serverCpu();
  const mem = () => store.serverMem();

  // Colour the CPU reading by load level
  const cpuColor = () => {
    const c = cpu();
    if (c >= 80) return 'text-red-400';
    if (c >= 50) return 'text-amber-400';
    return 'text-text-secondary';
  };

  return (
    <Show when={store.connected()}>
      <div class="flex items-center gap-2 border-l border-border pl-4">
        {/* CPU bar */}
        <div class="flex flex-col gap-[2px]">
          <div class="w-12 h-[3px] rounded-full bg-border overflow-hidden">
            <div
              class="h-full rounded-full transition-all duration-500"
              style={{
                width: `${cpu()}%`,
                background: cpu() >= 80 ? 'var(--color-red-400, #f87171)'
                          : cpu() >= 50 ? 'var(--color-amber-400, #fbbf24)'
                          : 'var(--sdr-accent)',
              }}
            />
          </div>
          <div class="w-12 h-[3px] rounded-full bg-border overflow-hidden">
            <div
              class="h-full rounded-full transition-all duration-500 opacity-60"
              style={{
                width: `${Math.min(100, (mem() / 512) * 100)}%`,
                background: 'var(--sdr-accent)',
              }}
            />
          </div>
        </div>

        {/* Text */}
        <div class="flex flex-col leading-[1.1]">
          <span class={`${cpuColor()} normal-case font-mono`}>
            {cpu()}% CPU
          </span>
          <span class="text-text-muted text-[7px] normal-case">
            {mem()} MB RSS
          </span>
        </div>
      </div>
    </Show>
  );
};

// Theme toggle button
const ThemeButton: Component<{ theme: string; label: string }> = (props) => {
  const isActive = () => store.uiTheme() === props.theme;

  return (
    <button
      class={`px-2 py-0.5 text-[8px] font-mono uppercase tracking-wider rounded-sm transition-all
              ${isActive()
                ? 'text-text-inverse'
                : 'text-text-dim hover:text-text-secondary'}`}
      style={{
        background: isActive() ? 'var(--sdr-accent)' : 'transparent',
        "box-shadow": isActive() ? 'var(--sdr-glow)' : 'none',
      }}
      onClick={() => {
        store.setUITheme(props.theme as any);
        document.documentElement.setAttribute('data-theme', props.theme);
        // CSS variable is now updated — sync spectrum renderer immediately
        engine.setSpectrumAccentColor();
      }}
    >
      {props.label}
    </button>
  );
};

export default App;
