// ============================================================
// node-sdr — Compact foreground-decoder details rail
// ============================================================
// Like the dedicated image/map decoders, weak-signal modes keep their live
// level and reference notes visible instead of only behind the Info overlay.

import { Component, For, Show } from 'solid-js';
import { DECODER_INFO, DIGITAL_MODES } from '~/shared';
import { engine } from '../engine/sdr-engine.js';
import { store } from '../store/index.js';

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function fmtDb(value: unknown): string {
  const v = finite(value);
  return v === null ? '—' : `${v.toFixed(1)} dB`;
}

function fmtHz(value: unknown): string {
  const v = finite(value);
  if (v === null) return '—';
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(6)} MHz`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(3)} kHz`;
  return `${Math.round(v)} Hz`;
}

function fmtSeconds(value: unknown): string {
  const v = finite(value);
  return v === null ? '—' : `${v.toFixed(v >= 10 ? 0 : 1)} s`;
}

function fmtShortHz(hz: number): string {
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(3)} MHz`;
  if (hz >= 1e3) return `${(hz / 1e3).toFixed(1)} kHz`;
  return `${Math.round(hz)} Hz`;
}

const Metric: Component<{ label: string; value: string; title?: string }> = (props) => (
  <div class="border border-border/30 rounded-sm px-1.5 py-1 bg-sdr-base/30 min-w-0" title={props.title}>
    <div class="text-[8px] font-mono uppercase tracking-wider text-text-dim truncate">{props.label}</div>
    <div class="text-[10px] font-mono text-text-primary tabular-nums truncate">{props.value}</div>
  </div>
);

const DecoderDetails: Component<{ mode: string }> = (props) => {
  const base = () => DIGITAL_MODES[props.mode as keyof typeof DIGITAL_MODES];
  const info = () => DECODER_INFO[props.mode as keyof typeof DECODER_INFO];
  const status = () => store.decoderStatus();
  const windowInfo = () => store.decoderWindow();
  const summary = () =>
    [base()?.description, info()?.protocol, info()?.timing].filter(Boolean).join(' · ');

  const audioHz = () => finite(status()?.audioHz) ?? finite(windowInfo()?.expectedAudioHz);
  const decodes = () => finite(status()?.decodes) ?? 0;
  const nextSlot = () => {
    const ms = finite(status()?.nextSlotMs);
    return ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`;
  };
  const inRangeFrequencies = () => {
    const half = store.sampleRate() / 2;
    const center = store.centerFrequency();
    if (half <= 0) return [];
    return store.decoderFrequenciesFor(props.mode).filter(
      (f) => f.hz >= center - half && f.hz <= center + half,
    );
  };
  const tuneTo = (hz: number) =>
    engine.tune(Math.round(hz - store.centerFrequency()));

  return (
    <div class="shrink-0 border-b border-border/30 bg-sdr-surface/30">
      <div class="flex items-start gap-2 px-2 py-1">
        <div class="min-w-0">
          <div class="flex items-center gap-1.5">
            <span class="text-[10px] font-mono font-bold uppercase tracking-wider text-text-primary">
              {base()?.name ?? props.mode.toUpperCase()}
            </span>
            <span class="text-[8px] font-mono uppercase tracking-wider text-cyan border border-cyan/30 rounded px-1">
              {base()?.shortName ?? props.mode.toUpperCase()}
            </span>
          </div>
          <p class="text-[9px] font-mono text-text-dim mt-0.5 truncate" title={summary()}>
            {summary() || 'Digital decoder'}
          </p>
        </div>
        <span
          class={`ml-auto shrink-0 text-[8px] font-mono uppercase tracking-wider ${
            status()?.listening ? 'text-green-400' : 'text-text-dim'
          }`}
        >
          {status()?.listening ? 'Listening' : 'Idle'}
        </span>
      </div>

      <Show when={inRangeFrequencies().length > 0}>
        <div class="flex flex-wrap items-center gap-1 px-2 pb-1">
          <span class="text-[8px] font-mono uppercase tracking-wider text-text-dim/70">Tune</span>
          <For each={inRangeFrequencies()}>
            {(f) => (
              <button
                type="button"
                onClick={() => tuneTo(f.hz)}
                class="text-[8px] font-mono uppercase tracking-wider text-cyan/90 border border-cyan/30 rounded px-1 py-0.5 hover:border-cyan/60 hover:text-cyan hover:bg-cyan/10 transition-colors"
                title={`Tune to ${f.label} — ${fmtHz(f.hz)}`}
              >
                {f.label} {fmtShortHz(f.hz)}
              </button>
            )}
          </For>
        </div>
      </Show>

      <div class="grid grid-cols-3 sm:grid-cols-6 gap-1 px-2 pb-1.5">
        <Metric label="Level" value={fmtDb(status()?.level)} title="Passband level reported by the decoder" />
        <Metric label="Audio" value={fmtHz(audioHz())} title="Expected/current audio offset" />
        <Metric label="Period" value={fmtSeconds(status()?.period)} title="Decode slot period" />
        <Metric label="Decodes" value={String(decodes())} title="Decodes in the current slot" />
        <Metric label="Next slot" value={nextSlot()} title="Time until the next decode pass" />
        <Metric
          label="Bandwidth"
          value={`${((base()?.bandwidth ?? 0) / 1000).toFixed(1)} kHz`}
          title="Decoder passband bandwidth"
        />
      </div>
    </div>
  );
};

export default DecoderDetails;
