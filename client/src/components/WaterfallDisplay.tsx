// ============================================================
// node-sdr — Waterfall + Spectrum Component
// ============================================================

import { Component, onMount, onCleanup } from 'solid-js';
import { engine } from '../engine/sdr-engine.js';
import { store } from '../store/index.js';

const WaterfallDisplay: Component = () => {
  let waterfallRef!: HTMLCanvasElement;
  let spectrumRef!: HTMLCanvasElement;
  let containerRef!: HTMLDivElement;

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

  // Click-to-tune on waterfall and spectrum
  const handleClick = (e: MouseEvent) => {
    const rect = waterfallRef.getBoundingClientRect();
    const relativeX = (e.clientX - rect.left) / rect.width;
    // Map 0..1 to -sampleRate/2 .. +sampleRate/2
    const offset = (relativeX - 0.5) * store.sampleRate();
    engine.tune(Math.round(offset));
  };

  return (
    <div ref={containerRef!} class="flex flex-col flex-1 min-h-0 relative">
      {/* Spectrum (top) */}
      <div class="relative h-[180px] min-h-[120px] border-b border-border">
        <canvas
          ref={spectrumRef!}
          class="absolute inset-0 w-full h-full cursor-crosshair"
          onClick={handleClick}
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
        />
        <div class="sdr-scanlines" />
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

export default WaterfallDisplay;
