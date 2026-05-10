// ============================================================
// node-sdr — Audio Engine (Web Audio API + AudioWorklet)
// ============================================================
// Plays raw PCM audio from client-side demodulators.
// Uses AudioWorklet for zero-latency playback.
// Supports both mono and stereo output (for FM stereo).
//
// Audio graph:
//   WorkletNode → StereoPanner (balance) → EQ Low (lowshelf)
//     → EQ Mid (peaking) → EQ High (highshelf)
//     → Compressor (loudness) → GainNode (volume) → destination
// ============================================================

export class AudioEngine {
  private audioCtx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private pannerNode: StereoPannerNode | null = null;
  private eqLowNode: BiquadFilterNode | null = null;
  private eqLowMidNode: BiquadFilterNode | null = null;
  private eqMidNode: BiquadFilterNode | null = null;
  private eqHighMidNode: BiquadFilterNode | null = null;
  private eqHighNode: BiquadFilterNode | null = null;
  private compressorNode: DynamicsCompressorNode | null = null;
  private loudnessGainNode: GainNode | null = null; // pre-compressor boost for loudness
  private analyserNode: AnalyserNode | null = null;
  // Per-channel analysers for L/R VU meter — fed by a ChannelSplitterNode after gainNode
  private splitterNode: ChannelSplitterNode | null = null;
  private analyserNodeL: AnalyserNode | null = null;
  private analyserNodeR: AnalyserNode | null = null;
  private initialized = false;
  private _loudnessEnabled = false;

  // Standalone capture ring — filled by every push call regardless of worklet/AudioContext state.
  // 12s × 48kHz = 576 000 samples. Never decremented by playback.
  private static readonly CAPTURE_CAP = 48000 * 12;
  private captureRing = new Float32Array(AudioEngine.CAPTURE_CAP);
  private capturePos = 0;   // next write position
  private captureLen = 0;   // total samples written, capped at CAPTURE_CAP

  constructor() {}

  /**
   * Initialize the audio context. Must be called from a user gesture.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // AudioWorklet requires a secure context (HTTPS or localhost).
    // On plain HTTP over the network, audioCtx.audioWorklet is undefined.
    if (!window.isSecureContext) {
      throw new Error(
        'Audio requires a secure context (HTTPS or localhost). ' +
        'Access the app via HTTPS or set up a reverse proxy with TLS.'
      );
    }

    this.audioCtx = new AudioContext({
      sampleRate: 48000,
    });

    // ---- Create audio nodes ----

    // Volume (master gain, last in chain before destination)
    this.gainNode = this.audioCtx.createGain();

    // Stereo balance (pan)
    this.pannerNode = this.audioCtx.createStereoPanner();
    this.pannerNode.pan.value = 0; // center

    // 5-band EQ
    this.eqLowNode = this.audioCtx.createBiquadFilter();
    this.eqLowNode.type = 'lowshelf';
    this.eqLowNode.frequency.value = 80; // Hz
    this.eqLowNode.gain.value = 0;

    this.eqLowMidNode = this.audioCtx.createBiquadFilter();
    this.eqLowMidNode.type = 'peaking';
    this.eqLowMidNode.frequency.value = 500; // Hz
    this.eqLowMidNode.Q.value = 1.0;
    this.eqLowMidNode.gain.value = 0;

    this.eqMidNode = this.audioCtx.createBiquadFilter();
    this.eqMidNode.type = 'peaking';
    this.eqMidNode.frequency.value = 1500; // Hz
    this.eqMidNode.Q.value = 1.0;
    this.eqMidNode.gain.value = 0;

    this.eqHighMidNode = this.audioCtx.createBiquadFilter();
    this.eqHighMidNode.type = 'peaking';
    this.eqHighMidNode.frequency.value = 4000; // Hz
    this.eqHighMidNode.Q.value = 1.0;
    this.eqHighMidNode.gain.value = 0;

    this.eqHighNode = this.audioCtx.createBiquadFilter();
    this.eqHighNode.type = 'highshelf';
    this.eqHighNode.frequency.value = 12000; // Hz
    this.eqHighNode.gain.value = 0;

    // Loudness: pre-boost gain + compressor
    // When loudness is OFF, compressor has no effect (high threshold)
    // When loudness is ON, compressor squashes dynamics and boost lifts quiet parts
    this.loudnessGainNode = this.audioCtx.createGain();
    this.loudnessGainNode.gain.value = 1.0;

    this.compressorNode = this.audioCtx.createDynamicsCompressor();
    // Default: inactive (very high threshold = no compression)
    this.compressorNode.threshold.value = 0;
    this.compressorNode.knee.value = 40;
    this.compressorNode.ratio.value = 1;
    this.compressorNode.attack.value = 0.003;
    this.compressorNode.release.value = 0.25;

    // ---- Connect the audio graph ----
    // panner → eqLow → eqLowMid → eqMid → eqHighMid → eqHigh → loudnessGain → compressor → gain → analyser → destination
    this.pannerNode.connect(this.eqLowNode);
    this.eqLowNode.connect(this.eqLowMidNode);
    this.eqLowMidNode.connect(this.eqMidNode);
    this.eqMidNode.connect(this.eqHighMidNode);
    this.eqHighMidNode.connect(this.eqHighNode);
    this.eqHighNode.connect(this.loudnessGainNode);
    this.loudnessGainNode.connect(this.compressorNode);
    this.compressorNode.connect(this.gainNode);

    // Analyser taps the final output for the spectrum display
    this.analyserNode = this.audioCtx.createAnalyser();
    this.analyserNode.fftSize = 64;          // 32 bins — we use 16 of them
    this.analyserNode.smoothingTimeConstant = 0.75;
    this.gainNode.connect(this.analyserNode);
    this.gainNode.connect(this.audioCtx.destination);

    // Per-channel L/R analysers for VU meter
    // ChannelSplitter splits stereo gainNode output into separate mono streams
    this.splitterNode = this.audioCtx.createChannelSplitter(2);
    this.analyserNodeL = this.audioCtx.createAnalyser();
    this.analyserNodeL.fftSize = 1024;
    this.analyserNodeL.smoothingTimeConstant = 0.0; // raw, no smoothing — VU uses RMS over window
    this.analyserNodeR = this.audioCtx.createAnalyser();
    this.analyserNodeR.fftSize = 1024;
    this.analyserNodeR.smoothingTimeConstant = 0.0;
    this.gainNode.connect(this.splitterNode);
    this.splitterNode.connect(this.analyserNodeL, 0); // channel 0 = Left
    this.splitterNode.connect(this.analyserNodeR, 1); // channel 1 = Right

    // Register the audio worklet processor with stereo support.
    // Uses a jitter buffer: accumulates samples before starting playback,
    // and smoothly handles underruns/overruns to avoid clicks.
    //
    // Message protocol:
    //   'reset'                          → flush buffer
    //   { left: Float32Array }           → mono (duplicated to both channels)
    //   { left: Float32Array, right: Float32Array } → stereo
    //   Float32Array                     → mono (legacy, duplicated to both)
    const processorCode = `
      class SdrAudioProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          // Ring buffers: 12 seconds at 48kHz, separate L and R.
          // 12s matches the server-side Opus PCM ring so ADPCM/none and Opus paths
          // both have the same capture window for music identification.
          this.bufferLen = 48000 * 12;
          this.bufferL = new Float32Array(this.bufferLen);
          this.bufferR = new Float32Array(this.bufferLen);
          this.writePos = 0;
          this.readPos = 0;
          this.buffered = 0;

          // Jitter buffer: don't start playing until we have this many samples.
          // 200ms provides headroom for variable IQ chunk sizes and Opus 60ms frames.
          this.minBuffer = 9600; // 200ms at 48kHz
          // Target buffer level for adaptive rate control.
          // The proportional controller always nudges toward this level.
          this.targetBuffer = 9600; // 200ms at 48kHz
          this.playing = false;

          // Fade-in state: ramp from 0 to 1 over fadeInLen samples after playback starts
          this.fadeInRemaining = 0;
          this.fadeInLen = 64; // ~1.3ms ramp — eliminates pop on playback resume

          // Underrun detection
          this.underruns = 0;
          // Consecutive underrun counter — only reset playing after 3 in a row
          // to avoid a 200ms silence gap from a single late IQ chunk
          this.consecutiveUnderruns = 0;

          // Proportional controller gain for drift correction.
          // Higher = faster response but more jitter; lower = smoother but slower.
          // 0.002 means: for every 1% deviation from target, adjust by ~0.26 samples/quantum.
          this.driftGain = 0.002;
          // Maximum samples to add/subtract per quantum (caps correction rate at ~1.5%)
          this.maxCorrection = 2;

          this.port.onmessage = (e) => {
            if (e.data === 'reset') {
              // Flush buffer on frequency/mode change
              this.writePos = 0;
              this.readPos = 0;
              this.buffered = 0;
              this.playing = false;
              this.consecutiveUnderruns = 0;
              this.fadeInRemaining = 0;
              return;
            }

            let left, right;

            if (e.data instanceof Float32Array) {
              // Legacy mono path: Float32Array directly
              left = e.data;
              right = e.data;
            } else if (e.data && e.data.left) {
              // New path: { left, right? }
              left = e.data.left;
              right = e.data.right || e.data.left; // fallback to mono
            } else {
              return;
            }

            const len = left.length;

            // Check for overflow (buffer full) — drop oldest data
            if (this.buffered + len > this.bufferLen - 128) {
              const drop = len + 4800; // drop an extra 100ms to avoid repeated overflow
              this.readPos = (this.readPos + drop) % this.bufferLen;
              this.buffered = Math.max(0, this.buffered - drop);
            }

            // Write samples into ring buffers
            for (let i = 0; i < len; i++) {
              this.bufferL[this.writePos] = left[i];
              this.bufferR[this.writePos] = right[i];
              this.writePos = (this.writePos + 1) % this.bufferLen;
            }
            this.buffered += len;
          };
        }

        process(inputs, outputs) {
          const outL = outputs[0][0];
          const outR = outputs[0][1];
          if (!outL) return true;
          const len = outL.length; // typically 128

          // Wait for minimum buffer before starting playback
          if (!this.playing) {
            if (this.buffered >= this.minBuffer) {
              this.playing = true;
              // Arm fade-in to prevent pop when transitioning from silence
              this.fadeInRemaining = this.fadeInLen;
            } else {
              // Silence while buffering
              outL.fill(0);
              if (outR) outR.fill(0);
              return true;
            }
          }

          // Check for underrun
          if (this.buffered < len) {
            outL.fill(0);
            if (outR) outR.fill(0);
            this.underruns++;
            this.consecutiveUnderruns++;
            // Only drop back to re-fill mode after 3 consecutive underruns
            // (i.e. ~8ms of silence). A single late IQ chunk must not cause
            // a 200ms hard rebuffer — that produces the audible pop/click.
            if (this.consecutiveUnderruns >= 3) {
              this.playing = false;
              this.consecutiveUnderruns = 0;
            }
            return true;
          }
          // Underrun resolved — reset counter
          this.consecutiveUnderruns = 0;

          // ---- Continuous proportional drift correction ----
          // Instead of a dead-zone threshold, always nudge toward targetBuffer.
          // This prevents drift from accumulating silently and then causing a
          // sudden correction glitch every 10-30 seconds.
          const error = (this.buffered - this.targetBuffer) / this.targetBuffer;
          const rawCorrection = error * this.driftGain * len;
          const correction = Math.max(-this.maxCorrection, Math.min(this.maxCorrection, rawCorrection));
          let consume = len + Math.round(correction);

          // Safety: ensure consume is at least 1 and doesn't exceed available
          if (consume < 1) consume = 1;
          if (consume > this.buffered) consume = this.buffered;

          // ---- Read samples with linear interpolation for rate adjustment ----
          // When consume != len, we resample using linear interpolation.
          // This produces a smooth sub-sample correction without discontinuities.
          if (consume === len) {
            // Fast path: 1:1 copy, no resampling needed
            for (let i = 0; i < len; i++) {
              const pos = (this.readPos + i) % this.bufferLen;
              outL[i] = this.bufferL[pos];
              if (outR) outR[i] = this.bufferR[pos];
            }
          } else {
            // Linear interpolation resampling
            const ratio = consume / len;
            for (let i = 0; i < len; i++) {
              const srcF = i * ratio; // fractional source index
              const srcI = Math.floor(srcF);
              const frac = srcF - srcI;

              const idx0 = (this.readPos + Math.min(srcI, consume - 1)) % this.bufferLen;
              const idx1 = (this.readPos + Math.min(srcI + 1, consume - 1)) % this.bufferLen;

              outL[i] = this.bufferL[idx0] * (1 - frac) + this.bufferL[idx1] * frac;
              if (outR) outR[i] = this.bufferR[idx0] * (1 - frac) + this.bufferR[idx1] * frac;
            }
          }
          this.readPos = (this.readPos + consume) % this.bufferLen;
          this.buffered -= consume;

          // ---- Fade-in ramp after playback resume (prevents pop) ----
          if (this.fadeInRemaining > 0) {
            const startGain = 1.0 - (this.fadeInRemaining / this.fadeInLen);
            for (let i = 0; i < len && this.fadeInRemaining > 0; i++) {
              const gain = startGain + (i + 1) / this.fadeInLen;
              const g = Math.min(1.0, gain);
              outL[i] *= g;
              if (outR) outR[i] *= g;
              this.fadeInRemaining--;
            }
          }

          return true;
        }
      }
      registerProcessor('sdr-audio', SdrAudioProcessor);
    `;

    const blob = new Blob([processorCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);

    try {
      await this.audioCtx.audioWorklet.addModule(url);
      this.workletNode = new AudioWorkletNode(this.audioCtx, 'sdr-audio', {
        outputChannelCount: [2], // stereo output
      });
      // Worklet feeds into the processing chain (starts at panner)
      this.workletNode.connect(this.pannerNode);
      this.initialized = true;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Push Int16 PCM audio data from the WebSocket (server-side demodulated)
   */
  pushAudio(int16Data: Int16Array): void {
    // Convert Int16 to Float32
    const float32 = new Float32Array(int16Data.length);
    for (let i = 0; i < int16Data.length; i++) {
      float32[i] = int16Data[i] / 32768;
    }
    this.writeCaptureRing(float32);
    if (!this.workletNode) return;
    // Mono → duplicated to both channels by worklet
    // Transfer ownership to worklet thread (zero-copy, reduces GC pressure)
    this.workletNode.port.postMessage({ left: float32 }, [float32.buffer]);
  }

  /**
   * Push mono Float32 audio data from client-side demodulator
   */
  pushDemodulatedAudio(float32Data: Float32Array): void {
    this.writeCaptureRing(float32Data);
    if (!this.workletNode) return;
    // Copy to a fresh buffer for transfer — the source may be a subarray of a
    // reusable pre-allocated buffer that must not be detached.
    const copy = new Float32Array(float32Data.length);
    for (let i = 0; i < float32Data.length; i++) {
      const v = float32Data[i];
      // Sanitize: clamp and replace NaN/Infinity to prevent biquad instability
      copy[i] = (v !== v || v === Infinity || v === -Infinity) ? 0
        : v > 1.0 ? 1.0 : v < -1.0 ? -1.0 : v;
    }
    // Transfer ownership to worklet thread (zero-copy)
    this.workletNode.port.postMessage({ left: copy }, [copy.buffer]);
  }

  /**
   * Push stereo Float32 audio data from client-side demodulator (e.g., WFM stereo)
   */
  pushStereoAudio(left: Float32Array, right: Float32Array): void {
    // Capture mono downmix (L+R)*0.5 into the capture ring
    const mono = new Float32Array(left.length);
    for (let i = 0; i < left.length; i++) mono[i] = (left[i] + right[i]) * 0.5;
    this.writeCaptureRing(mono);
    if (!this.workletNode) return;
    // Copy to fresh buffers for transfer — sources may be subarrays of reusable
    // pre-allocated demodulator buffers that must not be detached.
    const leftCopy = new Float32Array(left.length);
    const rightCopy = new Float32Array(right.length);
    for (let i = 0; i < left.length; i++) {
      const v = left[i];
      leftCopy[i] = (v !== v || v === Infinity || v === -Infinity) ? 0
        : v > 1.0 ? 1.0 : v < -1.0 ? -1.0 : v;
    }
    for (let i = 0; i < right.length; i++) {
      const v = right[i];
      rightCopy[i] = (v !== v || v === Infinity || v === -Infinity) ? 0
        : v > 1.0 ? 1.0 : v < -1.0 ? -1.0 : v;
    }
    // Transfer ownership to worklet thread (zero-copy)
    this.workletNode.port.postMessage({ left: leftCopy, right: rightCopy }, [leftCopy.buffer, rightCopy.buffer]);
  }

  /**
   * Reset the audio buffer (call on frequency/mode change to flush stale data)
   */
  resetBuffer(): void {
    // Flush the capture ring so identify doesn't see audio from the old frequency
    this.capturePos = 0;
    this.captureLen = 0;
    if (this.workletNode) {
      this.workletNode.port.postMessage('reset');
    }
  }

  /**
   * Capture the last `secs` seconds of audio from the standalone ring buffer.
   * Works regardless of whether the Web Audio context / worklet is active.
   * Returns a mono Float32Array at 48kHz, or null if nothing has been buffered yet.
   */
  captureAudio(secs = 10): Promise<Float32Array | null> {
    const cap = AudioEngine.CAPTURE_CAP;
    const want = Math.min(secs * 48000, this.captureLen, cap);
    if (want === 0) return Promise.resolve(null);
    const out = new Float32Array(want);
    const startPos = (this.capturePos - want + cap) % cap;
    for (let i = 0; i < want; i++) {
      out[i] = this.captureRing[(startPos + i) % cap];
    }
    return Promise.resolve(out);
  }

  /** Write mono samples into the standalone capture ring. */
  private writeCaptureRing(samples: Float32Array): void {
    const cap = AudioEngine.CAPTURE_CAP;
    for (let i = 0; i < samples.length; i++) {
      this.captureRing[this.capturePos] = samples[i];
      this.capturePos = (this.capturePos + 1) % cap;
    }
    if (this.captureLen < cap) {
      this.captureLen = Math.min(this.captureLen + samples.length, cap);
    }
  }

  /**
   * Set volume (0.0 - 1.0)
   */
  setVolume(volume: number): void {
    if (this.gainNode && this.audioCtx) {
      this.gainNode.gain.setValueAtTime(
        Math.max(0, Math.min(1, volume)),
        this.audioCtx.currentTime,
      );
    }
  }

  /**
   * Mute / unmute
   */
  setMuted(muted: boolean): void {
    if (this.gainNode && this.audioCtx) {
      this.gainNode.gain.setValueAtTime(
        muted ? 0 : 1,
        this.audioCtx.currentTime,
      );
    }
  }

  /**
   * Set stereo balance (-1.0 = full left, 0 = center, +1.0 = full right)
   */
  setBalance(value: number): void {
    if (this.pannerNode && this.audioCtx) {
      const clamped = Math.max(-1, Math.min(1, value));
      this.pannerNode.pan.setValueAtTime(clamped, this.audioCtx.currentTime);
    }
  }

  /**
   * Set 5-band equalizer gains (in dB, typically -12 to +12)
   */
  setEqLow(dB: number): void {
    if (this.eqLowNode && this.audioCtx) {
      this.eqLowNode.gain.setValueAtTime(
        Math.max(-12, Math.min(12, dB)),
        this.audioCtx.currentTime,
      );
    }
  }

  setEqLowMid(dB: number): void {
    if (this.eqLowMidNode && this.audioCtx) {
      this.eqLowMidNode.gain.setValueAtTime(
        Math.max(-12, Math.min(12, dB)),
        this.audioCtx.currentTime,
      );
    }
  }

  setEqMid(dB: number): void {
    if (this.eqMidNode && this.audioCtx) {
      this.eqMidNode.gain.setValueAtTime(
        Math.max(-12, Math.min(12, dB)),
        this.audioCtx.currentTime,
      );
    }
  }

  setEqHighMid(dB: number): void {
    if (this.eqHighMidNode && this.audioCtx) {
      this.eqHighMidNode.gain.setValueAtTime(
        Math.max(-12, Math.min(12, dB)),
        this.audioCtx.currentTime,
      );
    }
  }

  setEqHigh(dB: number): void {
    if (this.eqHighNode && this.audioCtx) {
      this.eqHighNode.gain.setValueAtTime(
        Math.max(-12, Math.min(12, dB)),
        this.audioCtx.currentTime,
      );
    }
  }

  /**
   * Enable/disable loudness enhancement.
   * When ON: applies dynamic compression + bass/treble boost to make
   * quiet signals more audible and flatten volume peaks.
   * When OFF: compressor is effectively bypassed (ratio=1, threshold=0).
   */
  setLoudness(enabled: boolean): void {
    this._loudnessEnabled = enabled;
    if (!this.compressorNode || !this.loudnessGainNode || !this.audioCtx) return;

    const t = this.audioCtx.currentTime;

    if (enabled) {
      // Aggressive compression: squash dynamic range
      this.compressorNode.threshold.setValueAtTime(-30, t);
      this.compressorNode.knee.setValueAtTime(10, t);
      this.compressorNode.ratio.setValueAtTime(8, t);
      this.compressorNode.attack.setValueAtTime(0.003, t);
      this.compressorNode.release.setValueAtTime(0.15, t);
      // Pre-boost to drive signals into the compressor
      this.loudnessGainNode.gain.setValueAtTime(1.8, t); // ~5 dB
    } else {
      // Bypass: no compression
      this.compressorNode.threshold.setValueAtTime(0, t);
      this.compressorNode.knee.setValueAtTime(40, t);
      this.compressorNode.ratio.setValueAtTime(1, t);
      this.compressorNode.attack.setValueAtTime(0.003, t);
      this.compressorNode.release.setValueAtTime(0.25, t);
      // No pre-boost
      this.loudnessGainNode.gain.setValueAtTime(1.0, t);
    }
  }

  /**
   * Get whether loudness is currently enabled
   */
  get loudnessEnabled(): boolean {
    return this._loudnessEnabled;
  }

  /**
   * Resume audio context (needed after user gesture)
   */
  async resume(): Promise<void> {
    if (this.audioCtx?.state === 'suspended') {
      await this.audioCtx.resume();
    }
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyserNode;
  }

  /** Returns [leftAnalyser, rightAnalyser] for per-channel VU metering. Both null until initialized. */
  getAnalysersLR(): [AnalyserNode | null, AnalyserNode | null] {
    return [this.analyserNodeL, this.analyserNodeR];
  }

  getCompressor(): DynamicsCompressorNode | null {
    return this.compressorNode;
  }

  /**
   * Clean up
   */
  destroy(): void {
    this.workletNode?.disconnect();
    this.pannerNode?.disconnect();
    this.eqLowNode?.disconnect();
    this.eqLowMidNode?.disconnect();
    this.eqMidNode?.disconnect();
    this.eqHighMidNode?.disconnect();
    this.eqHighNode?.disconnect();
    this.loudnessGainNode?.disconnect();
    this.compressorNode?.disconnect();
    this.gainNode?.disconnect();
    this.splitterNode?.disconnect();
    this.audioCtx?.close();
    this.initialized = false;
  }
}
