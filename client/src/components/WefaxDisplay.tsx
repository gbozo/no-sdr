// ============================================================
// node-sdr — Weather fax (WEFAX) image workspace
// ============================================================
// The server sends each scan line as base64 grayscale, so the chart appears
// line by line while the transmission is being received. A completed image
// stays on screen until the next start tone begins a new one.

import { Component, Show, createEffect, createMemo } from 'solid-js';
import { store } from '../store/index.js';

const WefaxDisplay: Component = () => {
  let canvasRef: HTMLCanvasElement | undefined;

  const image = createMemo(() => store.wefaxImage());
  const status = createMemo(() => store.wefaxStatus());

  const draw = () => {
    const canvas = canvasRef;
    if (!canvas) return;
    const current = image();
    if (!current || current.width === 0 || current.height === 0) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        canvas.width = 1;
        canvas.height = 1;
        ctx.fillStyle = '#05070b';
        ctx.fillRect(0, 0, 1, 1);
      }
      return;
    }

    canvas.width = current.width;
    canvas.height = current.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const pixels = ctx.createImageData(current.width, current.height);
    const data = pixels.data;
    for (let y = 0; y < current.height; y += 1) {
      const row = current.rows[y];
      const base = y * current.width * 4;
      if (!row) {
        for (let x = 0; x < current.width; x += 1) {
          const p = base + x * 4;
          data[p] = 0;
          data[p + 1] = 0;
          data[p + 2] = 0;
          data[p + 3] = 255;
        }
        continue;
      }
      for (let x = 0; x < current.width; x += 1) {
        const value = row[x] ?? 0;
        const p = base + x * 4;
        data[p] = value;
        data[p + 1] = value;
        data[p + 2] = value;
        data[p + 3] = 255;
      }
    }
    ctx.putImageData(pixels, 0, 0);
  };

  createEffect(() => {
    // Reading the signals here keeps the effect subscribed to line updates.
    image();
    status();
    draw();
  });

  const stateLabel = () => {
    if (!image()) return 'WAITING FOR START TONE';
    if (image()?.complete) return 'COMPLETE';
    if (status().phasing) return 'PHASING';
    return 'RECEIVING';
  };

  return (
    <div class="flex-1 min-h-0 flex flex-col md:flex-row">
      <div class="flex-1 min-w-0 min-h-0 overflow-auto border-b md:border-b-0 md:border-r border-border/40 bg-black">
        <Show
          when={image()}
          fallback={
            <div class="h-full min-h-[180px] flex flex-col items-center justify-center gap-2 px-6 text-center">
              <span class="text-[9px] font-mono uppercase tracking-[0.18em] text-cyan/70">
                Weather facsimile
              </span>
              <p class="text-[10px] font-mono text-text-dim max-w-md leading-relaxed">
                Waiting for a WEFAX start tone. Tune to an HF radiofax schedule
                (7.880 MHz is a common chart frequency) and make sure the decoder
                is centred on the station.
              </p>
              <p class="text-[8px] font-mono text-text-dim/70">
                {status().ioc} · {status().lpm} LPM · subcarrier{' '}
                {status().subcarrierHz.toFixed(0)} Hz
              </p>
            </div>
          }
        >
          {(current) => (
            <div class="min-h-full p-2 flex items-start justify-center">
              <canvas
                ref={canvasRef}
                class="max-w-full h-auto bg-black"
                style={{ 'image-rendering': 'pixelated' }}
              />
              <span class="sr-only">
                WEFAX image {current().imageId}, {current().width} by {current().height}
              </span>
            </div>
          )}
        </Show>
      </div>

      <aside class="md:w-[300px] shrink-0 overflow-auto bg-sdr-surface/20">
        <div class="p-3 space-y-3">
          <div class="flex items-center justify-between">
            <span class="text-[8px] font-mono uppercase tracking-wider text-text-dim">
              WEFAX
            </span>
            <span class={`text-[8px] font-mono uppercase tracking-wider ${
              image()?.complete ? 'text-green-400' : 'text-amber'
            }`}>
              {stateLabel()}
            </span>
          </div>

          <div class="grid grid-cols-2 gap-x-3 gap-y-2 text-[9px] font-mono">
            <Metric label="Image" value={image() ? String(image()!.imageId) : '—'} />
            <Metric label="Lines" value={String(image()?.height ?? 0)} />
            <Metric label="IOC" value={status().ioc} />
            <Metric label="Rate" value={`${status().lpm} LPM`} />
            <Metric
              label="Subcarrier"
              value={`${status().subcarrierHz.toFixed(0)} Hz`}
            />
            <Metric label="Signal" value={`${status().signal.toFixed(2)}`} />
            <Metric label="Slant" value={`${status().slantPpm.toFixed(1)} ppm`} />
            <Metric
              label="Phase"
              value={status().phasing ? 'phasing' : status().receiving ? 'locked' : 'idle'}
            />
          </div>

          <div class="border-t border-border/30 pt-2">
            <div class="text-[8px] font-mono uppercase tracking-wider text-text-dim mb-1">
              Chart
            </div>
            <p class="text-[9px] font-mono text-text-secondary leading-relaxed">
              WEFAX sends a continuous raster. The start tone announces IOC 576/288,
              phasing locates the left edge, and the stop tone ends the chart.
            </p>
          </div>

          <Show when={image()?.complete}>
            <p class="text-[9px] font-mono text-green-400/80">
              Chart complete — waiting for the next start tone.
            </p>
          </Show>
        </div>
      </aside>
    </div>
  );
};

const Metric: Component<{ label: string; value: string }> = (props) => (
  <div>
    <div class="text-[7px] uppercase tracking-wider text-text-dim/70">{props.label}</div>
    <div class="text-[9px] text-text-primary break-all">{props.value}</div>
  </div>
);

export default WefaxDisplay;
