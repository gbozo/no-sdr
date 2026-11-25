// ============================================================
// Spectrum / waterfall zoom viewport rules
// ============================================================
// The wheel and pinch handlers, the spectrum canvas, the waterfall canvas,
// the frequency scale and the tune overlay all read the same [start, end]
// pair. They used to clamp to different minimum spans (0.005 in the input
// handlers, 0.01 in the renderers), so a fully zoomed view drew twice the
// span its labels, tune marker and click-to-tune used. Keep every consumer
// on this one function.

/** Smallest viewport width, as a fraction of the full band. */
export const MIN_SPECTRUM_ZOOM_SPAN = 0.005;

/**
 * Clamp a viewport to `[0, 1]` and to at least {@link MIN_SPECTRUM_ZOOM_SPAN}.
 * A request narrower than the minimum is expanded around its centre.
 */
export function normalizeSpectrumZoom(start: number, end: number): [number, number] {
  let lo = Number.isFinite(start) ? start : 0;
  let hi = Number.isFinite(end) ? end : 1;
  if (lo > hi) [lo, hi] = [hi, lo];
  lo = Math.max(0, Math.min(1 - MIN_SPECTRUM_ZOOM_SPAN, lo));
  hi = Math.max(MIN_SPECTRUM_ZOOM_SPAN, Math.min(1, hi));
  if (hi - lo < MIN_SPECTRUM_ZOOM_SPAN) {
    const mid = (lo + hi) / 2;
    lo = mid - MIN_SPECTRUM_ZOOM_SPAN / 2;
    hi = mid + MIN_SPECTRUM_ZOOM_SPAN / 2;
    if (lo < 0) {
      hi -= lo;
      lo = 0;
    }
    if (hi > 1) {
      lo -= hi - 1;
      hi = 1;
    }
    lo = Math.max(0, lo);
  }
  return [lo, hi];
}
