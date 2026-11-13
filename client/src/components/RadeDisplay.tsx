import { Component, Show } from 'solid-js';
import { store } from '../store/index.js';

const RadeDisplay: Component = () => {
  const status = () => store.radeStatus();
  return (
    <div class="flex-1 min-h-0 overflow-auto p-4">
      <div class="max-w-3xl space-y-4 font-mono">
        <div class="border border-border/40 rounded-md bg-sdr-base/30 p-4">
          <div class="flex items-center justify-between gap-4">
            <div>
              <div class="text-[9px] uppercase tracking-[0.2em] text-text-dim">FreeDV RADE V1</div>
              <div class="text-sm text-text-primary mt-1">
                {status()?.sync ? 'Speech decoder in sync' : 'Searching for RADE signal'}
              </div>
            </div>
            <span class={`text-[10px] uppercase tracking-wider px-2 py-1 rounded-sm border ${
              status()?.sync
                ? 'text-green-400 border-green-400/40 bg-green-400/5'
                : 'text-amber border-amber/40 bg-amber/5'
            }`}>
              {status()?.sync ? 'SYNC' : 'SEARCH'}
            </span>
          </div>
          <p class="text-[10px] text-text-dim mt-3 leading-relaxed">
            Tune USB to 14.236 MHz. Decoded speech plays through the normal audio
            controls; this panel shows the modem and callsign state.
          </p>
        </div>

        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="SNR" value={`${(status()?.snrDb ?? 0).toFixed(1)} dB`} />
          <Stat label="Offset" value={`${(status()?.freqOffsetHz ?? 0).toFixed(1)} Hz`} />
          <Stat label="RX Level" value={`${Math.round((status()?.rxLevel ?? 0) * 100)}%`} />
          <Stat label="EOO Frames" value={String(status()?.eooCount ?? 0)} />
        </div>

        <div class="border border-border/40 rounded-md bg-sdr-base/30 p-4">
          <div class="text-[9px] uppercase tracking-wider text-text-dim mb-2">Station</div>
          <Show when={status()?.callsign} fallback={
            <div class="text-xs text-text-dim">No callsign decoded yet.</div>
          }>
            <div class="text-lg text-cyan tracking-wider">{status()?.callsign}</div>
          </Show>
          <Show when={status()?.dropped}>
            <div class="text-[10px] text-amber mt-2">
              {status()?.dropped} samples dropped — the decoder is not keeping up.
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
};

const Stat: Component<{ label: string; value: string }> = (props) => (
  <div class="border border-border/30 rounded-sm bg-sdr-base/20 px-3 py-2">
    <div class="text-[8px] uppercase tracking-wider text-text-dim">{props.label}</div>
    <div class="text-xs text-text-primary mt-1">{props.value}</div>
  </div>
);

export default RadeDisplay;
