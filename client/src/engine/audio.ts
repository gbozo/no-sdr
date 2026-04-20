// ============================================================
// node-sdr — Audio Engine (Web Audio API + AudioWorklet)
// ============================================================
// Plays raw PCM Int16 audio from the WebSocket.
// Uses AudioWorklet for zero-latency playback.
// ============================================================

export class AudioEngine {
  private audioCtx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private initialized = false;

  // Ring buffer for audio samples (circular buffer)
  private buffer: Float32Array;
  private writePos = 0;
  private readPos = 0;
  private bufferSize = 48000 * 2; // 2 seconds at 48kHz

  constructor() {
    this.buffer = new Float32Array(this.bufferSize);
  }

  /**
   * Initialize the audio context. Must be called from a user gesture.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    this.audioCtx = new AudioContext({ sampleRate: 48000 });
    this.gainNode = this.audioCtx.createGain();
    this.gainNode.connect(this.audioCtx.destination);

    // Register the audio worklet processor
    const processorCode = `
      class SdrAudioProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.buffer = new Float32Array(48000 * 2);
          this.writePos = 0;
          this.readPos = 0;
          this.bufferLen = this.buffer.length;

          this.port.onmessage = (e) => {
            const samples = e.data;
            for (let i = 0; i < samples.length; i++) {
              this.buffer[this.writePos] = samples[i];
              this.writePos = (this.writePos + 1) % this.bufferLen;
            }
          };
        }

        process(inputs, outputs) {
          const output = outputs[0][0];
          if (!output) return true;

          for (let i = 0; i < output.length; i++) {
            if (this.readPos !== this.writePos) {
              output[i] = this.buffer[this.readPos];
              this.readPos = (this.readPos + 1) % this.bufferLen;
            } else {
              output[i] = 0; // underrun — silence
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
      this.workletNode = new AudioWorkletNode(this.audioCtx, 'sdr-audio');
      this.workletNode.connect(this.gainNode);
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

    // Transfer to audio worklet
    this.workletNode.port.postMessage(float32);
  }

  /**
   * Push Float32 audio data from client-side demodulator
   */
  pushDemodulatedAudio(float32Data: Float32Array): void {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage(float32Data);
  }

  /**
   * Set volume (0.0 - 1.0)
   */
  setVolume(volume: number): void {
    if (this.gainNode) {
      this.gainNode.gain.setValueAtTime(
        Math.max(0, Math.min(1, volume)),
        this.audioCtx!.currentTime,
      );
    }
  }

  /**
   * Mute / unmute
   */
  setMuted(muted: boolean): void {
    if (this.gainNode) {
      this.gainNode.gain.setValueAtTime(
        muted ? 0 : 1,
        this.audioCtx!.currentTime,
      );
    }
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
    this.gainNode?.disconnect();
    this.audioCtx?.close();
    this.initialized = false;
  }
}
