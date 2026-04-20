// ============================================================
// node-sdr — Frequency Display Component
// ============================================================

import { Component, createMemo, For } from 'solid-js';
import { store } from '../store/index.js';
import { formatFrequencyDotted } from '@node-sdr/shared';

const FrequencyDisplay: Component = () => {
  const freqStr = createMemo(() => {
    const hz = store.tunedFrequency();
    return formatFrequencyDotted(hz);
  });

  // Split into digit groups for hover interaction
  const digitGroups = createMemo(() => {
    const str = freqStr();
    return str.split('.');
  });

  // Handle scroll-to-tune on digit groups
  const handleWheel = (groupIndex: number, e: WheelEvent) => {
    e.preventDefault();
    const groups = digitGroups();
    const totalGroups = groups.length;
    // Each group represents 3 digits = 10^(3*(totalGroups-1-groupIndex))
    const step = Math.pow(10, 3 * (totalGroups - 1 - groupIndex));
    const delta = e.deltaY > 0 ? -step : step;
    engine_tune_relative(delta);
  };

  return (
    <div class="sdr-panel relative overflow-hidden">
      <div class="sdr-scanlines" />
      <div class="sdr-dot-grid" />
      <div class="p-3">
        <div class="text-[8px] font-mono uppercase tracking-[0.15em] text-text-dim mb-1">
          VFO Frequency
        </div>
        <div class="font-display text-4xl tracking-wider leading-none"
             style={{ color: 'var(--sdr-freq-color)' }}>
          <For each={digitGroups()}>
            {(group, i) => (
              <>
                <span
                  class="cursor-ns-resize hover:text-white transition-colors duration-100
                         inline-block"
                  style={{ "text-shadow": '0 0 8px var(--sdr-accent-dim)' }}
                  onWheel={(e) => handleWheel(i(), e)}
                >
                  {group}
                </span>
                {i() < digitGroups().length - 1 && (
                  <span class="text-text-dim mx-0.5">.</span>
                )}
              </>
            )}
          </For>
          <span class="text-sm text-text-secondary ml-2 font-mono">Hz</span>
        </div>
        <div class="mt-1 text-[9px] font-mono text-text-dim">
          Center: {formatFrequencyDotted(store.centerFrequency())} Hz
          <span class="mx-2 text-border">|</span>
          Offset: {store.tuneOffset() >= 0 ? '+' : ''}{(store.tuneOffset() / 1000).toFixed(1)} kHz
        </div>
      </div>
    </div>
  );
};

// Helper to tune relative from current offset
function engine_tune_relative(deltaHz: number): void {
  const { engine } = await_engine();
  const newOffset = store.tuneOffset() + deltaHz;
  const halfBw = store.sampleRate() / 2;
  // Clamp to within sample rate
  const clamped = Math.max(-halfBw, Math.min(halfBw, newOffset));
  engine.tune(Math.round(clamped));
}

function await_engine() {
  // Lazy import to avoid circular dependency
  return { engine: (globalThis as any).__sdrEngine };
}

export default FrequencyDisplay;
