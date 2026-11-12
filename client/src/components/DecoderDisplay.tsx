// ============================================================
// node-sdr — Decoder workspace
// ============================================================
// Replaces the lower half of the main waterfall when a foreground decoder is
// active: decode table on the left, receiver-span waterfall on the right.
// Later decoder types can swap the right pane for a map/image view.

import { Component, For, Show, createSignal, createEffect, onMount, onCleanup } from 'solid-js';
import { store } from '../store/index.js';
import { engine } from '../engine/sdr-engine.js';
import AdsbDisplay from './AdsbDisplay.js';
import AcarsDisplay from './AcarsDisplay.js';
import AisDisplay from './AisDisplay.js';
import Vdl2Display from './Vdl2Display.js';

const DECODERS = [
  { id: 'ft8', label: 'FT8' },
  { id: 'ft4', label: 'FT4' },
  { id: 'ft2', label: 'FT2' },
  { id: 'adsb', label: 'ADS-B' },
  { id: 'acars', label: 'ACARS' },
  { id: 'ais', label: 'AIS' },
  { id: 'vdl2', label: 'VDL2' },
] as const;

const MAX_ROWS = 160;
const MAX_FRAMES = 160;

function formatHz(hz: unknown): string {
  const value = typeof hz === 'number' ? hz : Number(hz);
  if (!Number.isFinite(value)) return '';
  return `${(value / 1e6).toFixed(6)}`;
}

const DecoderDisplay: Component = () => {
  let canvasRef: HTMLCanvasElement | undefined;
  let history: Float32Array[] = [];
  let lastFrame: Float32Array | null = null;
  let lastTune = 0;
  let lastRate = 0;
  const [hasSignal, setHasSignal] = createSignal(false);
  const [frameCount, setFrameCount] = createSignal(0);

  const isAdsb = () => store.decoderMode() === 'adsb';
  const isAcars = () => store.decoderMode() === 'acars';
  const isAis = () => store.decoderMode() === 'ais';
  const isVdl2 = () => store.decoderMode() === 'vdl2';

  const clearZoom = () => {
    history = [];
    lastFrame = null;
    setHasSignal(false);
    setFrameCount(0);
  };

  createEffect(() => {
    const tune = store.tunedFrequency();
    const rate = store.sampleRate();
    const mode = store.decoderMode();
    if (tune !== lastTune || rate !== lastRate || mode === '') {
      lastTune = tune;
      lastRate = rate;
      clearZoom();
    }
  });

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
    if (history.length === 0) return;

    const sampleRate = store.sampleRate();
    const center = store.centerFrequency();
    const tune = store.tunedFrequency();
    const span = store.decoderMode() === 'ft8' || store.decoderMode() === 'ft4' || store.decoderMode() === 'ft2'
      ? 3_000
      : Math.max(1_000, store.bandwidth());
    const binCount = history[0].length;
    const hzPerBin = sampleRate / binCount;
    const low = tune - span / 2;
    const high = tune + span / 2;
    const startBin = Math.max(0, Math.floor((low - (center - sampleRate / 2)) / hzPerBin));
    const endBin = Math.min(binCount, Math.ceil((high - (center - sampleRate / 2)) / hzPerBin));
    const usable = Math.max(1, endBin - startBin);

    const minDb = store.waterfallMin();
    const maxDb = store.waterfallMax();
    const img = ctx.createImageData(w, h);
    const data = img.data;
    const rows = Math.min(history.length, h);
    for (let y = 0; y < rows; y++) {
      // Newest at the top.
      const frame = history[history.length - 1 - y];
      const row = y * w * 4;
      for (let x = 0; x < w; x++) {
        const bin = startBin + Math.min(usable - 1, Math.floor((x / w) * usable));
        const db = frame[bin] ?? minDb;
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
    ctx.putImageData(img, 0, 0);

    // Centre line at the decoder frequency.
    ctx.strokeStyle = 'rgba(255,252,98,0.65)';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    const centreX = ((tune - low) / span) * w;
    ctx.moveTo(centreX, 0);
    ctx.lineTo(centreX, h);
    ctx.stroke();
  };

  onMount(() => {
    const poll = window.setInterval(() => {
      if (isAdsb() || isAcars() || isAis() || isVdl2()) return;
      const frame = engine.getLatestFftFrame();
      if (!frame || frame === lastFrame) return;
      lastFrame = frame;
      history.push(new Float32Array(frame));
      if (history.length > MAX_FRAMES) history.shift();
      setHasSignal(true);
      setFrameCount((n) => n + 1);
      if (canvasRef) draw();
    }, 100);
    onCleanup(() => clearInterval(poll));
  });

  const select = (id: string) => {
    clearZoom();
    engine.setDecoder(store.decoderMode() === id ? '' : id);
  };

  return (
    <div class="flex flex-col h-full min-h-0 bg-sdr-surface/30">
      <div class="flex items-center gap-2 px-2 py-1 border-b border-border/40 shrink-0">
        <span class="text-[8px] font-mono uppercase tracking-wider text-text-dim">Digital Decoder</span>
        <For each={DECODERS}>
          {(decoder) => (
            <button
              onClick={() => select(decoder.id)}
              class={`mil-btn text-[9px] px-2 py-0.5 ${
                store.decoderMode() === decoder.id ? 'active border-cyan text-cyan' : ''
              }`}
            >
              {decoder.label}
            </button>
          )}
        </For>
        <Show when={store.decoderMode()}>
          <button
            onClick={() => { clearZoom(); engine.setDecoder(''); }}
            class="text-[8px] font-mono uppercase tracking-wider text-text-dim hover:text-amber ml-auto"
          >
            Off
          </button>
        </Show>
      </div>

      <Show when={!isAdsb() && !isAcars() && !isAis() && !isVdl2()}>
      <div class="flex-1 min-h-0 flex flex-col md:flex-row">
        {/* Decode table */}
        <div class="flex-1 min-w-0 min-h-0 overflow-auto border-b md:border-b-0 md:border-r border-border/40">
          <table class="w-full text-[8px] font-mono">
            <thead class="sticky top-0 z-10 bg-sdr-surface text-text-dim">
              <tr>
                <th class="text-left px-2 py-1">TIME</th>
                <th class="text-left px-2 py-1">MESSAGE</th>
                <th class="text-right px-2 py-1">FREQ</th>
                <th class="text-right px-2 py-1">SNR</th>
              </tr>
            </thead>
            <tbody>
              <For each={store.decoderMessages().slice(0, MAX_ROWS)}>
                {(message) => (
                  <tr class="border-t border-border/20">
                    <td class="px-2 py-1 text-text-dim whitespace-nowrap">
                      {new Date(message.receivedAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </td>
                    <td class="px-2 py-1 text-text-primary break-all">
                      {String(message.data.text ?? '')}
                    </td>
                    <td class="px-2 py-1 text-right text-text-secondary whitespace-nowrap">
                      {formatHz(message.data.rfHz)}
                    </td>
                    <td class="px-2 py-1 text-right text-text-dim">
                      {typeof message.data.snrDb === 'number'
                        ? `${Math.round(message.data.snrDb)}`
                        : ''}
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
          <Show when={store.decoderMessages().length === 0}>
            <p class="text-[8px] font-mono text-text-dim px-2 py-3">Waiting for a slot…</p>
          </Show>
        </div>

        {/* Receiver-span waterfall around the decoder frequency */}
        <div class="md:w-[42%] min-h-[160px] md:min-h-0 relative bg-black">
          <canvas ref={(el) => { canvasRef = el; }} class="absolute inset-0 w-full h-full" />
          <div class="absolute top-1 left-1.5 pointer-events-none text-[8px] font-mono text-cyan/80">
            {store.decoderMode().toUpperCase()} · {(store.tunedFrequency() / 1e6).toFixed(6)} MHz
            <span class="text-text-dim/70"> · {frameCount()}f</span>
          </div>
          <Show when={!hasSignal()}>
            <span class="absolute inset-0 flex items-center justify-center text-[8px] font-mono text-text-dim">
              waiting for spectrum…
            </span>
          </Show>
        </div>
      </div>
      </Show>
      <Show when={isAdsb()}>
        <AdsbDisplay />
      </Show>
      <Show when={isAcars()}>
        <AcarsDisplay />
      </Show>
      <Show when={isAis()}>
        <AisDisplay />
      </Show>
      <Show when={isVdl2()}>
        <Vdl2Display />
      </Show>
    </div>
  );
};

export default DecoderDisplay;
