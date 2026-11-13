// ============================================================
// node-sdr — SSTV image workspace
// ============================================================
// The server sends progressive RGB scan lines. The newest picture is shown by
// default; completed pictures stay in a small history strip and can be
// selected without interrupting the live image.

import { Component, For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import { store } from '../store/index.js';
import type { SstvImage } from '~/shared';

const SstvDisplay: Component = () => {
  let canvasRef: HTMLCanvasElement | undefined;
  const [picked, setPicked] = createSignal<number | null>(null);

  const list = createMemo(() => store.sstvImages());
  const image = createMemo(() => {
    const selected = picked();
    return list().find((item) => item.imageId === selected) ?? list()[0] ?? null;
  });
  const status = createMemo(() => store.sstvStatus());

  createEffect(() => {
    const newest = list()[0]?.imageId ?? null;
    if (newest !== null && picked() === null) return;
    if (picked() !== null && !list().some((item) => item.imageId === picked())) {
      setPicked(null);
    }
  });

  // A new transmission should come to the front; a history pick should not.
  let lastNewest: number | null = null;
  createEffect(() => {
    const newest = list()[0]?.imageId ?? null;
    if (newest !== lastNewest) {
      lastNewest = newest;
      setPicked(null);
    }
  });

  const draw = () => {
    const canvas = canvasRef;
    if (!canvas) return;
    const current = image();
    if (!current || current.width === 0 || current.height === 0) {
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d');
      if (ctx) {
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
        const p = base + x * 4;
        const s = x * 3;
        data[p] = row[s] ?? 0;
        data[p + 1] = row[s + 1] ?? 0;
        data[p + 2] = row[s + 2] ?? 0;
        data[p + 3] = 255;
      }
    }
    ctx.putImageData(pixels, 0, 0);
  };

  createEffect(() => {
    image();
    status();
    draw();
  });

  const stateLabel = () => {
    if (status().unsupported) return 'UNSUPPORTED MODE';
    if (!image()) return 'WAITING FOR VIS';
    if (image()!.complete) return 'COMPLETE';
    if (status().receiving) return 'RECEIVING';
    return 'WAITING';
  };

  return (
    <div class="flex-1 min-h-0 flex flex-col md:flex-row">
      <div class="flex-1 min-w-0 min-h-0 overflow-auto border-b md:border-b-0 md:border-r border-border/40 bg-black">
        <Show
          when={image()}
          fallback={
            <div class="h-full min-h-[180px] flex flex-col items-center justify-center gap-2 px-6 text-center">
              <span class="text-[9px] font-mono uppercase tracking-[0.18em] text-cyan/70">
                Slow-scan television
              </span>
              <p class="text-[10px] font-mono text-text-dim max-w-md leading-relaxed">
                Waiting for an SSTV VIS header. Tune to a known SSTV frequency
                (14.230 MHz is the common HF calling frequency) and centre the
                decoder on the station.
              </p>
              <p class="text-[8px] font-mono text-text-dim/70">
                {status().mode ?? 'auto-detect'} · signal {status().signal.toFixed(2)}
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
                SSTV image {current().imageId}, {current().width} by {current().height}
              </span>
            </div>
          )}
        </Show>
      </div>

      <aside class="md:w-[320px] shrink-0 overflow-auto bg-sdr-surface/20">
        <div class="p-3 space-y-3">
          <div class="flex items-center justify-between">
            <span class="text-[8px] font-mono uppercase tracking-wider text-text-dim">SSTV</span>
            <span class={`text-[8px] font-mono uppercase tracking-wider ${
              status().unsupported ? 'text-amber' : image()?.complete ? 'text-green-400' : 'text-amber'
            }`}>
              {stateLabel()}
            </span>
          </div>

          <Show when={status().unsupported}>
            <p class="text-[9px] font-mono text-amber/90 border border-amber/30 bg-amber/5 rounded-sm p-2 leading-relaxed">
              Received a valid header for {status().unsupported}, which this
              decoder cannot draw.
            </p>
          </Show>

          <div class="grid grid-cols-2 gap-x-3 gap-y-2 text-[9px] font-mono">
            <Metric label="Image" value={image() ? String(image()!.imageId) : '—'} />
            <Metric label="Mode" value={image()?.mode ?? status().mode ?? '—'} />
            <Metric label="Size" value={image() ? `${image()!.width}×${image()!.height}` : '—'} />
            <Metric label="Progress" value={`${Math.round((image()?.complete ? 1 : status().progress) * 100)}%`} />
            <Metric label="Signal" value={status().signal.toFixed(2)} />
            <Metric label="Callsign" value={image()?.callsign ?? status().callsign ?? '—'} />
          </div>

          <Show when={list().length > 0}>
            <div class="border-t border-border/30 pt-2">
              <div class="text-[8px] font-mono uppercase tracking-wider text-text-dim mb-1">
                Received pictures
              </div>
              <div class="space-y-1">
                <For each={list()}>
                  {(item: SstvImage) => (
                    <button
                      onClick={() => setPicked(item.imageId)}
                      class={`w-full text-left px-2 py-1 rounded-sm border text-[8px] font-mono ${
                        image()?.imageId === item.imageId
                          ? 'border-cyan/50 text-cyan bg-cyan/5'
                          : 'border-border/40 text-text-dim hover:border-cyan/30'
                      }`}
                    >
                      <span class="inline-block w-10">#{item.imageId}</span>
                      <span>{item.mode ?? 'SSTV'}</span>
                      <span class="float-right">{item.complete ? 'complete' : 'live'}</span>
                      <div class="text-[7px] text-text-dim/70 mt-0.5">
                        {item.width}×{item.height}
                        {item.callsign ? ` · ${item.callsign}` : ''}
                      </div>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <div class="border-t border-border/30 pt-2">
            <div class="text-[8px] font-mono uppercase tracking-wider text-text-dim mb-1">
              Picture
            </div>
            <p class="text-[9px] font-mono text-text-secondary leading-relaxed">
              SSTV sends a VIS header, then RGB scan lines at 1500–2300 Hz.
              Pictures stay in local history until the decoder is changed.
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

export default SstvDisplay;
