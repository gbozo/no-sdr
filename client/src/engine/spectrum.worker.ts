// ============================================================
// node-sdr — Spectrum Worker (OffscreenCanvas)
// ============================================================
// Owns the SpectrumRenderer entirely inside a Worker.
// The main thread transfers OffscreenCanvas control once at init;
// after that all draw calls happen here, freeing the main thread
// from Canvas 2D work.
//
// Message protocol (main → worker):
//
//   { type: 'init', canvas: OffscreenCanvas,
//     width: number, height: number, dpr: number,
//     minDb: number, maxDb: number,
//     accentColor?: string,
//     peakHold?: boolean, signalFill?: boolean,
//     noiseFloor?: boolean, smoothingAlpha?: number }
//     (canvas is transferred)
//
//   { type: 'frame', fftData: Float32Array,
//     tuneOffset: number, bandwidth: number, sampleRate: number }
//     (fftData transferred)
//
//   { type: 'set-range', minDb: number, maxDb: number }
//   { type: 'set-peak-hold', enabled: boolean }
//   { type: 'set-signal-fill', enabled: boolean }
//   { type: 'set-pause', enabled: boolean }
//   { type: 'set-smoothing', alpha: number }
//   { type: 'set-noise-floor', enabled: boolean }
//   { type: 'set-accent-color', color: string }
//   { type: 'set-zoom', start: number, end: number }
//   { type: 'reset-zoom' }
//   { type: 'resize', width: number, height: number, dpr: number }
//   { type: 'clear' }
// ============================================================

import { SpectrumRenderer } from './spectrum.js';

// ---- Worker state ----

let renderer: SpectrumRenderer | null = null;
let dpr = 1;

// ---- Message handler ----

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;

  switch (msg.type) {
    case 'init': {
      const canvas = msg.canvas as OffscreenCanvas;
      dpr = msg.dpr ?? 1;
      canvas.width = msg.width * dpr;
      canvas.height = msg.height * dpr;
      renderer = new SpectrumRenderer(canvas, msg.minDb ?? -120, msg.maxDb ?? -40, msg.accentColor);
      if (msg.peakHold) renderer.setPeakHold(true);
      if (msg.signalFill) renderer.setSignalFill(true);
      if (msg.noiseFloor) renderer.setNoiseFloor(true);
      if (msg.smoothingAlpha) renderer.setSmoothing(msg.smoothingAlpha);
      renderer.resize(msg.width * dpr, msg.height * dpr);
      break;
    }

    case 'frame': {
      if (!renderer) break;
      const fftData = msg.fftData as Float32Array;
      if (!renderer.draw(fftData)) break;
      renderer.drawTuningIndicator(
        msg.tuneOffset as number,
        msg.bandwidth as number,
        msg.sampleRate as number,
      );
      break;
    }

    case 'set-range': {
      renderer?.setRange(msg.minDb, msg.maxDb);
      break;
    }

    case 'set-peak-hold': {
      renderer?.setPeakHold(msg.enabled);
      break;
    }

    case 'set-signal-fill': {
      renderer?.setSignalFill(msg.enabled);
      break;
    }

    case 'set-pause': {
      renderer?.setPause(msg.enabled);
      break;
    }

    case 'set-smoothing': {
      renderer?.setSmoothing(msg.alpha);
      break;
    }

    case 'set-noise-floor': {
      renderer?.setNoiseFloor(msg.enabled);
      break;
    }

    case 'set-accent-color': {
      renderer?.setAccentColor(msg.color);
      break;
    }

    case 'set-zoom': {
      renderer?.setZoom(msg.start, msg.end);
      break;
    }

    case 'reset-zoom': {
      renderer?.resetZoom();
      break;
    }

    case 'resize': {
      dpr = msg.dpr ?? dpr;
      renderer?.resize(msg.width * dpr, msg.height * dpr);
      break;
    }

    case 'clear': {
      renderer?.clear();
      break;
    }
  }
};
