// ============================================================
// node-sdr — Main App Layout
// ============================================================

import { Component, onMount, onCleanup, Show, createSignal } from 'solid-js';
import { store } from './store/index.js';
import { engine } from './engine/sdr-engine.js';
import WaterfallDisplay from './components/WaterfallDisplay.js';
import FrequencyDisplay from './components/FrequencyDisplay.js';
import ControlPanel from './components/ControlPanel.js';

const App: Component = () => {
  const [audioStarted, setAudioStarted] = createSignal(false);

  // Expose engine globally for frequency display component
  (globalThis as any).__sdrEngine = engine;

  onMount(() => {
    // Connect to WebSocket
    engine.connect();

    // Apply UI theme
    document.documentElement.setAttribute('data-theme', store.uiTheme());

    onCleanup(() => {
      engine.destroy();
    });
  });

  // Start audio on first user interaction
  const handleStartAudio = async () => {
    if (!audioStarted()) {
      await engine.initAudio();
      setAudioStarted(true);
    }
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
            node-sdr
          </h1>

          {/* Connection indicator */}
          <div class="flex items-center gap-1.5">
            <div class={`w-1.5 h-1.5 rounded-full ${store.connected() ? 'bg-status-online animate-pulse-glow' : 'bg-status-error'}`} />
            <span class="text-[9px] font-mono text-text-dim">
              {store.connected() ? 'Online' : 'Offline'}
            </span>
          </div>
        </div>

        {/* Theme Selector */}
        <div class="flex items-center gap-1">
          <ThemeButton theme="default" label="LCD" />
          <ThemeButton theme="crt" label="CRT" />
          <ThemeButton theme="vfd" label="VFD" />
        </div>
      </header>

      {/* Audio Start Prompt (one-time) */}
      <Show when={!audioStarted()}>
        <div
          class="bg-sdr-elevated border-b border-border px-4 py-2 flex items-center justify-between cursor-pointer hover:bg-sdr-hover transition-colors"
          onClick={handleStartAudio}
        >
          <span class="text-[10px] font-mono text-text-secondary">
            Click anywhere to enable audio playback
          </span>
          <span class="sdr-btn sdr-btn-primary text-[9px]">Enable Audio</span>
        </div>
      </Show>

      {/* Main Content */}
      <div class="flex-1 flex min-h-0">
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
          <div class="flex-1 min-h-0 p-2">
            <div class="h-full rounded-md overflow-hidden border border-border bg-black">
              <WaterfallDisplay />
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Status Bar */}
      <footer class="h-7 bg-sdr-surface border-t border-border flex items-center px-4 shrink-0">
        <div class="flex items-center gap-4 text-[8px] font-mono text-text-dim uppercase tracking-wider">
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
          <span>
            Dongle: <span class="text-text-secondary">{store.activeDongleId() || '—'}</span>
          </span>
          <Show when={store.isAdmin()}>
            <span class="text-amber">ADMIN</span>
          </Show>
        </div>
      </footer>
    </div>
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
      }}
    >
      {props.label}
    </button>
  );
};

export default App;
