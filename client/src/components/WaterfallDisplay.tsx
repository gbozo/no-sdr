// ============================================================
// node-sdr — Waterfall + Spectrum Component
// ============================================================

import { Component, onMount, onCleanup, Show, createSignal, For, createEffect } from 'solid-js';
import { engine } from '../engine/sdr-engine.js';
import { store } from '../store/index.js';
import { bands, tagColor, TAG_BORDER_COLORS } from '../store/bandplan.js';

const WaterfallDisplay: Component = () => {
  let waterfallRef!: HTMLCanvasElement;
  let spectrumRef!: HTMLCanvasElement;
  let containerRef!: HTMLDivElement;

  // Tooltip state
  const [hoverFreq, setHoverFreq] = createSignal<string | null>(null);
  const [hoverPeakDb, setHoverPeakDb] = createSignal<string | null>(null);
  const [cursorX,   setCursorX]   = createSignal(0);
  const [cursorY,   setCursorY]   = createSignal(0);
  const [lastHoverX, setLastHoverX] = createSignal<number>(-1);
  const [peakUpdateTimer, setPeakUpdateTimer] = createSignal<number | null>(null);

  // Zoom drag state (range select mode)
  const [dragStart,  setDragStart]  = createSignal<number | null>(null);
  const [dragEnd,    setDragEnd]    = createSignal<number | null>(null);
  const [isDragging, setIsDragging] = createSignal(false);

  // Pan drag state (middle-click or Shift+left-click)
  const [panAnchor, setPanAnchor] = createSignal<number | null>(null);

  // ---- Click-to-tune fine tuning state ----
  // 'finetune': mouse drag adjusts frequency by small steps from the base offset
  const [tuneMode,        setTuneMode]        = createSignal<'finetune' | null>(null);
  // Offset (Hz from center) at the moment the mouse button went down
  const [tuneBaseOffset,  setTuneBaseOffset]  = createSignal(0);
  // clientX at the moment the mouse button went down (for delta computation)
  const [tuneBaseX,       setTuneBaseX]       = createSignal(0);
  // Whether the mousedown landed inside the filter passband (for nudge-on-click)
  const [tuneInsideBand,  setTuneInsideBand]  = createSignal(false);
  // Clicked Hz at mousedown (for inside-band nudge direction)
  const [tuneClickHz,     setTuneClickHz]     = createSignal(0);

  // Fine-tune sensitivity: Hz of frequency change per pixel of mouse movement.
  // This is computed from the current zoom so that the feel is consistent
  // regardless of how far the user is zoomed in.
  const fineTuneHzPerPx = (): number => {
    const [zs, ze] = store.spectrumZoom();
    const rect = spectrumRef?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 50;
    // How many Hz per pixel in the current zoom view
    const hzPerPx = (ze - zs) * store.sampleRate() / rect.width;
    // Fine-tune uses 15% of that so movement feels deliberate but precise
    return hzPerPx * 0.15;
  };

  // Returns true if the given relative X position falls within the current filter passband
  const isInsideFilterBand = (relX: number): boolean => {
    const [zs, ze] = store.spectrumZoom();
    const sr = store.sampleRate();
    const offset = store.tuneOffset();
    const bw = store.bandwidth();
    // Convert current tuned offset to normalised zoom-space position
    const normFull = (offset / sr) + 0.5;
    const normZoomed = (normFull - zs) / (ze - zs);
    // Half-bandwidth in zoom-space
    const halfBwZoom = (bw / sr / 2) / (ze - zs);
    const lo = normZoomed - halfBwZoom;
    const hi = normZoomed + halfBwZoom;
    return relX >= lo && relX <= hi;
  };

  // Seek-back scrub
  const [seekOffset, setSeekOffset] = createSignal(0);
  const [bufferCount, setBufferCount] = createSignal(0); // viewport fraction at drag start

  onMount(() => {
    engine.attachCanvases(waterfallRef, spectrumRef);

    // Apply persisted spectrum/display settings to the renderers immediately
    // after canvases are attached — without this the engine uses its own defaults
    // until the user clicks a button, ignoring whatever was saved in localStorage.
    engine.setWaterfallTheme(store.waterfallTheme());
    engine.setWaterfallGamma(store.waterfallGamma());
    engine.setSpectrumPeakHold(store.spectrumPeakHold());
    engine.setSpectrumSignalFill(store.spectrumSignalFill());
    engine.setSpectrumNoiseFloor(store.spectrumNoiseFloor());
    engine.setSpectrumAveraging(store.spectrumAveraging());
    const observer = new ResizeObserver(() => {
      // Debounce resize events — Android Chrome/Firefox fire on every pixel of
      // URL-bar animation (up to 60×/sec), which would clear both canvases
      // and cause severe flicker. Collapse into a single handleResize per 150ms.
      if ((observer as any)._rafHandle) cancelAnimationFrame((observer as any)._rafHandle);
      (observer as any)._rafHandle = requestAnimationFrame(() => {
        (observer as any)._rafHandle = 0;
        engine.handleResize();
      });
    });
    observer.observe(containerRef);
    requestAnimationFrame(() => {
      engine.handleResize();
      // Now the worker has real canvas dimensions — safe to send buffered history
      engine.flushPendingHistory();
    });

    // Poll buffer count so the scrub range max stays current
    const bufferPoll = setInterval(() => setBufferCount(engine.fftBufferCount), 500);

    onCleanup(() => {
      observer.disconnect();
      clearInterval(bufferPoll);
      // Clean up peak update timer if component unmounts while hovering
      const timer = peakUpdateTimer();
      if (timer !== null) clearInterval(timer);
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

  // ---- Pan helper ----
  // Shift the zoom viewport by `delta` (fraction of full band), clamped to [0,1]
  const pan = (delta: number) => {
    const [zs, ze] = store.spectrumZoom();
    const span = ze - zs;
    let ns = zs + delta, ne = ze + delta;
    if (ns < 0) { ns = 0; ne = span; }
    if (ne > 1) { ne = 1; ns = 1 - span; }
    if (zs === ns && ze === ne) return;
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
      engine.beginWaterfallPan();
      return;
    }
    // Left-click + range select → zoom drag
    if (e.button === 0 && store.spectrumRangeSelect()) {
      setDragStart(rx);
      setDragEnd(rx);
      setIsDragging(true);
      return;
    }
    // Left-click tuning logic
    if (e.button === 0 && !e.shiftKey && !store.spectrumRangeSelect()) {
      const clickedHz = xFracToHz(rx);
      const clickedOffset = Math.round(clickedHz - store.centerFrequency());
      if (isInsideFilterBand(rx)) {
        // --- Inside band: fine-tune from current position (no jump) ---
        setTuneMode('finetune');
        setTuneBaseOffset(store.tuneOffset());
        setTuneBaseX(e.clientX);
        setTuneInsideBand(true);
        setTuneClickHz(clickedHz);
      } else {
        // --- Outside band: instant tune, then fine-tune from new position ---
        engine.tune(clickedOffset);
        setTuneMode('finetune');
        setTuneBaseOffset(clickedOffset);
        setTuneBaseX(e.clientX);
        setTuneInsideBand(false);
        setTuneClickHz(clickedHz);
      }
    }
  };

  const handleSpectrumMouseMove = (e: MouseEvent) => {
    setCursorX(e.clientX);
    setCursorY(e.clientY);
    const isHovering = hoverFreq() === null;
    setHoverFreq(freqFromEvent(e));
    // Start peak update timer on mouse enter (first move after hover was inactive)
    if (isHovering) {
      setLastHoverX(-1); // force update
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const canvasX = Math.round((e.clientX - rect.left) * dpr);
      setLastHoverX(canvasX);
      const peakDb = engine.getSpectrumTooltipPeakDbAtPixel(canvasX);
      setHoverPeakDb(peakDb !== null ? `${peakDb.toFixed(1)} dB` : null);
const timer = setInterval(() => {
        const x = lastHoverX();
        if (x >= 0) {
          const pk = engine.getSpectrumTooltipPeakDbAtPixel(x);
          setHoverPeakDb(pk !== null ? `${pk.toFixed(1)} dB` : null);
        }
      }, 1000);
      setPeakUpdateTimer(timer);
    } else {
      // Update peak while hovering (already active)
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const canvasX = Math.round((e.clientX - rect.left) * dpr);
      setLastHoverX(canvasX);
      const peakDb = engine.getSpectrumTooltipPeakDbAtPixel(canvasX);
      setHoverPeakDb(peakDb !== null ? `${peakDb.toFixed(1)} dB` : null);
    }
    if (isDragging()) {
      setDragEnd(spectrumRelX(e));
    } else if (panAnchor() !== null) {
      const rx = spectrumRelX(e);
      const [zs, ze] = store.spectrumZoom();
      const span = ze - zs;
      // Pan by the fraction moved (in viewport space → band space)
      pan((panAnchor()! - rx) * span);
      setPanAnchor(rx); // update anchor so pan is incremental
      engine.drawWaterfallPan();
    } else if (tuneMode() === 'finetune') {
      // Fine-tune: mouse delta * hz-per-px * fine factor = frequency nudge
      const dxPx = e.clientX - tuneBaseX();
      const deltaHz = Math.round(dxPx * fineTuneHzPerPx());
      const newOffset = tuneBaseOffset() + deltaHz;
      if (newOffset !== store.tuneOffset()) {
        engine.tune(newOffset);
      }
    }
  };

  const handleSpectrumMouseUp = async (e: MouseEvent) => {
    // End pan
    if (panAnchor() !== null) {
      setPanAnchor(null);
      engine.endWaterfallPan();
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
      return;
    }

    const mode = tuneMode();
    if (mode !== null && e.button === 0) {
      // Pure click inside band (no drag) → nudge toward clicked position,
      // scaled by how far from center the click landed (0 = center → tiny step,
      // 1 = band edge → full step equal to half the bandwidth).
      const dxPx = Math.abs(e.clientX - tuneBaseX());
      if (tuneInsideBand() && dxPx < 3) {
        const targetOffset  = Math.round(tuneClickHz() - store.centerFrequency());
        const currentOffset = store.tuneOffset();
        const diff = targetOffset - currentOffset;
        if (Math.abs(diff) > 1) {
          // t: 0 at center, 1 at band edge
          const halfBw = store.bandwidth() / 2;
          const t = Math.min(1, Math.abs(diff) / halfBw);
          // Step scales from ~5% of halfBw near center to ~25% near the edge
          const step = halfBw * (0.05 + t * 0.20);
          engine.tune(Math.round(currentOffset + Math.sign(diff) * Math.min(step, Math.abs(diff))));
        }
      }

      setTuneMode(null);
      setTuneInsideBand(false);

      // Start audio on first click if not running
      if (!engine.isAudioInitialized) {
        try {
          await engine.initAudio();
          store.setAudioStarted(true);
        } catch (err) {
          alert((err as Error).message);
        }
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
    const finalSpan = newEnd - newStart;
    if (finalSpan < 0.005) return;
    if (finalSpan > 0.999) newStart = 0, newEnd = 1;
    if (zs === newStart && ze === newEnd) return;
    engine.setSpectrumZoom(newStart, newEnd);
  };

  const handleSpectrumDblClick = () => engine.resetSpectrumZoom();

  const handleMouseLeave = () => {
    setHoverFreq(null);
    setHoverPeakDb(null);
    setLastHoverX(-1);
    const timer = peakUpdateTimer();
    if (timer !== null) {
      clearInterval(timer);
      setPeakUpdateTimer(null);
    }
    if (panAnchor() !== null) {
      setPanAnchor(null);
      engine.endWaterfallPan();
    }
    if (isDragging()) {
      setIsDragging(false);
      setDragStart(null);
      setDragEnd(null);
    }
    // Cancel any in-progress fine-tune drag if mouse leaves the canvas
    if (tuneMode() !== null) {
      setTuneMode(null);
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
      try {
        await engine.initAudio();
        store.setAudioStarted(true);
      } catch (err) {
        alert((err as Error).message);
      }
    }
  };

  const handleWaterfallMouseMove = (e: MouseEvent) => {
    setCursorX(e.clientX);
    setCursorY(e.clientY);
    const isHovering = hoverFreq() === null;
    setHoverFreq(freqFromEvent(e));
    setHoverPeakDb(null);
    // Start peak update timer on mouse enter (first move after hover was inactive)
    if (isHovering) {
      setLastHoverX(-1); // force update
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const canvasX = Math.round((e.clientX - rect.left) * dpr);
      setLastHoverX(canvasX);
      const peakDb = engine.getSpectrumTooltipPeakDbAtPixel(canvasX);
      setHoverPeakDb(peakDb !== null ? `${peakDb.toFixed(1)} dB` : null);
const timer = setInterval(() => {
        const x = lastHoverX();
        if (x >= 0) {
          const pk = engine.getSpectrumTooltipPeakDbAtPixel(x);
          setHoverPeakDb(pk !== null ? `${pk.toFixed(1)} dB` : null);
        }
      }, 1000);
      setPeakUpdateTimer(timer);
    } else {
      // Update peak while already hovering - same as spectrum handling
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const canvasX = Math.round((e.clientX - rect.left) * dpr);
      setLastHoverX(canvasX);
      const peakDb = engine.getSpectrumTooltipPeakDbAtPixel(canvasX);
      setHoverPeakDb(peakDb !== null ? `${peakDb.toFixed(1)} dB` : null);
    }
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

  // ---- Touch handlers ----
  // Spectrum: 1-finger pan, 2-finger pinch-to-zoom
  // Waterfall: 1-finger pan

  let touchPanAnchor: number | null = null;       // last touch X (0-1) for 1-finger pan
  let touchPinchDist: number | null = null;       // last pinch distance in px
  let touchPinchMid:  number | null = null;       // last pinch midpoint (0-1)

  const touchRelX = (t: Touch, el: HTMLElement): number => {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (t.clientX - r.left) / r.width));
  };

  const pinchDist = (t0: Touch, t1: Touch) =>
    Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);

  const handleSpectrumTouchStart = (e: TouchEvent) => {
    e.preventDefault();
    if (e.touches.length === 1) {
      touchPanAnchor = touchRelX(e.touches[0], e.currentTarget as HTMLElement);
      touchPinchDist = null;
      touchPinchMid  = null;
      engine.beginWaterfallPan();
    } else if (e.touches.length === 2) {
      touchPanAnchor = null;
      touchPinchDist = pinchDist(e.touches[0], e.touches[1]);
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      touchPinchMid = ((e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left) / r.width;
    }
  };

  const handleSpectrumTouchMove = (e: TouchEvent) => {
    e.preventDefault();
    const [zs, ze] = store.spectrumZoom();
    const span = ze - zs;
    if (e.touches.length === 1 && touchPanAnchor !== null) {
      const rx = touchRelX(e.touches[0], e.currentTarget as HTMLElement);
      pan((touchPanAnchor - rx) * span);
      touchPanAnchor = rx;
      engine.drawWaterfallPan();
    } else if (e.touches.length === 2 && touchPinchDist !== null && touchPinchMid !== null) {
      const newDist = pinchDist(e.touches[0], e.touches[1]);
      const scale = touchPinchDist / newDist; // >1 = zoom out, <1 = zoom in
      touchPinchDist = newDist;
      const newSpan = Math.min(1, Math.max(0.005, span * scale));
      const pivot = touchPinchMid;
      const pivotFrac = zs + pivot * span;
      let ns = pivotFrac - pivot * newSpan;
      let ne = ns + newSpan;
      if (ns < 0) { ne -= ns; ns = 0; }
      if (ne > 1) { ns -= (ne - 1); ne = 1; }
      ns = Math.max(0, ns); ne = Math.min(1, ne);
      if (Math.abs(ne - ns - newSpan) < 0.001) engine.setSpectrumZoom(ns, ne);
    }
  };

  const handleSpectrumTouchEnd = (e: TouchEvent) => {
    if (e.touches.length === 0) {
      touchPanAnchor = null;
      touchPinchDist = null;
      touchPinchMid  = null;
      engine.endWaterfallPan();
    } else if (e.touches.length === 1) {
      // Lifted one finger during pinch → switch to pan
      touchPinchDist = null;
      touchPinchMid  = null;
      touchPanAnchor = touchRelX(e.touches[0], e.currentTarget as HTMLElement);
    }
  };

  const handleWaterfallTouchStart = (e: TouchEvent) => {
    e.preventDefault();
    if (e.touches.length === 1) {
      touchPanAnchor = touchRelX(e.touches[0], e.currentTarget as HTMLElement);
      engine.beginWaterfallPan();
    }
  };

  const handleWaterfallTouchMove = (e: TouchEvent) => {
    e.preventDefault();
    if (e.touches.length !== 1 || touchPanAnchor === null) return;
    const [zs, ze] = store.spectrumZoom();
    const span = ze - zs;
    const rx = touchRelX(e.touches[0], e.currentTarget as HTMLElement);
    pan((touchPanAnchor - rx) * span);
    touchPanAnchor = rx;
    engine.drawWaterfallPan();
  };

  const handleWaterfallTouchEnd = () => {
    touchPanAnchor = null;
    engine.endWaterfallPan();
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
          <Show when={hoverPeakDb() !== null}>
            <span class="text-amber ml-1">{hoverPeakDb()}</span>
          </Show>
        </div>
      </Show>

      {/* Spectrum */}
      <div class="relative h-[180px] min-h-[120px] border-b border-border">
        <canvas
          ref={spectrumRef!}
          class={`absolute inset-0 w-full h-full ${spectrumCursor()}`}
          style={{ "will-change": "transform" }}
          onMouseDown={handleSpectrumMouseDown}
          onMouseMove={handleSpectrumMouseMove}
          onMouseUp={handleSpectrumMouseUp}
          onMouseLeave={handleMouseLeave}
          onDblClick={handleSpectrumDblClick}
          onWheel={handleSpectrumWheel}
          onTouchStart={handleSpectrumTouchStart}
          onTouchMove={handleSpectrumTouchMove}
          onTouchEnd={handleSpectrumTouchEnd}
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
          style={{ "will-change": "transform" }}
          onClick={handleWaterfallClick}
          onMouseMove={handleWaterfallMouseMove}
          onMouseLeave={handleMouseLeave}
          onWheel={handleWaterfallWheel}
          onTouchStart={handleWaterfallTouchStart}
          onTouchMove={handleWaterfallTouchMove}
          onTouchEnd={handleWaterfallTouchEnd}
        />
        {/* <div class="sdr-scanlines" /> */}
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

// Frequency scale — zoom-aware, with signal markers and band plan overlay
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

  // Band plan entries clipped to the current zoom viewport
  const visibleBands = () => {
    const [zs, ze] = store.spectrumZoom();
    const sr = store.sampleRate();
    const cf = store.centerFrequency();
    const loHz = cf + (zs - 0.5) * sr;
    const hiHz = cf + (ze - 0.5) * sr;
    const span = hiHz - loHz;
    if (span <= 0) return [];
    return bands()
      .filter(b => b.upper_bound > loHz && b.lower_bound < hiHz)
      .map(b => {
        const clampedLo = Math.max(b.lower_bound, loHz);
        const clampedHi = Math.min(b.upper_bound, hiHz);
        return {
          ...b,
          leftPct:  ((clampedLo - loHz) / span) * 100,
          widthPct: ((clampedHi - clampedLo) / span) * 100,
        };
      });
  };

  return (
    <>
      {/* Band plan colour strips — overlaid at top of spectrum canvas */}
      <div class="absolute top-0 left-0 right-0 h-5 pointer-events-none z-10 overflow-hidden">
        <For each={visibleBands()}>
          {(b) => {
            const borderColor = TAG_BORDER_COLORS[b.tags?.[0] ?? ''] ?? 'rgba(150,150,150,0.35)';
            return (
              <div
                class="absolute top-0 bottom-0"
                style={{
                  left: `${b.leftPct}%`,
                  width: `${b.widthPct}%`,
                  background: `linear-gradient(to top, transparent 0%, ${tagColor(b.tags)} 100%)`,
                  'border-left': `1px solid ${borderColor}`,
                  'border-right': `1px solid ${borderColor}`,
                }}
                title={`${b.name}${b.tags?.length ? ' · ' + b.tags.join(', ') : ''}`}
              />
            );
          }}
        </For>
        {/* Band name labels for wide enough bands */}
        <For each={visibleBands().filter(b => b.widthPct > 3)}>
          {(b) => (
            <span
              class="absolute top-0 bottom-0 flex items-center justify-center
                     text-[7px] font-mono text-white overflow-hidden whitespace-nowrap"
              style={{ left: `${b.leftPct}%`, width: `${b.widthPct}%`,
                       'text-shadow': '0 0 3px rgba(0,0,0,0.9)' }}
            >
              {b.name}
            </span>
          )}
        </For>
      </div>
      {/* Frequency labels + signal markers — bottom of spectrum */}
      <div class="absolute bottom-0 left-0 right-0 pointer-events-none">
        <div class="relative flex items-center h-5 bg-sdr-base/80 border-t border-border/50">
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
      </div>
    </>
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
