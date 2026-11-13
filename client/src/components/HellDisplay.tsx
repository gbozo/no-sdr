// ============================================================
// node-sdr — Hellschreiber dot-raster workspace
// ============================================================
// Hell has no character decoder: the server sends whole 14-pixel columns and
// this panel paints them as a scrolling facsimile strip.

import { Component, Show, createEffect, createMemo } from 'solid-js';
import { store } from '../store/index.js';

const VISIBLE_COLUMNS = 600;
const COLUMN_WIDTH = 2;
const ROW_HEIGHT = 6;

const HellDisplay: Component = () => {
  let canvasRef: HTMLCanvasElement | undefined;

  const columns = createMemo(() => store.hellColumns());
  const status = createMemo(() => store.hellStatus());

  const draw = () => {
    const canvas = canvasRef;
    if (!canvas) return;
    const all = columns();
    const visible = all.slice(-VISIBLE_COLUMNS);
    const rows = visible[0]?.length ?? 14;
    canvas.width = VISIBLE_COLUMNS * COLUMN_WIDTH;
    canvas.height = rows * ROW_HEIGHT;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#05070b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (visible.length === 0) return;

    const image = ctx.createImageData(canvas.width, canvas.height);
    const data = image.data;
    for (let y = 0; y < canvas.height; y += 1) {
      data.fill(0, y * canvas.width * 4, (y + 1) * canvas.width * 4);
      for (let x = 0; x < canvas.width; x += 1) {
        data[(y * canvas.width + x) * 4 + 3] = 255;
      }
    }
    for (let col = 0; col < visible.length; col += 1) {
      const pixels = visible[col];
      for (let row = 0; row < Math.min(rows, pixels.length); row += 1) {
        const shade = pixels[row];
        for (let dx = 0; dx < COLUMN_WIDTH; dx += 1) {
          for (let dy = 0; dy < ROW_HEIGHT; dy += 1) {
            const px = col * COLUMN_WIDTH + dx;
            const py = row * ROW_HEIGHT + dy;
            const at = (py * canvas.width + px) * 4;
            data[at] = shade;
            data[at + 1] = shade;
            data[at + 2] = shade;
            data[at + 3] = 255;
          }
        }
      }
    }
    ctx.putImageData(image, 0, 0);
  };

  createEffect(() => {
    columns();
    status();
    draw();
  });

  return (
    <div class="flex-1 min-h-0 flex flex-col md:flex-row">
      <div class="flex-1 min-w-0 min-h-0 overflow-auto border-b md:border-b-0 md:border-r border-border/40 bg-black">
        <Show
          when={columns().length > 0}
          fallback={
            <div class="h-full min-h-[180px] flex flex-col items-center justify-center gap-2 px-6 text-center">
              <span class="text-[9px] font-mono uppercase tracking-[0.18em] text-cyan/70">
                Hellschreiber
              </span>
              <p class="text-[10px] font-mono text-text-dim max-w-md leading-relaxed">
                Waiting for Hell dots. Tune to a Hell calling frequency such as
                7.040 MHz and centre the decoder on the station. The picture is
                read by eye; there is no character decoder.
              </p>
              <p class="text-[8px] font-mono text-text-dim/70">
                {status().variant} · signal {status().level.toFixed(2)}
              </p>
            </div>
          }
        >
          <div class="min-h-full p-2 flex items-start justify-center">
            <canvas
              ref={canvasRef}
              class="w-full max-w-full h-auto bg-black"
              style={{ 'image-rendering': 'pixelated' }}
            />
          </div>
        </Show>
      </div>

      <aside class="md:w-[300px] shrink-0 overflow-auto bg-sdr-surface/20">
        <div class="p-3 space-y-3">
          <div class="flex items-center justify-between">
            <span class="text-[8px] font-mono uppercase tracking-wider text-text-dim">
              HELLSCHREIBER
            </span>
            <span class="text-[8px] font-mono uppercase tracking-wider text-amber">
              {status().receiving ? 'RECEIVING' : 'WAITING'}
            </span>
          </div>

          <div class="grid grid-cols-2 gap-x-3 gap-y-2 text-[9px] font-mono">
            <Metric label="Variant" value={status().variant} />
            <Metric label="Columns" value={String(status().columns)} />
            <Metric label="Signal" value={status().level.toFixed(2)} />
            <Metric label="Audio" value={`${status().audioHz.toFixed(0)} Hz`} />
          </div>

          <div class="border-t border-border/30 pt-2">
            <div class="text-[8px] font-mono uppercase tracking-wider text-text-dim mb-1">
              Raster
            </div>
            <p class="text-[9px] font-mono text-text-secondary leading-relaxed">
              Each column is scanned top to bottom at the sending station's dot
              rate. Vertical phase is free-running, so the strip scrolls sideways;
              spacing and glyph shape are the tuning indicators.
            </p>
          </div>
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

export default HellDisplay;
