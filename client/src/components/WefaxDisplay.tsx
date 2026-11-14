// ============================================================
// node-sdr — Weather fax (WEFAX) image workspace
// ============================================================
// The server sends each scan line as base64 grayscale, so the chart appears
// line by line while the transmission is being received. A completed image
// stays on screen until the next start tone begins a new one.

import { Component, For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import { store } from '../store/index.js';
import type { WefaxImage } from '~/shared';

const WefaxDisplay: Component = () => {
  let canvasRef: HTMLCanvasElement | undefined;

  const image = createMemo(() => store.wefaxImage());
  const status = createMemo(() => store.wefaxStatus());
  const [history, setHistory] = createSignal<WefaxImage[]>([]);
  const [picked, setPicked] = createSignal<number | null>(null);
  let lastImageId = 0;

  const displayImage = () => {
    const selected = picked();
    if (selected === null) return image();
    return history().find((item) => item.imageId === selected) ?? image();
  };

  // Keep completed charts so the operator can look back at earlier images
  // while a new transmission is being received.
  createEffect(() => {
    const current = image();
    const id = current?.imageId ?? 0;
    if (id !== lastImageId) {
      lastImageId = id;
      setPicked(null);
    }
    if (!current?.complete || current.rows.length === 0) return;
    setHistory((previous) => {
      if (previous.some((item) => item.imageId === current.imageId)) return previous;
      return [current, ...previous].slice(0, 6);
    });
  });

  const draw = () => {
    const canvas = canvasRef;
    if (!canvas) return;
    const current = displayImage();
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
    displayImage();
    status();
    draw();
  });

  const subcarrierValid = () => {
    const hz = status().subcarrierHz;
    return hz >= 1400 && hz <= 2400;
  };

  const stateLabel = () => {
    if (status().receiving && !subcarrierValid()) return 'NO WEFAX SUBCARRIER';
    if (!displayImage()) return 'WAITING FOR START TONE';
    if (displayImage()?.complete) return 'COMPLETE';
    if (status().phasing) return 'PHASING';
    return 'RECEIVING';
  };

  return (
    <div class="flex-1 min-h-0 flex flex-col md:flex-row">
      <div class="flex-1 min-w-0 min-h-[180px] overflow-auto border-b md:border-b-0 md:border-r border-border/40 bg-black">
        <Show
          when={displayImage()}
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

      <aside class="md:w-[300px] shrink-0 overflow-auto max-h-[45vh] md:max-h-none bg-sdr-surface/20">
        <div class="p-3 space-y-3">
          <div class="flex items-center justify-between">
            <span class="text-[8px] font-mono uppercase tracking-wider text-text-dim">
              WEFAX
            </span>
            <span class={`text-[8px] font-mono uppercase tracking-wider ${
              status().receiving && !subcarrierValid()
                ? 'text-red-400'
                : displayImage()?.complete ? 'text-green-400' : 'text-amber'
            }`}>
              {stateLabel()}
            </span>
          </div>

          <Show when={status().receiving && !subcarrierValid()}>
            <div class="text-[8px] font-mono text-red-400 border border-red-400/30 bg-red-400/5 rounded-sm px-2 py-1.5 leading-relaxed">
              Subcarrier {status().subcarrierHz.toFixed(0)} Hz is outside the
              WEFAX 1500–2300 Hz band. This is probably not a WEFAX signal —
              check the tuning and the published chart frequency.
            </div>
          </Show>

          <div class="grid grid-cols-2 gap-x-3 gap-y-2 text-[9px] font-mono">
            <Metric label="Image" value={displayImage() ? String(displayImage()!.imageId) : '—'} />
            <Metric label="Lines" value={String(displayImage()?.height ?? 0)} />
            <Metric label="Rows" value={String(displayImage()?.rows.length ?? 0)} />
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

          <Show when={history().length > 0}>
            <div class="border-t border-border/30 pt-2">
              <div class="text-[8px] font-mono uppercase tracking-wider text-text-dim mb-1">
                Recent charts
              </div>
              <div class="flex flex-wrap gap-1">
                <button
                  onClick={() => setPicked(null)}
                  class={`px-1.5 py-0.5 rounded-sm border text-[8px] font-mono ${
                    picked() === null
                      ? 'border-cyan/60 text-cyan'
                      : 'border-border/40 text-text-dim hover:text-text-secondary'
                  }`}
                >
                  Live
                </button>
                <For each={history()}>
                  {(item) => (
                    <button
                      onClick={() => setPicked(item.imageId)}
                      class={`px-1.5 py-0.5 rounded-sm border text-[8px] font-mono tabular-nums ${
                        picked() === item.imageId
                          ? 'border-cyan/60 text-cyan'
                          : 'border-border/40 text-text-dim hover:text-text-secondary'
                      }`}
                      title={`${item.height} lines, ${item.ioc}`}
                    >
                      #{item.imageId}
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <Show when={displayImage()?.complete}>
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
