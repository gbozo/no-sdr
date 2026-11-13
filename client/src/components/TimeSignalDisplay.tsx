import { Component, Show } from 'solid-js';
import { store } from '../store/index.js';

const WEEKDAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const TimeSignalDisplay: Component = () => {
  const clock = () => store.timeSignalClock();
  const status = () => store.timeSignalStatus();
  const mode = () => (store.decoderMode() === 'als162' ? 'ALS162' : 'DCF77');

  return (
    <div class="flex flex-col gap-3 p-3 h-full overflow-y-auto">
      <div class="flex items-center justify-between border border-border/40 rounded-md bg-sdr-surface/30 px-3 py-2">
        <div class="flex items-center gap-2">
          <span class="text-[10px] font-mono uppercase tracking-wider text-text-dim">{mode()} time signal</span>
          <span class={`w-1.5 h-1.5 rounded-full ${status().sync ? 'bg-green-400 animate-pulse' : 'bg-text-dim/40'}`} />
          <span class={`text-[9px] font-mono uppercase ${status().sync ? 'text-green-400' : 'text-text-dim'}`}>
            {status().sync ? 'SYNC' : 'SEARCHING'}
          </span>
        </div>
        <div class="flex gap-4 text-[9px] font-mono text-text-dim">
          <span>BITS {status().bits}</span>
          <Show when={status().second !== undefined}><span>SEC {status().second}</span></Show>
          <Show when={status().pulses !== undefined}><span>PULSES {status().pulses}</span></Show>
          <span>LEVEL {(status().level ?? 0).toFixed(3)}</span>
        </div>
      </div>

      <Show when={clock()} fallback={
        <div class="flex-1 grid place-items-center text-center border border-border/30 rounded-md bg-sdr-surface/20 p-8">
          <div class="space-y-2">
            <div class="text-sm font-mono text-text-dim">Waiting for a complete minute…</div>
            <div class="text-[10px] font-mono text-text-dim/70">
              Tune {mode()} and keep the receiver stable long enough to collect all 59 bits.
            </div>
          </div>
        </div>
      }>
        {(c) => (
          <div class="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <div class="lg:col-span-2 border border-border/40 rounded-md bg-sdr-surface/30 p-5">
              <div class="text-[10px] font-mono uppercase tracking-widest text-text-dim mb-2">Decoded local time</div>
              <div class="text-4xl font-mono text-cyan tracking-wider tabular-nums">
                {String(c().hour).padStart(2, '0')}:{String(c().minute).padStart(2, '0')}
              </div>
              <div class="text-sm font-mono text-text-primary mt-2">
                {c().year}-{String(c().month).padStart(2, '0')}-{String(c().day).padStart(2, '0')}
                <span class="text-text-dim ml-2">{WEEKDAYS[c().weekday] ?? ''}</span>
              </div>
              <div class="text-[10px] font-mono text-text-dim mt-3">
                UTC offset {c().utcOffsetMin >= 0 ? '+' : ''}{c().utcOffsetMin} min · {c().text}
              </div>
            </div>

            <div class="border border-border/40 rounded-md bg-sdr-surface/30 p-4 space-y-2">
              <Flag label="DST" value={c().dst} />
              <Flag label="Leap second" value={c().leapSecond} />
              <Flag label="Clock change" value={c().clockChange} />
              <Flag label="Holiday today" value={c().holidayToday} />
              <Flag label="Holiday tomorrow" value={c().holidayTomorrow} />
              <div class="pt-2 text-[9px] font-mono text-text-dim/70">
                Unix {c().unix}
              </div>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
};

const Flag: Component<{ label: string; value: boolean }> = (props) => (
  <div class="flex items-center justify-between text-[10px] font-mono">
    <span class="text-text-dim">{props.label}</span>
    <span class={props.value ? 'text-amber' : 'text-text-dim/50'}>{props.value ? 'YES' : 'no'}</span>
  </div>
);

export default TimeSignalDisplay;
