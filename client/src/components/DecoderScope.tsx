// ============================================================
// node-sdr — Foreground decoder scope
// ============================================================
// A small, zoomed waterfall around the exact RF window a foreground decoder
// consumes. The server reports the window (USB passband, AM/FM channel,
// fixed channel plan, raw receiver window); the client never guesses.

import { Component, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { store } from '../store/index.js';
import { engine } from '../engine/sdr-engine.js';
import type { DecoderScopeFrame, DecoderWindowInfo } from '~/shared';

const MAX_FRAMES = 160;
const MARKER_LANE = 12;

function fmtMHz(hz: number): string {
  return (hz / 1e6).toFixed(6);
}

function fmtHz(hz: number): string {
  if (!Number.isFinite(hz)) return '';
  if (Math.abs(hz) >= 1e6) return `${(hz / 1e6).toFixed(6)} MHz`;
  if (Math.abs(hz) >= 1e3) return `${(hz / 1e3).toFixed(3)} kHz`;
  return `${Math.round(hz)} Hz`;
}

function niceStep(span: number): number {
  const raw = span / 5;
  const exp = Math.floor(Math.log10(Math.max(1, raw)));
  const base = Math.pow(10, exp);
  const n = raw / base;
  const mult = n >= 5 ? 5 : n >= 2 ? 2 : 1;
  return mult * base;
}

const DecoderScope: Component<{ fullWidth?: boolean }> = (props) => {
  let canvasRef: HTMLCanvasElement | undefined;
  let containerRef: HTMLDivElement | undefined;
  let history: DecoderScopeFrame[] = [];
  let lastGeo = '';
  let lastAt = 0;
  let dragging = false;
  let dragMoved = false;
  let dragX = 0;

  const [step, setStep] = createSignal(10);
  const [hasFrames, setHasFrames] = createSignal(false);
  const [hover, setHover] = createSignal<{
    x: number;
    y: number;
    text: string;
  } | null>(null);

  const mode = () => store.decoderMode();

  /** Fallback for older servers that do not send a window event. */
  const fallbackWindow = (): DecoderWindowInfo => {
    const bw = ['ft8', 'ft4', 'ft2'].includes(mode())
      ? 3_000
      : Math.max(1_000, store.bandwidth());
    const dial = store.tunedFrequency();
    return {
      kind: 'window',
      id: '',
      mode: mode(),
      dialHz: dial,
      window: { startHz: dial, centerHz: dial + bw / 2, endHz: dial + bw, bandwidthHz: bw },
      handled: [
        {
          startHz: dial,
          centerHz: dial + bw / 2,
          endHz: dial + bw,
          bandwidthHz: bw,
          label: `${(bw / 1000).toFixed(1)} kHz USB`,
        },
      ],
      display: {
        startHz: dial - bw * 0.5,
        centerHz: dial + bw / 2,
        endHz: dial + bw * 1.5,
        bandwidthHz: bw * 2,
      },
      windowKind: 'usb',
      tunable: true,
      scope: true,
      expectedAudioHz: 1_500,
      period: 0,
      suggestTuneHz: null,
    };
  };

  const info = (): DecoderWindowInfo => store.decoderWindow() ?? fallbackWindow();

  const display = (w: DecoderWindowInfo): { start: number; end: number } => {
    // The secondary FFT is scoped to the decoder's actual bandwidth. Once a
    // frame has arrived, use its explicit absolute-Hz coverage rather than the
    // wider display hint, so the axis and the bins can never drift apart.
    const frames = engine.getDecoderScopeFrames();
    const latest = frames[frames.length - 1];
    if (latest) {
      const start = latest.startHz;
      return { start, end: start + latest.bins.length * latest.hzPerBin };
    }
    const start = w.window.startHz;
    const end = w.window.endHz;
    return { start, end: Math.max(start + 1, end) };
  };

  const hzAt = (clientX: number): number | null => {
    const canvas = canvasRef;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const d = display(info());
    return d.start + ((clientX - rect.left) / Math.max(1, rect.width)) * (d.end - d.start);
  };

  const tuneTo = (hz: number) => {
    if (!info().tunable) return;
    const half = store.sampleRate() / 2;
    const center = store.centerFrequency();
    const clamped = Math.max(center - half + 100, Math.min(center + half - 100, hz));
    engine.tune(Math.round(clamped - center));
  };

  const tuneBy = (hz: number) => {
    if (!info().tunable) return;
    tuneTo(store.tunedFrequency() + hz);
  };

  /** Strongest bin inside the handled range, then place it at the mode's
   *  expected audio offset (e.g. 1.5 kHz for FT8). */
  const bestSignal = () => {
    const w = info();
    const frames = engine.getDecoderScopeFrames();
    const frame = frames[frames.length - 1];
    if (!frame) return;
    let bestDb = -Infinity;
    let bestHz = NaN;
    for (const range of w.handled) {
      const first = Math.max(0, Math.floor((range.startHz - frame.startHz) / frame.hzPerBin));
      const last = Math.min(
        frame.bins.length - 1,
        Math.ceil((range.endHz - frame.startHz) / frame.hzPerBin),
      );
      for (let i = first; i <= last; i++) {
        const db = (frame.bins[i] / 255) * (frame.maxDb - frame.minDb) + frame.minDb;
        if (db > bestDb) {
          bestDb = db;
          bestHz = frame.startHz + (i + 0.5) * frame.hzPerBin;
        }
      }
    }
    if (!Number.isFinite(bestHz)) return;
    const expected = w.windowKind === 'usb' ? w.expectedAudioHz : 0;
    tuneTo(bestHz - expected);
  };

  /** Put the current tune at the centre of the handled window. */
  const centerDial = () => {
    const w = info();
    const bw = w.window.endHz - w.window.startHz;
    tuneTo(w.windowKind === 'usb' ? store.tunedFrequency() - bw / 2 : store.tunedFrequency());
  };

  const syncHistory = () => {
    const frames = engine.getDecoderScopeFrames();
    const latest = frames[frames.length - 1];
    if (!latest) {
      history = [];
      lastGeo = '';
      lastAt = 0;
      return;
    }
    const geo = `${latest.startHz.toFixed(2)}:${latest.hzPerBin.toFixed(4)}`;
    if (geo !== lastGeo) {
      history = [];
      lastAt = 0;
      lastGeo = geo;
    }
    for (const frame of frames) {
      if (frame.at <= lastAt) continue;
      history.push(frame);
      lastAt = frame.at;
    }
    if (history.length > MAX_FRAMES) history = history.slice(-MAX_FRAMES);
  };

  const draw = () => {
    const canvas = canvasRef;
    if (!canvas) return;
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#05070b';
    ctx.fillRect(0, 0, w, h);

    const win = info();
    const d = display(win);
    const span = d.end - d.start;
    const xOf = (hz: number) => ((hz - d.start) / span) * w;
    const yTop = MARKER_LANE;
    const plotH = Math.max(1, h - yTop);

    syncHistory();
    const has = history.length > 0 || !!engine.getLatestFftFrame();
    if (has !== hasFrames()) setHasFrames(has);
    const minDb = store.waterfallMin();
    const maxDb = store.waterfallMax();

    if (history.length > 0) {
      // Always fill the canvas height. A taller pane used to leave the lower
      // part black once the 160-frame history cap was reached; stretch the
      // visible history across the plot instead.
      const visible = history.slice(-plotH);
      const img = ctx.createImageData(w, plotH);
      const data = img.data;
      for (let y = 0; y < plotH; y++) {
        const index = Math.min(
          visible.length - 1,
          Math.floor((y * visible.length) / plotH),
        );
        const frame = visible[visible.length - 1 - index];
        const row = y * w * 4;
        for (let x = 0; x < w; x++) {
          const hz = d.start + (x / w) * span;
          const bin = Math.floor((hz - frame.startHz) / frame.hzPerBin);
          let t = 0;
          if (bin >= 0 && bin < frame.bins.length) {
            const db =
              (frame.bins[bin] / 255) * (frame.maxDb - frame.minDb) + frame.minDb;
            t = (db - minDb) / Math.max(1, maxDb - minDb);
          }
          t = Math.max(0, Math.min(1, t));
          const v = Math.round(255 * Math.pow(t, 0.8));
          const p = row + x * 4;
          data[p] = Math.round(v * 0.05);
          data[p + 1] = Math.round(60 + v * 0.55);
          data[p + 2] = Math.round(120 + v * 0.55);
          data[p + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, yTop);
    } else {
      // Fallback to the main full-span FFT while the zoom stream warms up.
      const fft = engine.getLatestFftFrame();
      if (fft && fft.length) {
        const sampleRate = store.sampleRate();
        const center = store.centerFrequency();
        const hzPerBin = sampleRate / fft.length;
        const img = ctx.createImageData(w, plotH);
        const data = img.data;
        for (let y = 0; y < plotH; y++) {
          const row = y * w * 4;
          for (let x = 0; x < w; x++) {
            const hz = d.start + (x / w) * span;
            const bin = Math.floor((hz - (center - sampleRate / 2)) / hzPerBin);
            const db = bin >= 0 && bin < fft.length ? fft[bin] : minDb;
            let t = (db - minDb) / Math.max(1, maxDb - minDb);
            t = Math.max(0, Math.min(1, t));
            const v = Math.round(255 * Math.pow(t, 0.8));
            const p = row + x * 4;
            data[p] = Math.round(v * 0.05);
            data[p + 1] = Math.round(60 + v * 0.55);
            data[p + 2] = Math.round(120 + v * 0.55);
            data[p + 3] = 255;
          }
        }
        ctx.putImageData(img, 0, yTop);
      } else {
        ctx.fillStyle = '#0a1018';
        ctx.fillRect(0, yTop, w, plotH);
      }
    }

    // Dim everything outside the handled range(s).
    const handled = [...win.handled].sort((a, b) => a.startHz - b.startHz);
    if (handled.length) {
      const complements: Array<[number, number]> = [];
      let cursor = d.start;
      for (const range of handled) {
        if (range.startHz > cursor) complements.push([cursor, range.startHz]);
        cursor = Math.max(cursor, range.endHz);
      }
      if (cursor < d.end) complements.push([cursor, d.end]);
      ctx.fillStyle = 'rgba(0,0,0,0.58)';
      for (const [a, b] of complements) {
        const x0 = Math.max(0, xOf(a));
        const x1 = Math.min(w, xOf(b));
        if (x1 > x0) ctx.fillRect(x0, yTop, x1 - x0, plotH);
      }
      for (const range of handled) {
        const x0 = Math.max(0, xOf(range.startHz));
        const x1 = Math.min(w, xOf(range.endHz));
        if (x1 <= x0) continue;
        ctx.fillStyle = 'rgba(0, 200, 255, 0.07)';
        ctx.fillRect(x0, yTop, x1 - x0, plotH);
        ctx.strokeStyle = 'rgba(0, 220, 255, 0.55)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 + 0.5, yTop + 0.5, Math.max(0, x1 - x0 - 1), plotH - 1);
        if (range.label) {
          ctx.fillStyle = 'rgba(0, 220, 255, 0.75)';
          ctx.font = '9px JetBrains Mono, monospace';
          ctx.fillText(range.label, x0 + 3, yTop + 9);
        }
      }
    }

    // Grid + frequency labels.
    const grid = niceStep(span);
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    for (let hz = Math.ceil(d.start / grid) * grid; hz <= d.end; hz += grid) {
      const x = xOf(hz);
      ctx.strokeStyle = 'rgba(120, 160, 190, 0.12)';
      ctx.beginPath();
      ctx.moveTo(x, yTop);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillStyle = 'rgba(150, 180, 200, 0.65)';
      const label = grid >= 1_000 ? `${(hz / 1_000).toFixed(0)}k` : `${hz.toFixed(0)}`;
      ctx.fillText(label, x, h - 2);
    }
    ctx.textAlign = 'left';

    // Decode markers: a solid lane at the top plus a faint guide down the
    // waterfall. Older markers fade rather than disappearing instantly.
    const now = Date.now();
    const markers =
      mode() === 'js8'
        ? store.js8Messages().map((message) => ({
            decoderType: 'js8',
            receivedAt: message.at * 1000,
            data: {
              kind: 'message',
              rfHz: message.rfHz,
              audioHz: message.audioHz,
              snrDb: message.snrDb,
              signalBwHz: 50,
              text: message.text,
              stats: { crcOk: true },
            } as Record<string, unknown>,
          }))
        : store
            .decoderMessages()
            .filter(
              (m) =>
                m.decoderType === mode() &&
                (m.data.kind === 'decode' || m.data.kind === 'message' || !m.data.kind),
            )
            .slice(0, 60);
    for (const marker of markers) {
      const data = marker.data as Record<string, unknown>;
      const audio = typeof data.audioHz === 'number' ? data.audioHz : 0;
      const rf =
        typeof data.rfHz === 'number' ? data.rfHz : win.dialHz + audio;
      if (rf < d.start || rf > d.end) continue;
      const x = xOf(rf);
      const snr = typeof data.snrDb === 'number' ? data.snrDb : 0;
      const stats = (data.stats ?? {}) as Record<string, unknown>;
      const hard = typeof stats.hardErrors === 'number' ? stats.hardErrors : 0;
      const confidence =
        typeof stats.confidence === 'number' ? stats.confidence : hard === 0 ? 1 : 0.5;
      const age = Math.max(0, now - marker.receivedAt);
      const alpha = Math.max(0.18, 1 - age / 60_000);
      const sigBw = typeof data.signalBwHz === 'number' ? data.signalBwHz : 50;
      const barW = Math.max(2, (sigBw / span) * w);
      const barH = Math.max(3, Math.min(MARKER_LANE - 2, 3 + Math.max(0, snr) * 0.35));
      ctx.globalAlpha = alpha;
      ctx.fillStyle =
        confidence >= 0.9 ? '#38f5d0' : confidence >= 0.6 ? '#ffd24a' : '#ff8a5b';
      ctx.fillRect(x - barW / 2, MARKER_LANE - barH, barW, barH);
      ctx.fillStyle = 'rgba(56, 245, 208, 0.12)';
      ctx.fillRect(x - 0.5, yTop, 1, plotH);
      ctx.globalAlpha = 1;
    }

    // Dial and current tune.
    const dialX = xOf(win.dialHz);
    ctx.strokeStyle = 'rgba(255, 210, 74, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(dialX, MARKER_LANE);
    ctx.lineTo(dialX, h);
    ctx.stroke();
    ctx.fillStyle = '#ffd24a';
    ctx.beginPath();
    ctx.moveTo(dialX - 3, MARKER_LANE);
    ctx.lineTo(dialX + 3, MARKER_LANE);
    ctx.lineTo(dialX, MARKER_LANE - 5);
    ctx.closePath();
    ctx.fill();

    const tuned = store.tunedFrequency();
    if (Math.abs(tuned - win.dialHz) > 1) {
      const tx = xOf(tuned);
      ctx.strokeStyle = 'rgba(120, 220, 255, 0.9)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(tx, MARKER_LANE);
      ctx.lineTo(tx, h);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Slot progress: a thin fill along the bottom edge.
    const status = store.decoderStatus();
    if (status?.nextSlotMs !== undefined && status.period) {
      const periodMs = Math.max(1, status.period * 1000);
      const progress = 1 - Math.min(1, status.nextSlotMs / periodMs);
      ctx.fillStyle = 'rgba(0, 220, 255, 0.75)';
      ctx.fillRect(0, h - 1, w * progress, 1);
    }

    // Hover crosshair.
    const hv = hover();
    if (hv) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(hv.x, MARKER_LANE);
      ctx.lineTo(hv.x, h);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  };

  createEffect(() => {
    // Track everything the canvas reads.
    store.decoderScopeSeq();
    store.decoderWindow();
    store.decoderStatus();
    store.decoderMessages();
    store.tunedFrequency();
    store.waterfallMin();
    store.waterfallMax();
    draw();
  });

  onMount(() => {
    const ro = new ResizeObserver(() => draw());
    if (containerRef) ro.observe(containerRef);
    window.addEventListener('resize', draw);
    onCleanup(() => {
      ro.disconnect();
      window.removeEventListener('resize', draw);
    });
  });

  const onPointerDown = (e: PointerEvent) => {
    if (!info().tunable) return;
    dragging = true;
    dragMoved = false;
    dragX = e.clientX;
    try {
      canvasRef?.setPointerCapture(e.pointerId);
    } catch {
      // Pointer capture is best-effort; dragging still works without it.
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    const canvas = canvasRef;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const hz = hzAt(e.clientX);
    if (hz === null) return;
    const d = display(info());
    const bin = Math.floor(((hz - d.start) / (d.end - d.start)) * 512);
    const frame = history[history.length - 1];
    let dbText = '';
    if (frame && bin >= 0 && bin < frame.bins.length) {
      const db = (frame.bins[bin] / 255) * (frame.maxDb - frame.minDb) + frame.minDb;
      dbText = ` · ${db.toFixed(0)} dB`;
    }
    setHover({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      text: `${fmtHz(hz)}${dbText}`,
    });
    if (dragging) {
      if (Math.abs(e.clientX - dragX) > 2) dragMoved = true;
      if (dragMoved) tuneTo(hz);
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    if (dragging && !dragMoved) {
      const hz = hzAt(e.clientX);
      if (hz !== null) tuneTo(hz);
    }
    dragging = false;
    try {
      canvasRef?.releasePointerCapture(e.pointerId);
    } catch {
      // Released already, or capture was never taken.
    }
  };

  const onWheel = (e: WheelEvent) => {
    if (!info().tunable) return;
    e.preventDefault();
    const mult = e.shiftKey ? 10 : 1;
    tuneBy(-Math.sign(e.deltaY) * step() * mult);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!info().tunable) return;
    const mult = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft') {
      tuneBy(-step() * mult);
      e.preventDefault();
    } else if (e.key === 'ArrowRight') {
      tuneBy(step() * mult);
      e.preventDefault();
    } else if (e.key.toLowerCase() === 'c') {
      centerDial();
      e.preventDefault();
    } else if (e.key.toLowerCase() === 'b') {
      bestSignal();
      e.preventDefault();
    }
  };

  return (
    <div
      class={
        props.fullWidth
          ? 'w-full h-[210px] flex flex-col bg-black/60 border border-border/40'
          : 'md:w-[46%] min-h-[190px] md:min-h-0 flex flex-col bg-black/60 border-border/40 md:border-l border-t md:border-t-0'
      }
    >
      <div class="flex items-center gap-2 px-2 py-1 border-b border-border/30 text-[9px] font-mono uppercase tracking-wider shrink-0">
        <span class="text-cyan">{mode().toUpperCase()}</span>
        <span class="text-text-secondary">{fmtMHz(info().dialHz)}</span>
        <span class="text-text-dim">
          W {((info().window.endHz - info().window.startHz) / 1000).toFixed(1)}k
        </span>
        <Show when={store.decoderStatus()?.level !== undefined}>
          <span class="text-text-dim">
            LVL {Math.round(store.decoderStatus()!.level ?? 0)} dB
          </span>
        </Show>
        <Show when={store.decoderStatus()?.decodes !== undefined}>
          <span class="text-text-dim">{store.decoderStatus()!.decodes} dec</span>
        </Show>
        <Show when={store.decoderSlot()}>
          <span class="text-text-dim">
            {store.decoderSlot()!.decodes}d / {store.decoderSlot()!.elapsedMs}ms
          </span>
        </Show>
        <Show
          when={
            store.decoderSlot()?.decodes === 0 &&
            (store.decoderSlot()?.budget?.stagesRun ?? 0) > 0
          }
        >
          <span class="text-amber">no decode</span>
        </Show>
        <Show when={store.decoderStatus()?.nextSlotMs !== undefined}>
          <span class="ml-auto text-cyan/80">
            {((store.decoderStatus()!.nextSlotMs ?? 0) / 1000).toFixed(1)}s
          </span>
        </Show>
      </div>

      <div ref={(el) => { containerRef = el; }} class="relative flex-1 min-h-0">
        <canvas
          ref={(el) => { canvasRef = el; }}
          class="absolute inset-0 w-full h-full outline-none"
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => { setHover(null); dragging = false; }}
          onWheel={onWheel}
          onKeyDown={onKeyDown}
          title="Click to tune, drag to sweep, wheel for the micro step"
        />
        <Show when={hover()}>
          {(hv) => (
            <div
              class="absolute pointer-events-none z-20 px-1.5 py-0.5 rounded-sm border border-cyan/40 bg-sdr-base/95 text-[9px] font-mono text-text-primary whitespace-nowrap"
              style={{
                left: `${Math.min(hv().x + 8, (containerRef?.clientWidth ?? 200) - 120)}px`,
                top: `${Math.max(2, hv().y - 18)}px`,
              }}
            >
              {hv().text}
            </div>
          )}
        </Show>
        <Show when={!hasFrames()}>
          <span class="absolute inset-0 flex items-center justify-center text-[9px] font-mono text-text-dim">
            waiting for spectrum…
          </span>
        </Show>
      </div>

      <div class="flex items-center gap-1 px-1.5 py-1 border-t border-border/30 shrink-0 overflow-x-auto">
        <button class="mil-btn text-[10px] px-1.5 py-0.5" onClick={() => tuneBy(-step() * 10)} title="−10 steps">
          ≪
        </button>
        <button class="mil-btn text-[10px] px-1.5 py-0.5" onClick={() => tuneBy(-step())} title="−1 step">
          ‹
        </button>
        <select
          class="bg-sdr-base border border-border/50 rounded-sm text-[10px] font-mono text-text-secondary px-0.5 py-0.5"
          value={step()}
          onChange={(e) => setStep(Number(e.currentTarget.value) || 10)}
          title="Micro tuning step"
        >
          <option value={1}>1 Hz</option>
          <option value={10}>10 Hz</option>
          <option value={100}>100 Hz</option>
          <option value={1000}>1 kHz</option>
        </select>
        <button class="mil-btn text-[10px] px-1.5 py-0.5" onClick={() => tuneBy(step())} title="+1 step">
          ›
        </button>
        <button class="mil-btn text-[10px] px-1.5 py-0.5" onClick={() => tuneBy(step() * 10)} title="+10 steps">
          ≫
        </button>
        <span class="px-1 text-[10px] font-mono text-cyan tabular-nums whitespace-nowrap">
          {fmtMHz(store.tunedFrequency())}
        </span>
        <button class="mil-btn text-[9px] px-1.5 py-0.5 ml-auto shrink-0" onClick={bestSignal} title="Tune the strongest signal to the decoder's audio offset">
          BEST
        </button>
        <button class="mil-btn text-[9px] px-1.5 py-0.5 shrink-0" onClick={centerDial} title="Put the current tune at the centre of the handled window">
          CENTER
        </button>
      </div>
    </div>
  );
};

export default DecoderScope;
