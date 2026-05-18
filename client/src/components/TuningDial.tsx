// ============================================================
// TuningDial — Rotary encoder wheel with detent-based decode
//
// Model: physical mechanical rotary encoder.
//   • The drum has NOTCHES_PER_REV detent positions per full revolution.
//   • Dragging rotates the drum; each time a full detent is crossed,
//     onTune(±step) fires exactly once — like an electrical encoder pulse.
//   • Momentum coasting continues generating pulses after release.
//   • No fractional Hz accumulation — clean integer detent steps only.
// ============================================================

import { Component, onMount, onCleanup } from 'solid-js';
import { store } from '../store/index.js';

interface TuningDialProps {
  /** Called once per detent step. deltaHz = ±tuningStep. */
  onTune: (deltaHz: number) => void;
}

// ── Encoder geometry ──────────────────────────────────────────
const NOTCHES_PER_REV = 40;       // detents in one full drum revolution
const MAJOR_EVERY     = 5;        // every Nth notch is a major tick mark
// Pixels of canvas width = one full revolution
// Larger = more drag needed per step (lower sensitivity)
const PX_PER_REV      = 240;      // px of drag = 1 full revolution

// ── Physics ───────────────────────────────────────────────────
const FRICTION        = 0.985;    // velocity decay per rAF frame (lower = stops faster)
const MIN_VELOCITY    = 0.005;    // rev/frame below which coasting stops

// ── Visual ────────────────────────────────────────────────────
const DRUM_HEIGHT     = 22;       // px — CSS height of canvas
const EDGE_FADE       = 48;       // px of vignette fade on each side
const CENTER_MARK_W   = 2;        // px
const CENTER_MARK_H   = 32;       // px

// ── Derived ───────────────────────────────────────────────────
// px per notch spacing on canvas (visual, not physics)
// We want to show ~NOTCHES_PER_REV * 1.5 worth of notches across the canvas
// so the wheel always looks full. Actual spacing is computed from canvas width.

const TuningDial: Component<TuningDialProps> = (props) => {
  let canvasRef: HTMLCanvasElement | undefined;
  let animRef: number;

  // ── Encoder state ────────────────────────────────────────────
  // angle in fractional revolutions (monotonically increasing/decreasing)
  let angle        = 0;      // current drum angle (revolutions, unbounded)
  let lastDetent   = 0;      // last integer detent index we fired at
  let velocity     = 0;      // revolutions/frame
  let dragging     = false;
  let lastX        = 0;
  let lastDragDx   = 0;      // last pointer dx in px, for momentum launch

  // ── Detent decode ─────────────────────────────────────────────
  // Called whenever angle changes. Computes how many detents have been
  // crossed since last call and fires onTune() that many times.
  const decode = () => {
    // angle is in revolutions; one revolution = NOTCHES_PER_REV detents
    const detent = Math.trunc(angle * NOTCHES_PER_REV);
    const delta  = detent - lastDetent;
    if (delta === 0) return;

    const step = store.tuningStep() > 0 ? store.tuningStep() : 100;
    props.onTune(delta * step);
    lastDetent = detent;
  };

  // ── Draw ─────────────────────────────────────────────────────
  const draw = () => {
    const canvas = canvasRef;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const W   = canvas.width  / dpr;   // CSS pixels
    const H   = canvas.height / dpr;

    // Theme colors from CSS variables
    const style       = getComputedStyle(document.documentElement);
    const accent      = style.getPropertyValue('--sdr-accent').trim()     || '#4aa3ff';
    const dimColor    = style.getPropertyValue('--color-text-dim').trim() || '#6f7f94';

    ctx.clearRect(0, 0, W, H);

    // ── Background: machined drum gradient ──
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0,   '#1a2235');
    bg.addColorStop(0.18,'#0e1520');
    bg.addColorStop(0.5, '#0b1018');
    bg.addColorStop(0.82,'#0e1520');
    bg.addColorStop(1,   '#1a2235');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // ── Knurling: horizontal grip grooves ──
    for (let r = 0; r < 5; r++) {
      const y = H * (r + 1) / 6;
      ctx.beginPath();
      ctx.moveTo(0, y); ctx.lineTo(W, y);
      ctx.strokeStyle = r === 2 ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.02)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // ── Notch rendering ──────────────────────────────────────────
    // Visual notch spacing: we tile the drum with NOTCHES_PER_REV notches per PX_PER_REV px.
    // The drum scrolls by angle * PX_PER_REV pixels.
    const spacing    = PX_PER_REV / NOTCHES_PER_REV;  // px between notches
    const scrollPx   = angle * PX_PER_REV;             // total scroll in px

    // phase: position within one notch period (0..spacing), for tiling
    const phase      = ((scrollPx % spacing) + spacing) % spacing;

    // globalFirst: index of the leftmost notch drawn
    // scrollPx > 0 means drum moved right → notches came from left
    const globalFirst = -Math.ceil(scrollPx / spacing) - 1;
    const totalNotches = Math.ceil(W / spacing) + 3;

    for (let i = 0; i < totalNotches; i++) {
      const globalIdx = globalFirst + i;
      // x in CSS px: phase-based tiling, no inner modulo on position
      const x = (phase - spacing) + i * spacing;

      if (x < -2 || x > W + 2) continue;

      const isMajor = ((globalIdx % MAJOR_EVERY) + MAJOR_EVERY) % MAJOR_EVERY === 0;
      const notchH  = isMajor ? 20 : 10;
      const notchW  = isMajor ? 2.5 : 1.5;

      // Cylindrical depth: cos lighting — brighter at center
      const distN   = Math.abs(x - W / 2) / (W / 2);
      const depth   = Math.cos(Math.min(distN, 1) * Math.PI * 0.6);

      // Edge fade vignette
      const edgeA   = Math.min(1, Math.min(x / EDGE_FADE, (W - x) / EDGE_FADE));

      const alpha   = (isMajor ? (0.3 + depth * 0.7) : (0.06 + depth * 0.3)) * edgeA;
      if (alpha < 0.01) continue;

      const color   = isMajor ? accent : dimColor;

      ctx.save();
      ctx.globalAlpha = alpha;

      // Top tick — fades downward
      const gT = ctx.createLinearGradient(x, 0, x, notchH + 2);
      gT.addColorStop(0,   color);
      gT.addColorStop(0.6, color);
      gT.addColorStop(1,   'transparent');
      ctx.fillStyle = gT;
      ctx.fillRect(x - notchW / 2, 2, notchW, notchH);

      // Bottom tick — mirror, fades upward
      const gB = ctx.createLinearGradient(x, H, x, H - notchH - 2);
      gB.addColorStop(0,   color);
      gB.addColorStop(0.6, color);
      gB.addColorStop(1,   'transparent');
      ctx.fillStyle = gB;
      ctx.fillRect(x - notchW / 2, H - notchH - 2, notchW, notchH);

      ctx.restore();
    }

    // ── Edge vignettes ──
    const vL = ctx.createLinearGradient(0, 0, EDGE_FADE, 0);
    vL.addColorStop(0, 'rgba(7,9,14,0.95)');
    vL.addColorStop(1, 'rgba(7,9,14,0)');
    ctx.fillStyle = vL;
    ctx.fillRect(0, 0, EDGE_FADE, H);

    const vR = ctx.createLinearGradient(W - EDGE_FADE, 0, W, 0);
    vR.addColorStop(0, 'rgba(7,9,14,0)');
    vR.addColorStop(1, 'rgba(7,9,14,0.95)');
    ctx.fillStyle = vR;
    ctx.fillRect(W - EDGE_FADE, 0, EDGE_FADE, H);

    // ── Machined bevels ──
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(W, 0);
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth   = 1;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, H - 1); ctx.lineTo(W, H - 1);
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth   = 1;
    ctx.stroke();

    // ── Center index fiducial ──
    const cx = W / 2;
    const iy = (H - CENTER_MARK_H) / 2;

    ctx.save();
    ctx.shadowColor = accent;
    ctx.shadowBlur  = 10;
    const mGrad = ctx.createLinearGradient(cx, iy, cx, iy + CENTER_MARK_H);
    mGrad.addColorStop(0,   'transparent');
    mGrad.addColorStop(0.15, accent);
    mGrad.addColorStop(0.5,  accent);
    mGrad.addColorStop(0.85, accent);
    mGrad.addColorStop(1,   'transparent');
    ctx.fillStyle = mGrad;
    ctx.fillRect(cx - CENTER_MARK_W / 2, iy, CENTER_MARK_W, CENTER_MARK_H);
    ctx.restore();

    // Pointer triangle caps (top and bottom)
    ctx.save();
    ctx.fillStyle   = accent;
    ctx.shadowColor = accent;
    ctx.shadowBlur  = 5;
    ctx.beginPath();
    ctx.moveTo(cx - 5, 0); ctx.lineTo(cx + 5, 0); ctx.lineTo(cx, 8);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx - 5, H); ctx.lineTo(cx + 5, H); ctx.lineTo(cx, H - 8);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  };

  // ── rAF loop ─────────────────────────────────────────────────
  const tick = () => {
    if (!dragging && Math.abs(velocity) > MIN_VELOCITY) {
      angle    += velocity;
      velocity *= FRICTION;
      decode();
    }
    draw();
    animRef = requestAnimationFrame(tick);
  };

  // ── Pointer handlers ─────────────────────────────────────────
  const onPointerDown = (e: PointerEvent) => {
    dragging   = true;
    lastX      = e.clientX;
    lastDragDx = 0;
    velocity   = 0;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    const dx   = e.clientX - lastX;
    lastX      = e.clientX;
    lastDragDx = dx;

    // Convert px displacement → revolution delta
    const dAngle = dx / PX_PER_REV;
    angle += dAngle;
    decode();
    draw();
  };

  const onPointerUp = (_e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    // Launch momentum from last drag delta
    velocity = (lastDragDx / PX_PER_REV) * 0.7;
  };

  // If pointer leaves without a pointerup, end drag but preserve existing momentum.
  const onPointerLeave = (_e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    // Keep whatever velocity was built up — don't zero it out
    velocity = (lastDragDx / PX_PER_REV) * 0.7;
  };

  // ── Touch handlers (fallback for older iOS / Android) ────────
  // Modern browsers fire Pointer Events on touch too, but we add Touch
  // Events as belt-and-suspenders for full mobile coverage.
  // We guard against double-firing: if pointerdown already set dragging,
  // touchstart is a no-op (pointer events took precedence).
  let touchActive = false;

  const onTouchStart = (e: TouchEvent) => {
    if (dragging) return; // pointer events already handling it
    e.preventDefault();
    const t = e.changedTouches[0];
    touchActive = true;
    dragging    = true;
    lastX       = t.clientX;
    lastDragDx  = 0;
    velocity    = 0;
  };

  const onTouchMove = (e: TouchEvent) => {
    if (!touchActive) return;
    e.preventDefault();
    const t  = e.changedTouches[0];
    const dx = t.clientX - lastX;
    lastX      = t.clientX;
    lastDragDx = dx;

    const dAngle = dx / PX_PER_REV;
    angle += dAngle;
    decode();
    draw();
  };

  const onTouchEnd = (e: TouchEvent) => {
    if (!touchActive) return;
    touchActive = false;
    dragging    = false;
    velocity    = (lastDragDx / PX_PER_REV) * 0.7;
  };

  const onTouchCancel = (_e: TouchEvent) => {
    if (!touchActive) return;
    touchActive = false;
    dragging    = false;
    velocity    = (lastDragDx / PX_PER_REV) * 0.7;
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const step = store.tuningStep() > 0 ? store.tuningStep() : 100;
    // One scroll notch = 1 tuning step, shift = 10×
    const detents = -Math.sign(e.deltaY) * (e.shiftKey ? 10 : 1);
    const dAngle  = detents / NOTCHES_PER_REV;
    angle        += dAngle;
    velocity      = dAngle * 0.4;   // small momentum kick for feel
    // Fire directly — don't wait for decode() to catch up
    props.onTune(detents * step);
    lastDetent = Math.trunc(angle * NOTCHES_PER_REV);
    draw();
  };

  // ── Resize ───────────────────────────────────────────────────
  let resizeObs: ResizeObserver;

  const resize = () => {
    const canvas = canvasRef;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr  = window.devicePixelRatio || 1;
    canvas.width  = Math.round(rect.width  * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.scale(dpr, dpr);
    draw();
  };

  onMount(() => {
    resize();
    animRef = requestAnimationFrame(tick);
    if (canvasRef) {
      resizeObs = new ResizeObserver(resize);
      resizeObs.observe(canvasRef);
      canvasRef.addEventListener('pointerdown',   onPointerDown);
      canvasRef.addEventListener('pointermove',   onPointerMove);
      canvasRef.addEventListener('pointerup',     onPointerUp);
      canvasRef.addEventListener('pointercancel', onPointerLeave);
      canvasRef.addEventListener('pointerleave',  onPointerLeave);
      canvasRef.addEventListener('touchstart',    onTouchStart,  { passive: false });
      canvasRef.addEventListener('touchmove',     onTouchMove,   { passive: false });
      canvasRef.addEventListener('touchend',      onTouchEnd);
      canvasRef.addEventListener('touchcancel',   onTouchCancel);
      canvasRef.addEventListener('wheel', onWheel, { passive: false });
    }
  });

  onCleanup(() => {
    cancelAnimationFrame(animRef);
    if (resizeObs && canvasRef) resizeObs.unobserve(canvasRef);
    if (canvasRef) {
      canvasRef.removeEventListener('pointerdown',   onPointerDown);
      canvasRef.removeEventListener('pointermove',   onPointerMove);
      canvasRef.removeEventListener('pointerup',     onPointerUp);
      canvasRef.removeEventListener('pointercancel', onPointerLeave);
      canvasRef.removeEventListener('pointerleave',  onPointerLeave);
      canvasRef.removeEventListener('touchstart',    onTouchStart);
      canvasRef.removeEventListener('touchmove',     onTouchMove);
      canvasRef.removeEventListener('touchend',      onTouchEnd);
      canvasRef.removeEventListener('touchcancel',   onTouchCancel);
      canvasRef.removeEventListener('wheel', onWheel);
    }
  });

  return (
    <div class="tuning-dial-container">
      <div class="tuning-dial-housing">
        <span class="tuning-dial-label tuning-dial-label-left">◄</span>
        <canvas
          ref={canvasRef}
          class="tuning-dial-canvas"
          style={{ height: `${DRUM_HEIGHT}px`, cursor: 'ew-resize' }}
          title="Drag to tune · Scroll wheel · Shift = 10×"
        />
        <span class="tuning-dial-label tuning-dial-label-right">►</span>
      </div>
    </div>
  );
};

export default TuningDial;
