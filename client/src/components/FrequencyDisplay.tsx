// ============================================================
// node-sdr — Frequency Display Component
// ============================================================

import { Component, createMemo, For, Show, onMount, onCleanup } from 'solid-js';
import { store } from '../store/index.js';
import { formatFrequencyDotted } from '~/shared';

/** Common tuning step options in Hz */
const TUNING_STEPS = [
  { value: 0, label: 'Auto' },
  { value: 1, label: '1 Hz' },
  { value: 10, label: '10 Hz' },
  { value: 100, label: '100 Hz' },
  { value: 500, label: '500 Hz' },
  { value: 1000, label: '1 kHz' },
  { value: 2500, label: '2.5 kHz' },
  { value: 5000, label: '5 kHz' },
  { value: 6250, label: '6.25 kHz' },
  { value: 8330, label: '8.33 kHz' },
  { value: 9000, label: '9 kHz' },
  { value: 10000, label: '10 kHz' },
  { value: 12500, label: '12.5 kHz' },
  { value: 25000, label: '25 kHz' },
  { value: 50000, label: '50 kHz' },
  { value: 100000, label: '100 kHz' },
  { value: 200000, label: '200 kHz' },
];

/** Get the effective tuning step in Hz. 0 (auto) resolves to bandwidth. */
function getEffectiveStep(): number {
  const step = store.tuningStep();
  if (step > 0) return step;
  // Auto: use bandwidth as step
  return store.bandwidth();
}

/** Format a step value for display */
function formatStep(hz: number): string {
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(hz % 1_000_000 === 0 ? 0 : 2)} MHz`;
  if (hz >= 1000) return `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 2)} kHz`;
  return `${hz} Hz`;
}

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

  // Handle scroll-to-tune on digit groups (no step snapping — uses digit position)
  const handleWheel = (groupIndex: number, e: WheelEvent) => {
    e.preventDefault();
    const groups = digitGroups();
    const totalGroups = groups.length;
    // Each group represents 3 digits = 10^(3*(totalGroups-1-groupIndex))
    const step = Math.pow(10, 3 * (totalGroups - 1 - groupIndex));
    const delta = e.deltaY > 0 ? -step : step;
    engine_tune_raw(delta);
  };

  // Keyboard handler: left/right = step, up/down = 10x step
  const handleKeyDown = (e: KeyboardEvent) => {
    // Don't handle if user is typing in an input/select/textarea
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    // Don't handle if modifier keys are held (browser shortcuts)
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const step = getEffectiveStep();
    let delta = 0;

    switch (e.key) {
      case 'ArrowRight':
        delta = step;
        break;
      case 'ArrowLeft':
        delta = -step;
        break;
      case 'ArrowUp':
        delta = step * 10;
        break;
      case 'ArrowDown':
        delta = -step * 10;
        break;
      default:
        return; // Don't preventDefault for unhandled keys
    }

    e.preventDefault();
    engine_tune_stepped(delta);
  };

  onMount(() => {
    document.addEventListener('keydown', handleKeyDown);
  });

  onCleanup(() => {
    document.removeEventListener('keydown', handleKeyDown);
  });

  return (
    <div class="sdr-panel relative overflow-hidden">
      <div class="sdr-scanlines" />
      <div class="sdr-dot-grid" />

      {/* RDS info — absolute top-right, shows PS, RT, or PTY, whatever is available */}
      {(() => {
        const clean = (s: string) => s.replace(/[\x00-\x1f]/g, '').trim();
        const label = () => clean(store.rdsPs()) || clean(store.rdsRt()) || clean(store.rdsPty());
        return (
          <Show when={label()}>
            <div class="absolute top-2 right-3 z-10 pointer-events-none select-none max-w-[55%]">
              <span
                class="font-mono text-[10px] tracking-[0.15em] uppercase truncate block"
                style={{
                  color: 'var(--sdr-accent)',
                  opacity: '0.85',
                  'text-shadow': '0 0 6px var(--sdr-accent)',
                }}
              >
                {label()}
              </span>
            </div>
          </Show>
        );
      })()}

      <div class="p-3">
        <div class="text-[8px] font-mono uppercase tracking-[0.15em] text-text-dim mb-1">
          <span>VFO Frequency</span>
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
          <span class="relative inline-block text-sm text-text-secondary ml-2 font-mono">
            Hz
            <Show when={store.stereoDetected() && (store.mode() === 'wfm' || store.mode() === 'am' || store.mode() === 'am-stereo')}>
              <span
                class="absolute bottom-full left-0 mb-0.5 text-[6px] font-mono font-bold tracking-wider
                       px-1 py-px rounded whitespace-nowrap
                       text-green border border-green/40 bg-green-dim shadow-[0_0_4px_rgba(56,193,128,0.3)]"
              >
                STEREO
              </span>
            </Show>
          </span>
        </div>
        {/* Info row: center, offset, step */}
        <div class="mt-1 flex items-center gap-0 text-[9px] font-mono text-text-dim">
          <span>Center: {formatFrequencyDotted(store.centerFrequency())} Hz</span>
          <span class="mx-2 text-border">|</span>
          <span>Offset: {store.tuneOffset() >= 0 ? '+' : ''}{(store.tuneOffset() / 1000).toFixed(1)} kHz</span>
          <span class="mx-2 text-border">|</span>
          <span class="flex items-center gap-1">
            Step:
            <select
              class="bg-transparent border-none text-text-secondary focus:text-cyan focus:outline-none
                     cursor-pointer text-[9px] font-mono px-0.5 py-0 -my-0.5"
              value={store.tuningStep()}
              onChange={(e) => {
                store.setTuningStep(parseInt(e.currentTarget.value) || 0);
                e.currentTarget.blur();
              }}
            >
              <For each={TUNING_STEPS}>
                {(opt) => (
                  <option value={opt.value}>
                    {opt.value === 0 ? `Auto (${formatStep(store.bandwidth())})` : opt.label}
                  </option>
                )}
              </For>
            </select>
          </span>
          <span class="ml-auto text-[8px] text-text-muted" title="Left/Right: step, Up/Down: 10x step">
            ←→ tune
          </span>
        </div>
      </div>
    </div>
  );
};

// Helper to tune relative from current offset, snapping to the tuning step (keyboard only)
function engine_tune_stepped(deltaHz: number): void {
  const { engine } = await_engine();
  const step = getEffectiveStep();
  const currentOffset = store.tuneOffset();
  let newOffset = currentOffset + deltaHz;

  // Snap to step grid (relative to center frequency)
  if (step > 1) {
    newOffset = Math.round(newOffset / step) * step;
  }

  const halfBw = store.sampleRate() / 2;
  const clamped = Math.max(-halfBw, Math.min(halfBw, newOffset));
  engine.tune(Math.round(clamped));
}

// Helper to tune relative without step snapping (scroll wheel on digits)
function engine_tune_raw(deltaHz: number): void {
  const { engine } = await_engine();
  const currentOffset = store.tuneOffset();
  const newOffset = currentOffset + deltaHz;
  const halfBw = store.sampleRate() / 2;
  const clamped = Math.max(-halfBw, Math.min(halfBw, newOffset));
  engine.tune(Math.round(clamped));
}

function await_engine() {
  // Lazy import to avoid circular dependency
  return { engine: (globalThis as any).__sdrEngine };
}

export default FrequencyDisplay;
