// ============================================================
// node-sdr — client-side signal identifier
// ============================================================
// Captures a few seconds of full-span FFT data plus the live raw-IQ stream,
// ranks the decoder modes that could receive the tuned signal, and lets the
// operator open a candidate directly. No server-side decoder probing.

import { Component, For, Show, createSignal, onMount, onCleanup } from 'solid-js';
import { engine } from '../engine/sdr-engine.js';
import { store } from '../store/index.js';
import { identifySignal, type IdentifierCandidate, type IdentifierResult } from '../engine/signal-identifier.js';
import { RawIqProbe } from '../engine/raw-iq-probe.js';

const CAPTURE_MS = 3000;
const MAX_FRAMES = 40;

const SignalIdentifier: Component<{ onClose: () => void }> = (props) => {
  const [phase, setPhase] = createSignal<'capturing' | 'done'>('capturing');
  const [progress, setProgress] = createSignal(0);
  const [result, setResult] = createSignal<IdentifierResult | null>(null);
  let timer: ReturnType<typeof setInterval> | undefined;
  let frames: Float32Array[] = [];
  let lastFrame: Float32Array | null = null;
  let startedAt = 0;
  let probe: RawIqProbe | null = null;
  let iqPromise: Promise<Int16Array[]> | null = null;
  let finishing = false;
  let runId = 0;

  const finish = async (id: number) => {
    if (id !== runId) return;
    if (finishing) return;
    finishing = true;
    if (timer) { clearInterval(timer); timer = undefined; }
    engine.stopIqCapture();
    const p = iqPromise;
    const fallback = engine.takeIqCapture();
    const iq = p ? await p : [];
    const next = identifySignal(frames, iq.length ? iq : fallback, {
      sampleRate: store.sampleRate(),
      centerHz: store.centerFrequency(),
      tuneHz: store.tunedFrequency(),
      mode: store.mode(),
      iqRate: store.iqSampleRate(),
    });
    setResult(next);
    setProgress(1);
    setPhase('done');
  };

  const run = () => {
    if (timer) clearInterval(timer);
    probe?.close();
    const id = ++runId;
    finishing = false;
    setPhase('capturing');
    setProgress(0);
    setResult(null);
    frames = [];
    lastFrame = null;
    startedAt = performance.now();

    // The identifier uses a second WebSocket for raw IQ, leaving the main
    // client's mode/audio path untouched.
    probe = new RawIqProbe(store.activeDongleId(), store.activeProfileId(), 300_000);
    iqPromise = probe.capture(CAPTURE_MS);
    engine.startIqCapture(CAPTURE_MS + 500);

    timer = setInterval(() => {
      const frame = engine.getLatestFftFrame();
      if (frame && frame !== lastFrame) {
        lastFrame = frame;
        frames.push(new Float32Array(frame));
      }
      const elapsed = performance.now() - startedAt;
      setProgress(Math.min(0.98, elapsed / CAPTURE_MS));
      if (elapsed >= CAPTURE_MS || frames.length >= MAX_FRAMES) {
        if (timer) clearInterval(timer);
        timer = undefined;
        void finish(id);
      }
    }, 100);
  };

  onMount(run);
  onCleanup(() => {
    if (timer) clearInterval(timer);
    engine.stopIqCapture();
    probe?.close();
  });

  const open = (candidate: IdentifierCandidate) => {
    engine.setDecoder(candidate.id);
    props.onClose();
  };

  const pct = (v: number) => `${Math.round(v * 100)}%`;

  return (
    <div
      class="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-3"
      onClick={props.onClose}
    >
      <div
        class="w-full max-w-2xl max-h-full flex flex-col rounded-sm border border-cyan/30 bg-sdr-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="flex items-center gap-3 px-3 py-2 border-b border-border/50 shrink-0">
          <div>
            <div class="text-[10px] font-mono font-bold uppercase tracking-wider text-text-primary">
              Signal Identification
            </div>
            <div class="text-[8px] font-mono text-text-dim">
              Client-side · full-span FFT + raw IQ · no server decoder probing
            </div>
          </div>
          <button
            onClick={props.onClose}
            class="ml-auto text-[10px] font-mono text-text-dim hover:text-amber px-1"
            title="Close"
          >
            ✕
          </button>
        </div>

        <div class="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
          <Show when={phase() === 'capturing'}>
            <div class="space-y-2">
              <div class="text-[9px] font-mono text-text-secondary">
                Capturing spectrum and raw 300 kHz IQ around {fmtFreq(store.tunedFrequency())} …
              </div>
              <div class="h-1.5 rounded-full bg-sdr-base border border-border/40 overflow-hidden">
                <div
                  class="h-full bg-cyan transition-[width] duration-100"
                  style={{ width: `${Math.round(progress() * 100)}%` }}
                />
              </div>
              <div class="text-[8px] font-mono text-text-muted">
                {frames.length} FFT frames · {pct(progress())} · separate raw-IQ WebSocket at 300 kHz;
                your current mode, bandwidth and audio are untouched.
              </div>
            </div>
          </Show>

          <Show when={phase() === 'done' && result()}>
            {(r) => (
              <>
                <div class="grid grid-cols-3 sm:grid-cols-6 gap-px bg-border/40 border border-border/40">
                  <Stat label="Signal" value={pct(r().features.presentProbability)} tone="text-cyan" />
                  <Stat label="SNR" value={`${r().features.snrDb.toFixed(1)} dB`} />
                  <Stat label="Occupied" value={fmtSpan(r().features.occupiedBwHz)} />
                  <Stat label="Activity" value={pct(r().features.activity)} />
                  <Stat label="Burst" value={r().features.burstiness.toFixed(2)} />
                  <Stat label="Frames" value={String(r().features.frames)} />
                </div>

                <div class="text-[8px] font-mono text-text-dim">
                  Analyzed ±{fmtSpan(r().features.analyzerSpanHz / 2)} · peak {fmtFreq(r().features.peakHz)} ·
                  IQ duty {pct(r().features.iqDuty)}
                </div>

                <Show
                  when={r().candidates.length > 0}
                  fallback={
                    <div class="text-[9px] font-mono text-text-dim border border-border/30 rounded-sm p-3">
                      No decoder matched confidently. Check the tuning, filter bandwidth, or let the
                      signal run longer.
                    </div>
                  }
                >
                  <div class="space-y-1.5">
                    <For each={r().candidates}>
                      {(candidate) => (
                        <div class="border border-border/40 rounded-sm bg-sdr-base/40 p-2 space-y-1">
                          <div class="flex items-center gap-2">
                            <span class="text-[10px] font-mono text-text-primary">{candidate.name}</span>
                            <span class="text-[8px] font-mono uppercase text-cyan border border-cyan/30 rounded px-1">
                              {candidate.shortName}
                            </span>
                            <span class={`ml-auto text-[10px] font-mono tabular-nums ${
                              candidate.score >= 0.5 ? 'text-green-400' : candidate.score >= 0.25 ? 'text-amber' : 'text-text-dim'
                            }`}>
                              {pct(candidate.score)}
                            </span>
                            <button
                              onClick={() => open(candidate)}
                              class="mil-btn text-[8px] px-1.5 py-0.5"
                              title={`Open the ${candidate.name} decoder`}
                            >
                              Open
                            </button>
                          </div>
                          <div class="h-1 rounded-full bg-sdr-base border border-border/30 overflow-hidden">
                            <div
                              class="h-full bg-cyan"
                              style={{ width: `${Math.min(100, Math.round(candidate.score * 100))}%` }}
                            />
                          </div>
                          <div class="text-[8px] font-mono text-text-dim">
                            {candidate.reasons.join(' · ')}
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>

                <p class="text-[8px] font-mono text-text-muted border-t border-border/30 pt-2">
                  Heuristic confidence, not a calibrated probability. ADS-B, VDL2 and AIS are
                  excluded; packet is scored as a bursty narrowband candidate. Open a candidate
                  decoder to confirm.
                </p>

                <div class="flex justify-end gap-1">
                  <button onClick={run} class="mil-btn text-[8px] px-2 py-0.5">
                    Scan again
                  </button>
                  <button onClick={props.onClose} class="mil-btn text-[8px] px-2 py-0.5">
                    Close
                  </button>
                </div>
              </>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
};

function fmtFreq(hz: number): string {
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(6)} MHz`;
  if (hz >= 1e3) return `${(hz / 1e3).toFixed(3)} kHz`;
  return `${hz.toFixed(0)} Hz`;
}

function fmtSpan(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return '—';
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(3)} MHz`;
  if (hz >= 1e3) return `${(hz / 1e3).toFixed(2)} kHz`;
  return `${hz.toFixed(0)} Hz`;
}

const Stat: Component<{ label: string; value: string; tone?: string }> = (props) => (
  <div class="bg-sdr-surface/70 px-1.5 py-0.5 min-w-0">
    <div class="text-[7px] uppercase tracking-wider text-text-dim truncate">{props.label}</div>
    <div class={`text-[9px] leading-tight whitespace-nowrap ${props.tone ?? 'text-text-primary'}`}>
      {props.value}
    </div>
  </div>
);

export default SignalIdentifier;
