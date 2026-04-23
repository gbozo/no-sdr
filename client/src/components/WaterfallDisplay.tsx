// ============================================================
// node-sdr — Waterfall + Spectrum Component
// ============================================================

import { Component, onMount, onCleanup, Show, createSignal, For, createEffect } from 'solid-js';
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

  // Zoom drag state (range select mode)
  const [dragStart,  setDragStart]  = createSignal<number | null>(null);
  const [dragEnd,    setDragEnd]    = createSignal<number | null>(null);
  const [isDragging, setIsDragging] = createSignal(false);

  // Pan drag state (middle-click or Shift+left-click)
  const [panAnchor, setPanAnchor] = createSignal<number | null>(null);

  // Seek-back scrub
  const [seekOffset, setSeekOffset] = createSignal(0);
  const [bufferCount, setBufferCount] = createSignal(0); // viewport fraction at drag start

  onMount(() => {
    engine.attachCanvases(waterfallRef, spectrumRef);
    const observer = new ResizeObserver(() => engine.handleResize());
    observer.observe(containerRef);
    requestAnimationFrame(() => engine.handleResize());

    // Poll buffer count so the scrub range max stays current
    const bufferPoll = setInterval(() => setBufferCount(engine.fftBufferCount), 500);

    onCleanup(() => {
      observer.disconnect();
      clearInterval(bufferPoll);
    });
  });

  // Apply seek when offset changes
  createEffect(() => {
    engine.seekTo(seekOffset());
  });

  // ---- Frequency helpers ----

  const xFracToHz = (relX: number): number => {
    const [zs, ze] = store.spectrumZoom();
    return store.centerFrequency() + (zs + relX * (ze - zs) - 0.5) * store.sampleRate();
  };

  const freqFromEvent = (e: MouseEvent): string => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const hz   = xFracToHz((e.clientX - rect.left) / rect.width);
    const mhz  = hz / 1e6;
    if (mhz >= 1000) return `${(mhz / 1000).toFixed(4)} GHz`;
    if (mhz >= 1)    return `${mhz.toFixed(4)} MHz`;
    return `${(hz / 1000).toFixed(2)} kHz`;
  };

  const dbFromEvent = (e: MouseEvent): string | null => {
    const rect   = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const dpr    = window.devicePixelRatio || 1;
    const canvasX = Math.round((e.clientX - rect.left) * dpr);
    const db = engine.getSpectrumDbAtPixel(canvasX);
    return db !== null ? `${db.toFixed(1)} dB` : null;
  };

  // ---- Pan helper ----
  // Shift the zoom viewport by `delta` (fraction of full band), clamped to [0,1]
  const pan = (delta: number) => {
    const [zs, ze] = store.spectrumZoom();
    const span = ze - zs;
    let ns = zs + delta, ne = ze + delta;
    if (ns < 0) { ns = 0; ne = span; }
    if (ne > 1) { ne = 1; ns = 1 - span; }
    engine.setSpectrumZoom(ns, ne);
  };

  // ---- Spectrum mouse handlers ----

  const spectrumRelX = (e: MouseEvent): number =>
    Math.max(0, Math.min(1, (e.clientX - spectrumRef.getBoundingClientRect().left) / spectrumRef.getBoundingClientRect().width));

  const handleSpectrumMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    const rx = spectrumRelX(e);
    // Middle-click or Shift+left-click → pan
    if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
      setPanAnchor(rx);
      return;
    }
    // Left-click + range select → zoom drag
    if (e.button === 0 && store.spectrumRangeSelect()) {
      setDragStart(rx);
      setDragEnd(rx);
      setIsDragging(true);
    }
  };

  const handleSpectrumMouseMove = (e: MouseEvent) => {
    setCursorX(e.clientX);
    setCursorY(e.clientY);
    setHoverFreq(freqFromEvent(e));
    setHoverDb(dbFromEvent(e));
    if (isDragging()) {
      setDragEnd(spectrumRelX(e));
    } else if (panAnchor() !== null) {
      const rx = spectrumRelX(e);
      const [zs, ze] = store.spectrumZoom();
      const span = ze - zs;
      // Pan by the fraction moved (in viewport space → band space)
      pan((panAnchor()! - rx) * span);
      setPanAnchor(rx); // update anchor so pan is incremental
    }
  };

  const handleSpectrumMouseUp = async (e: MouseEvent) => {
    // End pan
    if (panAnchor() !== null) {
      setPanAnchor(null);
      return;
    }
    if (isDragging()) {
      // Range-select drag → zoom
      setIsDragging(false);
      const ds = dragStart()!;
      const de = spectrumRelX(e);
      const lo = Math.min(ds, de);
      const hi = Math.max(ds, de);
      if (hi - lo > 0.01) {
        const [zs, ze] = store.spectrumZoom();
        const span = ze - zs;
        engine.setSpectrumZoom(zs + lo * span, zs + hi * span);
      }
      setDragStart(null);
      setDragEnd(null);
    } else if (e.button === 0 && !e.shiftKey) {
      // Plain click-to-tune
      const rect = spectrumRef.getBoundingClientRect();
      engine.tune(Math.round(xFracToHz((e.clientX - rect.left) / rect.width) - store.centerFrequency()));

      // Spectrum click = intent to listen — start audio if not yet running
      if (!engine.isAudioInitialized) {
        await engine.initAudio();
        store.setAudioStarted(true);
      }
    }
  };

  // Mouse wheel on spectrum — zoom (vertical) or pan (Shift+wheel or horizontal)
  const handleSpectrumWheel = (e: WheelEvent) => {
    e.preventDefault();
    const [zs, ze] = store.spectrumZoom();
    const span = ze - zs;
    const rawDelta = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
    const rawDeltaX = e.deltaMode === 1 ? e.deltaX * 40 : e.deltaX;

    // Horizontal scroll or Shift+wheel → pan
    if (e.shiftKey || Math.abs(rawDeltaX) > Math.abs(rawDelta)) {
      const panDelta = (e.shiftKey ? rawDelta : rawDeltaX) * 0.001 * span;
      pan(panDelta);
      return;
    }

    // Vertical scroll → zoom centred on cursor
    const rect   = spectrumRef.getBoundingClientRect();
    const pivot  = (e.clientX - rect.left) / rect.width;
    const zoom   = Math.pow(1.002, rawDelta);
    const newSpan = Math.min(1, Math.max(0.005, span * zoom));
    const pivotFrac = zs + pivot * span;
    let newStart = pivotFrac - pivot * newSpan;
    let newEnd   = newStart + newSpan;
    if (newStart < 0) { newEnd -= newStart; newStart = 0; }
    if (newEnd   > 1) { newStart -= (newEnd - 1); newEnd = 1; }
    newStart = Math.max(0, newStart);
    newEnd   = Math.min(1, newEnd);
    if (newEnd - newStart < 0.005) return;
    if (newEnd - newStart > 0.999) engine.resetSpectrumZoom();
    else engine.setSpectrumZoom(newStart, newEnd);
  };

  const handleSpectrumDblClick = () => engine.resetSpectrumZoom();

  const handleMouseLeave = () => {
    setHoverFreq(null);
    setHoverDb(null);
    setPanAnchor(null);
    if (isDragging()) {
      setIsDragging(false);
      setDragStart(null);
      setDragEnd(null);
    }
  };

  // ---- Waterfall mouse handlers ----

  const handleWaterfallClick = async (e: MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    engine.tune(Math.round(xFracToHz((e.clientX - rect.left) / rect.width) - store.centerFrequency()));

    // Snap back to live if currently seeking
    if (seekOffset() > 0) setSeekOffset(0);

    // Start audio if not yet initialised (waterfall/spectrum click = intent to listen)
    if (!engine.isAudioInitialized) {
      await engine.initAudio();
      store.setAudioStarted(true);
    }
  };

  const handleWaterfallMouseMove = (e: MouseEvent) => {
    setCursorX(e.clientX);
    setCursorY(e.clientY);
    setHoverFreq(freqFromEvent(e));
    setHoverDb(null);
  };

  // Waterfall wheel — horizontal scroll pans, vertical scroll zooms spectrum
  const handleWaterfallWheel = (e: WheelEvent) => {
    e.preventDefault();
    const [zs, ze] = store.spectrumZoom();
    const span = ze - zs;
    const rawDelta  = e.deltaMode === 1 ? e.deltaY  * 40 : e.deltaY;
    const rawDeltaX = e.deltaMode === 1 ? e.deltaX  * 40 : e.deltaX;
    // Horizontal trackpad swipe → pan
    if (Math.abs(rawDeltaX) > Math.abs(rawDelta)) {
      pan(rawDeltaX * 0.001 * span);
    } else {
      // Vertical → pan (waterfall has no frequency axis to zoom against)
      pan(rawDelta * 0.001 * span);
    }
  };

  // ---- Toolbar helpers ----

  const btnClass = (active: boolean) =>
    `absolute z-10 w-6 h-6 flex items-center justify-center rounded-sm border transition-colors
     ${active
       ? 'border-[var(--sdr-accent)] text-[var(--sdr-accent)]'
       : 'border-border text-text-muted hover:text-text-dim hover:border-border-active'}`;

  const AVG_STEPS: Array<'fast' | 'med' | 'slow'> = ['fast', 'med', 'slow'];
  const nextAvg = () => {
    engine.setSpectrumAveraging(AVG_STEPS[(AVG_STEPS.indexOf(store.spectrumAveraging()) + 1) % 3]);
  };

  const dragRect = () => {
    const ds = dragStart(), de = dragEnd();
    if (ds === null || de === null || !isDragging()) return null;
    const lo = Math.min(ds, de), hi = Math.max(ds, de);
    return { left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` };
  };

  // Cursor: pan overrides everything when panning; range-select mode uses cell cursor
  const spectrumCursor = () => {
    if (panAnchor() !== null) return 'cursor-grabbing';
    if (store.spectrumRangeSelect()) return isDragging() ? 'cursor-col-resize' : 'cursor-cell';
    return 'cursor-crosshair';
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
          class={`absolute inset-0 w-full h-full ${spectrumCursor()}`}
          onMouseDown={handleSpectrumMouseDown}
          onMouseMove={handleSpectrumMouseMove}
          onMouseUp={handleSpectrumMouseUp}
          onMouseLeave={handleMouseLeave}
          onDblClick={handleSpectrumDblClick}
          onWheel={handleSpectrumWheel}
        />

        {/* Range-select drag overlay */}
        <Show when={dragRect() !== null}>
          <div
            class="absolute top-0 bottom-0 pointer-events-none z-20
                   bg-[var(--sdr-accent)]/10 border-x border-[var(--sdr-accent)]/40"
            style={dragRect()!}
          />
        </Show>

        {/* Zoom reset badge */}
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

        {/* ── Toolbar buttons ───────────────────────────────────── */}

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
            <polyline points="0,7 2,8 4,6.5 6,7.5 8,6 10,7 12,6.5 14,7"
              stroke="currentColor" stroke-width="1.2"
              stroke-linecap="round" stroke-linejoin="round"/>
            <line x1="0" y1="9" x2="14" y2="9"
              stroke="currentColor" stroke-width="1"
              stroke-dasharray="2 1.5" opacity="0.6"/>
          </svg>
        </button>

        {/* Range select — drag to zoom */}
        <button class={btnClass(store.spectrumRangeSelect())}
          style={{ top: '6px', left: '172px' }}
          title={store.spectrumRangeSelect() ? 'Range select: on — drag to zoom' : 'Range select: off'}
          onClick={() => store.setSpectrumRangeSelect(!store.spectrumRangeSelect())}>
          {/* Icon: bracket-style selection region with arrows pointing inward */}
          <svg viewBox="0 0 14 12" fill="none" class="w-3.5 h-3">
            <rect x="3" y="1" width="8" height="10" rx="0.5"
              stroke="currentColor" stroke-width="1.1"
              stroke-dasharray="2 1" fill="currentColor" fill-opacity="0.1"/>
            <line x1="3"  y1="6" x2="0"  y2="6" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
            <line x1="11" y1="6" x2="14" y2="6" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
            <polyline points="1.5,4.5 0,6 1.5,7.5" stroke="currentColor" stroke-width="1.1"
              stroke-linecap="round" stroke-linejoin="round" fill="none"/>
            <polyline points="12.5,4.5 14,6 12.5,7.5" stroke="currentColor" stroke-width="1.1"
              stroke-linecap="round" stroke-linejoin="round" fill="none"/>
          </svg>
        </button>

        <FrequencyScale />
      </div>

      {/* Waterfall */}
      <div class="relative flex-1 min-h-0">
        <canvas
          ref={waterfallRef!}
          class={`absolute inset-0 w-full h-full ${panAnchor() !== null ? 'cursor-grabbing' : 'cursor-crosshair'}`}
          style={{ "image-rendering": "crisp-edges" }}
          onClick={handleWaterfallClick}
          onMouseMove={handleWaterfallMouseMove}
          onMouseLeave={handleMouseLeave}
          onWheel={handleWaterfallWheel}
        />
        <div class="sdr-scanlines" />
        <RdsOverlay />
      </div>

      {/* Seek-back scrub bar */}
      <Show when={bufferCount() > 0}>
        <div class="shrink-0 h-5 flex items-center gap-2 px-2
                    bg-sdr-surface border-t border-border">
          <span class={`text-[8px] font-mono shrink-0 w-7 text-right
                        ${seekOffset() > 0 ? 'text-amber' : 'text-text-muted'}`}>
            {seekOffset() > 0 ? `-${seekOffset()}` : 'LIVE'}
          </span>
          <input
            type="range"
            aria-label="Waterfall playback position"
            min={0}
            max={bufferCount()}
            step={1}
            value={seekOffset()}
            class="flex-1 h-1 accent-[var(--sdr-accent)] cursor-pointer"
            onInput={e => setSeekOffset(parseInt(e.currentTarget.value))}
          />
          <Show when={seekOffset() > 0}>
            <button
              class="text-[8px] font-mono text-text-muted hover:text-[var(--sdr-accent)]
                     transition-colors shrink-0"
              onClick={() => setSeekOffset(0)}
            >
              ↩ live
            </button>
          </Show>
        </div>
      </Show>
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
