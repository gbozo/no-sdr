// ============================================================
// node-sdr — Decoder information panel
// ============================================================
// Reference card for the active foreground decoder: operating notes,
// typical frequencies, and an illustrative waterfall signature.

import { Component, For, Show, createEffect, onCleanup } from 'solid-js';
import { DIGITAL_MODES, DECODER_INFO, type DecoderPreviewStyle } from '~/shared';
import { engine } from '../engine/sdr-engine.js';
import { store } from '../store/index.js';

function fmtFreq(hz: number): string {
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(6)} MHz`;
  if (hz >= 1e3) return `${(hz / 1e3).toFixed(3)} kHz`;
  return `${hz.toFixed(0)} Hz`;
}

function inSpan(hz: number): boolean {
  const span = store.sampleRate();
  return Math.abs(hz - store.centerFrequency()) <= span / 2;
}

const DecoderInfoPanel: Component<{ mode: string; onClose: () => void }> = (props) => {
  const base = () => DIGITAL_MODES[props.mode as keyof typeof DIGITAL_MODES];
  const info = () => DECODER_INFO[props.mode as keyof typeof DECODER_INFO];

  return (
    <div class="absolute inset-0 z-30 flex items-stretch justify-center bg-black/65 p-2 md:p-4" onClick={props.onClose}>
      <div
        class="w-full max-w-2xl min-h-0 flex flex-col rounded-sm border border-cyan/30 bg-sdr-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="flex items-start gap-3 px-3 py-2 border-b border-border/50 shrink-0">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-[11px] font-mono font-bold text-text-primary uppercase tracking-wider">
                {base()?.name ?? props.mode}
              </span>
              <span class="text-[8px] font-mono uppercase tracking-wider text-cyan border border-cyan/30 rounded px-1">
                {base()?.shortName ?? props.mode.toUpperCase()}
              </span>
            </div>
            <div class="text-[8px] font-mono text-text-dim mt-0.5 truncate">
              {base()?.description ?? 'Digital decoder'}
            </div>
          </div>
          <button
            onClick={props.onClose}
            class="ml-auto text-[10px] font-mono text-text-dim hover:text-amber px-1 py-0.5"
            title="Close decoder information"
          >
            ✕
          </button>
        </div>

        <div class="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
          <Show when={info()}>
            {(data) => (
              <>
                <div class="grid grid-cols-2 gap-x-3 gap-y-1 text-[8px] font-mono">
                  <div>
                    <span class="text-text-dim uppercase tracking-wider">Protocol</span>
                    <div class="text-text-secondary">{data().protocol}</div>
                  </div>
                  <div>
                    <span class="text-text-dim uppercase tracking-wider">Timing</span>
                    <div class="text-text-secondary">{data().timing}</div>
                  </div>
                  <div>
                    <span class="text-text-dim uppercase tracking-wider">Bandwidth</span>
                    <div class="text-text-secondary">{(base()?.bandwidth ?? 0).toLocaleString()} Hz</div>
                  </div>
                  <div>
                    <span class="text-text-dim uppercase tracking-wider">Decoder rate</span>
                    <div class="text-text-secondary">{(base()?.sampleRate ?? 0).toLocaleString()} Hz</div>
                  </div>
                </div>

                <div>
                  <div class="flex items-center justify-between mb-1">
                    <span class="text-[8px] font-mono uppercase tracking-wider text-text-dim">Typical waterfall signature</span>
                    <span class="text-[7px] font-mono text-text-muted">illustrative</span>
                  </div>
                  <SignalPreview mode={props.mode} preview={data().preview} />
                  <p class="text-[8px] font-mono text-text-secondary mt-1">{data().waterfall}</p>
                </div>

                <div>
                  <div class="text-[8px] font-mono uppercase tracking-wider text-text-dim mb-1">Typical frequencies</div>
                  <div class="grid grid-cols-2 sm:grid-cols-3 gap-1">
                    <For each={data().frequencies}>
                      {(f) => (
                        <button
                          onClick={() => {
                            if (!inSpan(f.hz)) return;
                            engine.tune(f.hz - store.centerFrequency());
                          }}
                          disabled={!inSpan(f.hz)}
                          class={`flex items-center justify-between gap-2 px-1.5 py-0.5 rounded-sm border text-left text-[8px] font-mono ${
                            inSpan(f.hz)
                              ? 'border-border/40 text-text-secondary hover:border-cyan/50 hover:text-cyan'
                              : 'border-border/20 text-text-muted cursor-not-allowed'
                          }`}
                          title={inSpan(f.hz) ? `Tune to ${fmtFreq(f.hz)}` : 'Outside the current receiver span'}
                        >
                          <span class="truncate">{f.label}</span>
                          <span class="tabular-nums text-[7px]">{fmtFreq(f.hz)}</span>
                        </button>
                      )}
                    </For>
                  </div>
                  <div class="text-[7px] font-mono text-text-muted mt-1">
                    Dimmed frequencies are outside the current receiver span. Change profile/centre to receive them.
                  </div>
                </div>

                <div>
                  <div class="text-[8px] font-mono uppercase tracking-wider text-text-dim mb-1">What to look for</div>
                  <ul class="space-y-1 text-[8px] font-mono text-text-secondary">
                    <For each={data().tips}>
                      {(tip) => <li class="flex gap-1.5"><span class="text-cyan">•</span><span>{tip}</span></li>}
                    </For>
                  </ul>
                </div>

                <div class="text-[7px] font-mono text-text-muted border-t border-border/30 pt-1.5">
                  Typical calling/operating channels; regional usage and schedules vary. Waterfall previews are illustrative, not recordings.
                </div>
              </>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
};

const SignalPreview: Component<{ mode: string; preview: DecoderPreviewStyle }> = (props) => {
  let canvasRef: HTMLCanvasElement | undefined;

  const draw = () => {
    const canvas = canvasRef;
    if (!canvas) return;
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Deterministic pseudo-random noise so the preview is stable per decoder.
    let seed = 2166136261;
    for (let i = 0; i < props.mode.length; i++) {
      seed ^= props.mode.charCodeAt(i);
      seed = Math.imul(seed, 16777619);
    }
    const rand = () => {
      seed = Math.imul(seed ^ (seed >>> 15), 2246822519);
      seed = Math.imul(seed ^ (seed >>> 13), 3266489917);
      return ((seed ^ (seed >>> 16)) >>> 0) / 4294967296;
    };

    ctx.fillStyle = '#04070d';
    ctx.fillRect(0, 0, w, h);

    // Base noise floor.
    for (let i = 0; i < Math.floor(w * h * 0.10); i++) {
      const x = Math.floor(rand() * w);
      const y = Math.floor(rand() * h);
      const a = 0.04 + rand() * 0.10;
      ctx.fillStyle = `rgba(60,120,170,${a})`;
      ctx.fillRect(x, y, 1, 1);
    }

    const accent = 'rgba(80,230,190,';
    const warm = 'rgba(255,190,80,';
    const bright = (y: number, x: number, width: number, height: number, color: string, alpha: number) => {
      ctx.fillStyle = `${color}${alpha})`;
      ctx.fillRect(x, y, width, height);
      ctx.fillStyle = `${color}${Math.min(1, alpha + 0.25)})`;
      ctx.fillRect(x, y + height / 2, width, Math.max(1, height / 3));
    };

    if (props.preview === 'mfsk') {
      const slots = 4;
      const slotW = w / slots;
      for (let s = 0; s < slots; s++) {
        const x0 = s * slotW + 4;
        const width = slotW - 8;
        const tones = 4 + Math.floor(rand() * 4);
        for (let t = 0; t < tones; t++) {
          const y = h * (0.25 + rand() * 0.45);
          bright(y, x0 + rand() * width * 0.2, width * (0.45 + rand() * 0.4), 2, accent, 0.35 + rand() * 0.3);
        }
      }
    } else if (props.preview === 'narrow') {
      let y = h * (0.4 + rand() * 0.2);
      for (let x = 0; x < w; x += 2) {
        y += (rand() - 0.5) * 0.8;
        bright(y, x, 2, 1.5, accent, 0.35 + rand() * 0.25);
      }
    } else if (props.preview === 'rtty') {
      const y1 = h * 0.38;
      const y2 = h * 0.58;
      for (let x = 0; x < w; x += 3) {
        const onHigh = Math.floor(x / 6) % 2 === 0;
        bright(onHigh ? y1 : y2, x, 3, 2, accent, 0.45);
        if (rand() > 0.92) bright(onHigh ? y2 : y1, x, 2, 1, accent, 0.2);
      }
    } else if (props.preview === 'burst') {
      for (let b = 0; b < 4; b++) {
        const x = (b / 4) * w + rand() * w * 0.06;
        const width = w * (0.10 + rand() * 0.14);
        const top = h * (0.25 + rand() * 0.2);
        const height = h * (0.25 + rand() * 0.3);
        bright(top, x, width, height, warm, 0.25 + rand() * 0.25);
      }
    } else if (props.preview === 'wide') {
      for (let t = 0; t < 5; t++) {
        const base = h * (0.25 + t * 0.1);
        for (let x = 0; x < w; x += 2) {
          const y = base + Math.sin(x * 0.06 + t) * h * 0.05;
          bright(y, x, 2, 1.5, accent, 0.25 + rand() * 0.2);
        }
      }
    } else if (props.preview === 'pulse') {
      for (let p = 0; p < 12; p++) {
        const x = rand() * w;
        const height = h * (0.1 + rand() * 0.45);
        bright(h * 0.45 - height / 2, x, 1.5, height, warm, 0.4 + rand() * 0.4);
      }
    } else if (props.preview === 'time') {
      for (let x = 0; x < w; x += 2) {
        bright(h * 0.55, x, 2, 1.6, accent, 0.45);
      }
      for (let x = w * 0.12; x < w; x += w * 0.16) {
        ctx.fillStyle = 'rgba(4,7,13,0.9)';
        ctx.fillRect(x, h * 0.5, 2, h * 0.1);
      }
    } else {
      // fax: sweeping diagonal tones plus sync bars
      for (let x = 0; x < w; x++) {
        const y = h * 0.5 + Math.sin(x * 0.11) * h * 0.22;
        bright(y, x, 1, 1.3, accent, 0.25 + (x / w) * 0.35);
      }
      for (let x = 0; x < w; x += w * 0.22) {
        bright(h * 0.2, x, 2, h * 0.6, warm, 0.35);
      }
    }

    // Frame
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    ctx.fillStyle = 'rgba(120,140,160,0.5)';
    ctx.font = '7px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('frequency →', 4, h - 4);
    ctx.save();
    ctx.translate(w - 5, h - 4);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('time →', 0, 0);
    ctx.restore();
  };

  createEffect(() => {
    // Track both props for reactive redraw.
    props.mode;
    props.preview;
    draw();
  });

  onCleanup(() => { /* no timers */ });

  return <canvas ref={canvasRef} class="w-full h-20 rounded-sm bg-black/60" />;
};

export default DecoderInfoPanel;
