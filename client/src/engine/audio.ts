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
  private initialized = false;
  private _loudnessEnabled = false;

  constructor() {}

  /**
   * Initialize the audio context. Must be called from a user gesture.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

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
    // panner → eqLow → eqLowMid → eqMid → eqHighMid → eqHigh → loudnessGain → compressor → gain → destination
    this.pannerNode.connect(this.eqLowNode);
    this.eqLowNode.connect(this.eqLowMidNode);
    this.eqLowMidNode.connect(this.eqMidNode);
    this.eqMidNode.connect(this.eqHighMidNode);
    this.eqHighMidNode.connect(this.eqHighNode);
    this.eqHighNode.connect(this.loudnessGainNode);
    this.loudnessGainNode.connect(this.compressorNode);
    this.compressorNode.connect(this.gainNode);
    this.gainNode.connect(this.audioCtx.destination);

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
          // Ring buffers: 3 seconds at 48kHz, separate L and R
          this.bufferLen = 48000 * 3;
          this.bufferL = new Float32Array(this.bufferLen);
          this.bufferR = new Float32Array(this.bufferLen);
          this.writePos = 0;
          this.readPos = 0;
          this.buffered = 0; // samples currently buffered (same for L and R)

          // Jitter buffer: don't start playing until we have this many samples.
          // 150ms provides headroom for variable IQ chunk sizes from the server.
          this.minBuffer = 7200; // 150ms at 48kHz
          // Target buffer level for adaptive rate control.
          // When playing, we aim to keep the buffer at this level (200ms).
          // If buffer drifts above/below, we subtly adjust playback rate
          // by skipping or duplicating one sample per render quantum.
          this.targetBuffer = 9600; // 200ms at 48kHz
          this.playing = false;

          // Underrun detection
          this.underruns = 0;

          this.port.onmessage = (e) => {
            if (e.data === 'reset') {
              // Flush buffer on frequency/mode change
              this.writePos = 0;
              this.readPos = 0;
              this.buffered = 0;
              this.playing = false;
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
            this.playing = false;
            this.underruns++;
            return true;
          }

          // Adaptive rate control: adjust consumption rate to keep buffer
          // near the target level. This prevents both underruns and overflow
          // from clock drift or variable chunk timing.
          // - Buffer too full (>300ms): consume one extra sample (speed up ~0.8%)
          // - Buffer too low (<100ms): consume one fewer sample (slow down ~0.8%)
          // - Otherwise: consume exactly len samples (normal rate)
          let consume = len;
          if (this.buffered > this.targetBuffer + 4800) {
            // Buffer growing too large — consume 1 extra to drain
            consume = len + 1;
          } else if (this.buffered < this.minBuffer && this.buffered >= len) {
            // Buffer getting dangerously low — consume 1 fewer to build up
            consume = len - 1;
          }

          // Ensure we have enough samples
          if (this.buffered < consume) consume = this.buffered;

          // Read samples from ring buffer with simple rate adaptation.
          // When consume != len, we use nearest-neighbor resampling
          // (imperceptible at ±1 sample per 128).
          for (let i = 0; i < len; i++) {
            // Map output sample index to input sample index
            const srcIdx = Math.min(Math.round(i * consume / len), consume - 1);
            const pos = (this.readPos + srcIdx) % this.bufferLen;
            outL[i] = this.bufferL[pos];
            if (outR) outR[i] = this.bufferR[pos];
          }
          this.readPos = (this.readPos + consume) % this.bufferLen;
          this.buffered -= consume;

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
    if (!this.workletNode) return;

    // Convert Int16 to Float32
    const float32 = new Float32Array(int16Data.length);
    for (let i = 0; i < int16Data.length; i++) {
      float32[i] = int16Data[i] / 32768;
    }

    // Mono → duplicated to both channels by worklet
    this.workletNode.port.postMessage({ left: float32 });
  }

  /**
   * Push mono Float32 audio data from client-side demodulator
   */
  pushDemodulatedAudio(float32Data: Float32Array): void {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({ left: float32Data });
  }

  /**
   * Push stereo Float32 audio data from client-side demodulator (e.g., WFM stereo)
   */
  pushStereoAudio(left: Float32Array, right: Float32Array): void {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({ left, right });
  }

  /**
   * Reset the audio buffer (call on frequency/mode change to flush stale data)
   */
  resetBuffer(): void {
    if (this.workletNode) {
      this.workletNode.port.postMessage('reset');
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
    this.audioCtx?.close();
    this.initialized = false;
  }
}
