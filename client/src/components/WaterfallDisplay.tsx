// ============================================================
// node-sdr — Waterfall + Spectrum Component
// ============================================================

import { Component, onMount, onCleanup, Show, createSignal, For } from 'solid-js';
import { engine } from '../engine/sdr-engine.js';
import { store } from '../store/index.js';

const WaterfallDisplay: Component = () => {
  let waterfallRef!: HTMLCanvasElement;
  let spectrumRef!: HTMLCanvasElement;
  let containerRef!: HTMLDivElement;

  // Tooltip state
  const [hoverFreq, setHoverFreq] = createSignal<string | null>(null);
  const [hoverDb,   setHoverDb]   = createSignal<string | null>(null);
  const [cursorX,   setCursorX]   = createSignal(0);
  const [cursorY,   setCursorY]   = createSignal(0);

  // Zoom drag state
  const [dragStart, setDragStart] = createSignal<number | null>(null);
  const [dragEnd,   setDragEnd]   = createSignal<number | null>(null);
  const [isDragging, setIsDragging] = createSignal(false);

  onMount(() => {
    engine.attachCanvases(waterfallRef, spectrumRef);
    const observer = new ResizeObserver(() => engine.handleResize());
    observer.observe(containerRef);
    requestAnimationFrame(() => engine.handleResize());
    onCleanup(() => observer.disconnect());
  });

  // Convert canvas-relative X fraction to absolute Hz, zoom-aware
  const xFracToHz = (relX: number): number => {
    const [zs, ze] = store.spectrumZoom();
    const bandFrac = zs + relX * (ze - zs);
    return store.centerFrequency() + (bandFrac - 0.5) * store.sampleRate();
  };

  const freqFromEvent = (e: MouseEvent): string => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const hz = xFracToHz((e.clientX - rect.left) / rect.width);
    const mhz = hz / 1e6;
    if (mhz >= 1000) return `${(mhz / 1000).toFixed(4)} GHz`;
    if (mhz >= 1)    return `${mhz.toFixed(4)} MHz`;
    return `${(hz / 1000).toFixed(2)} kHz`;
  };

  const dbFromEvent = (e: MouseEvent): string | null => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const canvasX = Math.round((e.clientX - rect.left) * dpr);
    const db = engine.getSpectrumDbAtPixel(canvasX);
    return db !== null ? `${db.toFixed(1)} dB` : null;
  };

  // ---- Drag-to-zoom handlers (spectrum only) ----

  const spectrumRelX = (e: MouseEvent): number => {
    const rect = spectrumRef.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  };

  const handleSpectrumMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rx = spectrumRelX(e);
    setDragStart(rx);
    setDragEnd(rx);
    setIsDragging(true);
  };

  const handleSpectrumMouseMove = (e: MouseEvent) => {
    setCursorX(e.clientX);
    setCursorY(e.clientY);
    setHoverFreq(freqFromEvent(e));
    setHoverDb(dbFromEvent(e));
    if (isDragging()) {
      setDragEnd(spectrumRelX(e));
    }
  };

  const handleSpectrumMouseUp = (e: MouseEvent) => {
    if (!isDragging()) return;
    setIsDragging(false);
    const ds = dragStart()!;
    const de = spectrumRelX(e);
    const lo = Math.min(ds, de);
    const hi = Math.max(ds, de);
    // Only zoom if drag covers >1% of viewport — otherwise treat as click
    if (hi - lo > 0.01) {
      const [zs, ze] = store.spectrumZoom();
      const span = ze - zs;
      engine.setSpectrumZoom(zs + lo * span, zs + hi * span);
    } else {
      // Treat as click-to-tune
      const rect = spectrumRef.getBoundingClientRect();
      const relX = (e.clientX - rect.left) / rect.width;
      const hz = xFracToHz(relX);
      engine.tune(Math.round(hz - store.centerFrequency()));
    }
    setDragStart(null);
    setDragEnd(null);
  };

  const handleSpectrumDblClick = () => {
    engine.resetSpectrumZoom();
  };

  const handleMouseLeave = () => {
    setHoverFreq(null);
    setHoverDb(null);
    if (isDragging()) {
      setIsDragging(false);
      setDragStart(null);
      setDragEnd(null);
    }
  };

  const handleWaterfallClick = (e: MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const hz = xFracToHz(relX);
    engine.tune(Math.round(hz - store.centerFrequency()));
  };

  const handleWaterfallMouseMove = (e: MouseEvent) => {
    setCursorX(e.clientX);
    setCursorY(e.clientY);
    setHoverFreq(freqFromEvent(e));
    setHoverDb(null);
  };

  // Shared button style
  const btnClass = (active: boolean) =>
    `absolute z-10 w-6 h-6 flex items-center justify-center rounded-sm border transition-colors
     ${active
       ? 'border-[var(--sdr-accent)] text-[var(--sdr-accent)]'
       : 'border-border text-text-muted hover:text-text-dim hover:border-border-active'}`;

  const AVG_STEPS: Array<'fast' | 'med' | 'slow'> = ['fast', 'med', 'slow'];
  const nextAvg = () => {
    const cur = store.spectrumAveraging();
    engine.setSpectrumAveraging(AVG_STEPS[(AVG_STEPS.indexOf(cur) + 1) % 3]);
  };

  // Drag overlay rect in CSS percent of spectrum width
  const dragRect = () => {
    const ds = dragStart(), de = dragEnd();
    if (ds === null || de === null || !isDragging()) return null;
    const lo = Math.min(ds, de), hi = Math.max(ds, de);
    return { left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` };
  };

  return (
    <div ref={containerRef!} class="flex flex-col flex-1 min-h-0 relative">

      {/* Frequency + dB tooltip */}
      <Show when={hoverFreq() !== null}>
        <div
          class="fixed z-50 pointer-events-none
                 px-2 py-0.5 rounded
                 bg-black/80 border border-white/10
                 text-[10px] font-mono text-white/90
                 whitespace-nowrap flex items-center gap-2"
          style={{ left: `${cursorX() + 14}px`, top: `${cursorY() - 10}px` }}
        >
          <span>{hoverFreq()}</span>
          <Show when={hoverDb() !== null}>
            <span class="text-white/50">·</span>
            <span class="text-[var(--sdr-accent)]">{hoverDb()}</span>
          </Show>
        </div>
      </Show>

      {/* Spectrum */}
      <div class="relative h-[180px] min-h-[120px] border-b border-border">
        <canvas
          ref={spectrumRef!}
          class={`absolute inset-0 w-full h-full ${isDragging() ? 'cursor-col-resize' : 'cursor-crosshair'}`}
          onMouseDown={handleSpectrumMouseDown}
          onMouseMove={handleSpectrumMouseMove}
          onMouseUp={handleSpectrumMouseUp}
          onMouseLeave={handleMouseLeave}
          onDblClick={handleSpectrumDblClick}
        />

        {/* Zoom drag selection overlay */}
        <Show when={dragRect() !== null}>
          <div
            class="absolute top-0 bottom-0 pointer-events-none z-20
                   bg-[var(--sdr-accent)]/10 border-x border-[var(--sdr-accent)]/40"
            style={dragRect()!}
          />
        </Show>

        {/* Zoom reset indicator */}
        <Show when={store.spectrumZoom()[0] > 0 || store.spectrumZoom()[1] < 1}>
          <button
            class="absolute top-1.5 right-2 z-10 px-1.5 h-5
                   flex items-center text-[8px] font-mono rounded-sm
                   border border-[var(--sdr-accent)] text-[var(--sdr-accent)]
                   hover:bg-[var(--sdr-accent)]/10 transition-colors"
            title="Reset zoom (double-click spectrum)"
            onClick={() => engine.resetSpectrumZoom()}
          >
            ×zoom
          </button>
        </Show>

        {/* Peak hold */}
        <button class={btnClass(store.spectrumPeakHold())}
          style={{ top: '6px', left: '12px' }} title="Peak hold"
          onClick={() => engine.setSpectrumPeakHold(!store.spectrumPeakHold())}>
          <svg viewBox="0 0 14 10" fill="none" class="w-3.5 h-2.5">
            <polyline points="0,9 3,5 5,7 7,2 9,6 11,4 14,9"
              stroke="currentColor" stroke-width="1.2"
              stroke-linejoin="round" stroke-linecap="round"/>
            <line x1="0" y1="1" x2="14" y2="1"
              stroke="currentColor" stroke-width="1"
              stroke-dasharray="2 1.5" opacity="0.7"/>
          </svg>
        </button>

        {/* Signal fill */}
        <button class={btnClass(store.spectrumSignalFill())}
          style={{ top: '6px', left: '44px' }} title="Signal fill"
          onClick={() => engine.setSpectrumSignalFill(!store.spectrumSignalFill())}>
          <svg viewBox="0 0 14 10" fill="none" class="w-3.5 h-2.5">
            <rect x="0"    y="5"   width="2.5" height="5"   fill="currentColor" opacity="0.8" rx="0.3"/>
            <rect x="3.5"  y="2"   width="2.5" height="8"   fill="currentColor" opacity="0.8" rx="0.3"/>
            <rect x="7"    y="3.5" width="2.5" height="6.5" fill="currentColor" opacity="0.8" rx="0.3"/>
            <rect x="10.5" y="1"   width="2.5" height="9"   fill="currentColor" opacity="0.8" rx="0.3"/>
          </svg>
        </button>

        {/* Pause */}
        <button class={btnClass(store.spectrumPaused())}
          style={{ top: '6px', left: '76px' }}
          title={store.spectrumPaused() ? 'Resume' : 'Freeze spectrum'}
          onClick={() => engine.setSpectrumPaused(!store.spectrumPaused())}>
          <svg viewBox="0 0 14 14" fill="none" class="w-3.5 h-3.5">
            <rect x="2"   y="2" width="3.5" height="10" rx="0.8" fill="currentColor"/>
            <rect x="8.5" y="2" width="3.5" height="10" rx="0.8" fill="currentColor"/>
          </svg>
        </button>

        {/* Averaging */}
        <button class={btnClass(store.spectrumAveraging() !== 'fast')}
          style={{ top: '6px', left: '108px' }}
          title={`Averaging: ${store.spectrumAveraging()} — click to cycle`}
          onClick={nextAvg}>
          <span class="text-[9px] font-mono font-bold leading-none">
            {store.spectrumAveraging()[0].toUpperCase()}
          </span>
        </button>

        {/* Noise floor */}
        <button class={btnClass(store.spectrumNoiseFloor())}
          style={{ top: '6px', left: '140px' }} title="Noise floor"
          onClick={() => engine.setSpectrumNoiseFloor(!store.spectrumNoiseFloor())}>
          <svg viewBox="0 0 14 10" fill="none" class="w-3.5 h-2.5">
            {/* Noisy line near bottom */}
            <polyline points="0,7 2,8 4,6.5 6,7.5 8,6 10,7 12,6.5 14,7"
              stroke="currentColor" stroke-width="1.2"
              stroke-linecap="round" stroke-linejoin="round"/>
            {/* Dashed floor line */}
            <line x1="0" y1="9" x2="14" y2="9"
              stroke="currentColor" stroke-width="1"
              stroke-dasharray="2 1.5" opacity="0.6"/>
          </svg>
        </button>

        <FrequencyScale />
      </div>

      {/* Waterfall */}
      <div class="relative flex-1 min-h-0">
        <canvas
          ref={waterfallRef!}
          class="absolute inset-0 w-full h-full cursor-crosshair"
          style={{ "image-rendering": "crisp-edges" }}
          onClick={handleWaterfallClick}
          onMouseMove={handleWaterfallMouseMove}
          onMouseLeave={handleMouseLeave}
        />
        <div class="sdr-scanlines" />
        <RdsOverlay />
      </div>
    </div>
  );
};

// Frequency scale — zoom-aware, with signal markers
const FrequencyScale: Component = () => {
  const formatFreq = (hz: number): string => {
    const mhz = hz / 1e6;
    if (mhz >= 1000) return `${(mhz / 1000).toFixed(3)} G`;
    if (mhz >= 1) return `${mhz.toFixed(3)}`;
    return `${(hz / 1000).toFixed(1)} k`;
  };

  // Derive 5 label frequencies across the current zoom viewport
  const viewHz = () => {
    const [zs, ze] = store.spectrumZoom();
    const sr = store.sampleRate();
    const cf = store.centerFrequency();
    const lo = cf + (zs - 0.5) * sr;
    const hi = cf + (ze - 0.5) * sr;
    const span = hi - lo;
    return [lo, lo + span * 0.25, lo + span * 0.5, lo + span * 0.75, hi];
  };

  // Signal markers visible within zoom viewport
  const visibleMarkers = () => {
    const [zs, ze] = store.spectrumZoom();
    const sr = store.sampleRate();
    const cf = store.centerFrequency();
    const loHz = cf + (zs - 0.5) * sr;
    const hiHz = cf + (ze - 0.5) * sr;
    return store.signalMarkers()
      .filter(hz => hz >= loHz && hz <= hiHz)
      .map(hz => ({
        hz,
        pct: ((hz - loHz) / (hiHz - loHz)) * 100,
      }));
  };

  return (
    <div class="absolute bottom-0 left-0 right-0 h-5 flex items-center
                bg-sdr-base/80 border-t border-border/50 pointer-events-none">
      <div class="relative flex justify-between w-full px-1 text-[8px] font-mono text-text-dim">
        <For each={viewHz()}>
          {(hz, i) => (
            <span class={i() === 2 ? 'text-text-secondary' : ''}>{formatFreq(hz)}</span>
          )}
        </For>
        {/* Signal marker ticks */}
        <For each={visibleMarkers()}>
          {(m) => (
            <div
              class="absolute top-0 bottom-0 w-px bg-amber opacity-70"
              style={{ left: `${m.pct}%` }}
              title={formatFreq(m.hz)}
            />
          )}
        </For>
      </div>
    </div>
  );
};

// RDS data overlay — shown in WFM mode when RDS data is available
const RdsOverlay: Component = () => {
  const isWfm = () => store.mode() === 'wfm';
  const hasData = () => store.rdsPs() || store.rdsRt();
  const synced = () => store.rdsSynced();

  return (
    <Show when={isWfm()}>
      <div class="absolute bottom-2 left-2 pointer-events-none z-10
                  bg-black/40 border border-white/10 rounded px-2 py-1.5
                  max-w-[340px] flex items-start gap-2">
        <div class={`text-[11px] font-bold font-mono leading-none mt-px select-none shrink-0
                     ${synced() ? 'text-white opacity-90' : 'text-text-muted opacity-40'}`}
             style={{ "letter-spacing": "0.5px" }}>
          RDS
        </div>
        <Show when={hasData() || synced()}>
          <div class="min-w-0">
            <Show when={store.rdsPs()}>
              <div class="text-[13px] font-mono font-bold text-white tracking-wider leading-tight">
                {store.rdsPs()}
              </div>
            </Show>
            <Show when={store.rdsRt()}>
              <div class="text-[9px] font-mono text-white/80 leading-tight mt-0.5 truncate">
                {store.rdsRt()}
              </div>
            </Show>
            <Show when={store.rdsPty() || store.rdsPi() || synced()}>
              <div class="text-[7px] font-mono text-white/60 mt-0.5 flex gap-2">
                <Show when={store.rdsPty()}>
                  <span>{store.rdsPty()}</span>
                </Show>
                <Show when={store.rdsPi()}>
                  <span class="opacity-70">PI:{store.rdsPi()}</span>
                </Show>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
};

export default WaterfallDisplay;
