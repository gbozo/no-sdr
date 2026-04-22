// ============================================================
// node-sdr — Waterfall + Spectrum Component
// ============================================================

import { Component, onMount, onCleanup, Show, createSignal } from 'solid-js';
import { engine } from '../engine/sdr-engine.js';
import { store } from '../store/index.js';

const WaterfallDisplay: Component = () => {
  let waterfallRef!: HTMLCanvasElement;
  let spectrumRef!: HTMLCanvasElement;
  let containerRef!: HTMLDivElement;

  // Frequency tooltip state
  const [hoverFreq, setHoverFreq] = createSignal<string | null>(null);
  const [cursorX, setCursorX]     = createSignal(0);
  const [cursorY, setCursorY]     = createSignal(0);

  onMount(() => {
    // Attach canvases to the engine
    engine.attachCanvases(waterfallRef, spectrumRef);

    // Handle resize — also fires immediately for initial sizing
    const observer = new ResizeObserver(() => {
      engine.handleResize();
    });
    observer.observe(containerRef);

    // Ensure initial resize happens after layout settles
    requestAnimationFrame(() => {
      engine.handleResize();
    });

    onCleanup(() => observer.disconnect());
  });

  const freqFromMouseX = (e: MouseEvent): string => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const hz = store.centerFrequency() + (relX - 0.5) * store.sampleRate();
    const mhz = hz / 1e6;
    if (mhz >= 1000) return `${(mhz / 1000).toFixed(4)} GHz`;
    if (mhz >= 1)    return `${mhz.toFixed(4)} MHz`;
    return `${(hz / 1000).toFixed(2)} kHz`;
  };

  const handleMouseMove = (e: MouseEvent) => {
    setCursorX(e.clientX);
    setCursorY(e.clientY);
    setHoverFreq(freqFromMouseX(e));
  };

  const handleMouseLeave = () => setHoverFreq(null);

  // Click-to-tune on waterfall and spectrum
  const handleClick = (e: MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const relativeX = (e.clientX - rect.left) / rect.width;
    const offset = (relativeX - 0.5) * store.sampleRate();
    engine.tune(Math.round(offset));
  };

  return (
    <div ref={containerRef!} class="flex flex-col flex-1 min-h-0 relative">

      {/* Frequency tooltip — follows cursor, rendered in fixed viewport coords */}
      <Show when={hoverFreq() !== null}>
        <div
          class="fixed z-50 pointer-events-none
                 px-2 py-0.5 rounded
                 bg-black/80 border border-white/10
                 text-[10px] font-mono text-white/90
                 whitespace-nowrap"
          style={{
            left: `${cursorX() + 14}px`,
            top:  `${cursorY() - 10}px`,
          }}
        >
          {hoverFreq()}
        </div>
      </Show>

      {/* Spectrum (top) */}
      <div class="relative h-[180px] min-h-[120px] border-b border-border">
        <canvas
          ref={spectrumRef!}
          class="absolute inset-0 w-full h-full cursor-crosshair"
          onClick={handleClick}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        />
        {/* Frequency scale overlay */}
        <FrequencyScale />
      </div>

      {/* Waterfall (bottom, fills remaining space) */}
      <div class="relative flex-1 min-h-0">
        <canvas
          ref={waterfallRef!}
          class="absolute inset-0 w-full h-full cursor-crosshair"
          style={{ "image-rendering": "crisp-edges" }}
          onClick={handleClick}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        />
        <div class="sdr-scanlines" />
        {/* RDS overlay (bottom-left of waterfall, WFM only) */}
        <RdsOverlay />
      </div>
    </div>
  );
};

// Frequency scale at the top of the spectrum
const FrequencyScale: Component = () => {
  const formatFreq = (hz: number): string => {
    const mhz = hz / 1e6;
    if (mhz >= 1000) return `${(mhz / 1000).toFixed(3)} G`;
    if (mhz >= 1) return `${mhz.toFixed(3)}`;
    return `${(hz / 1000).toFixed(1)} k`;
  };

  return (
    <div class="absolute bottom-0 left-0 right-0 h-5 flex items-center
                bg-sdr-base/80 border-t border-border/50 pointer-events-none">
      <div class="flex justify-between w-full px-1 text-[8px] font-mono text-text-dim">
        <span>{formatFreq(store.centerFrequency() - store.sampleRate() / 2)}</span>
        <span>{formatFreq(store.centerFrequency() - store.sampleRate() / 4)}</span>
        <span class="text-text-secondary">{formatFreq(store.centerFrequency())}</span>
        <span>{formatFreq(store.centerFrequency() + store.sampleRate() / 4)}</span>
        <span>{formatFreq(store.centerFrequency() + store.sampleRate() / 2)}</span>
      </div>
    </div>
  );
};

// RDS data overlay — shown in WFM mode when RDS data is available
const RdsOverlay: Component = () => {
  const isWfm = () => store.mode() === 'wfm';
  const hasData = () => store.rdsPs() || store.rdsRt();
  const synced = () => store.rdsSynced();

  return (
    <Show when={isWfm()}>
      <div class="absolute bottom-2 left-2 pointer-events-none z-10
                  bg-black/40 border border-white/10 rounded px-2 py-1.5
                  max-w-[340px] flex items-start gap-2">
        {/* RDS logo — greyed out when not synced, bright when active */}
        <div class={`text-[11px] font-bold font-mono leading-none mt-px select-none shrink-0
                     ${synced() ? 'text-white opacity-90' : 'text-text-muted opacity-40'}`}
             style={{ "letter-spacing": "0.5px" }}>
          RDS
        </div>
        {/* Data area */}
        <Show when={hasData() || synced()}>
          <div class="min-w-0">
            <Show when={store.rdsPs()}>
              <div class="text-[13px] font-mono font-bold text-white tracking-wider leading-tight">
                {store.rdsPs()}
              </div>
            </Show>
            <Show when={store.rdsRt()}>
              <div class="text-[9px] font-mono text-white/80 leading-tight mt-0.5 truncate">
                {store.rdsRt()}
              </div>
            </Show>
            <Show when={store.rdsPty() || store.rdsPi() || synced()}>
              <div class="text-[7px] font-mono text-white/60 mt-0.5 flex gap-2">
                <Show when={store.rdsPty()}>
                  <span>{store.rdsPty()}</span>
                </Show>
                <Show when={store.rdsPi()}>
                  <span class="opacity-70">PI:{store.rdsPi()}</span>
                </Show>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
};

export default WaterfallDisplay;
