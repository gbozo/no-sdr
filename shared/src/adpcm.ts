// ============================================================
// node-sdr — IMA-ADPCM Codec
// ============================================================
// Standard IMA-ADPCM (Interactive Multimedia Association) codec.
// 4:1 compression: Int16 → 4-bit nibbles (2 samples per byte).
//
// Streaming-safe: state (predictor, stepIndex) persists across
// encode()/decode() calls. Call reset() on stream start/reconnect.
//
// Used for both IQ sub-band and FFT compression paths.
// Reference: OpenWebRX ImaAdpcmCodec (AGPL-3.0), public domain tables.
// ============================================================

/** IMA-ADPCM step index adjustment table (4-bit nibble → index delta) */
const INDEX_TABLE = new Int8Array([
  -1, -1, -1, -1, 2, 4, 6, 8,
  -1, -1, -1, -1, 2, 4, 6, 8,
]);

/** IMA-ADPCM step size table (89 entries, index 0–88) */
const STEP_TABLE = new Int32Array([
      7,    8,    9,   10,   11,   12,   13,   14,   16,   17,
     19,   21,   23,   25,   28,   31,   34,   37,   41,   45,
     50,   55,   60,   66,   73,   80,   88,   97,  107,  118,
    130,  143,  157,  173,  190,  209,  230,  253,  279,  307,
    337,  371,  408,  449,  494,  544,  598,  658,  724,  796,
    876,  963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
   2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
   5894, 6484, 7132, 7845, 8630, 9493,10442,11487,12635,13899,
  15289,16818,18500,20350,22385,24623,27086,29794,32767,
]);

// ---- Encoder (server-side) ----

/**
 * IMA-ADPCM streaming encoder.
 * Encodes Int16 PCM samples to 4-bit ADPCM nibbles (2:1 byte ratio).
 * State persists across encode() calls for seamless streaming.
 */
export class ImaAdpcmEncoder {
  private predictor = 0;
  private stepIndex = 0;

  /**
   * Encode Int16Array PCM → ADPCM nibbles.
   * If `out` is provided (must be length >= ceil(pcm.length/2)), writes into it
   * and returns a subarray view — zero allocation on the hot path.
   * If omitted, allocates a new Uint8Array (legacy behaviour).
   */
  encode(pcm: Int16Array, out?: Uint8Array): Uint8Array {
    const len = pcm.length;
    const outLen = Math.ceil(len / 2);
    const buf = out && out.length >= outLen ? out : new Uint8Array(outLen);

    for (let i = 0; i < len; i++) {
      const nibble = this.encodeNibble(pcm[i]);
      if (i & 1) {
        buf[i >> 1] |= (nibble << 4);
      } else {
        buf[i >> 1] = nibble & 0x0f;
      }
    }
    return out && out.length >= outLen ? buf.subarray(0, outLen) : buf;
  }

  /** Reset encoder state (call on stream start or reconnect) */
  reset(): void {
    this.predictor = 0;
    this.stepIndex = 0;
  }

  private encodeNibble(sample: number): number {
    const step = STEP_TABLE[this.stepIndex];
    let delta = sample - this.predictor;
    let nibble = 0;

    if (delta < 0) { nibble = 8; delta = -delta; }
    if (delta >= step)      { nibble |= 4; delta -= step; }
    if (delta >= step >> 1) { nibble |= 2; delta -= step >> 1; }
    if (delta >= step >> 2) { nibble |= 1; }

    // Reconstruct exactly what the decoder will produce (avoids drift)
    let diff = step >> 3;
    if (nibble & 1) diff += step >> 2;
    if (nibble & 2) diff += step >> 1;
    if (nibble & 4) diff += step;
    if (nibble & 8) diff = -diff;

    this.predictor = Math.max(-32768, Math.min(32767, this.predictor + diff));
    this.stepIndex = Math.max(0, Math.min(88, this.stepIndex + INDEX_TABLE[nibble & 0x0f]));

    return nibble;
  }
}

// ---- Decoder (client-side) ----

/**
 * IMA-ADPCM streaming decoder.
 * Decodes Uint8Array ADPCM nibbles → Int16Array PCM.
 * State persists across decode() calls for seamless streaming.
 */
export class ImaAdpcmDecoder {
  private predictor = 0;
  private stepIndex = 0;
  private step = STEP_TABLE[0];

  /**
   * Decode Uint8Array ADPCM → Int16Array PCM.
   * Output length = input.length * 2 (each byte contains 2 nibbles).
   */
  decode(adpcm: Uint8Array): Int16Array {
    const len = adpcm.length;
    const out = new Int16Array(len * 2);

    for (let i = 0; i < len; i++) {
      out[i * 2]     = this.decodeNibble(adpcm[i] & 0x0f);
      out[i * 2 + 1] = this.decodeNibble((adpcm[i] >> 4) & 0x0f);
    }
    return out;
  }

  /** Reset decoder state (call on stream start or reconnect) */
  reset(): void {
    this.predictor = 0;
    this.stepIndex = 0;
    this.step = STEP_TABLE[0];
  }

  private decodeNibble(nibble: number): number {
    this.stepIndex = Math.max(0, Math.min(88, this.stepIndex + INDEX_TABLE[nibble]));

    let diff = this.step >> 3;
    if (nibble & 1) diff += this.step >> 2;
    if (nibble & 2) diff += this.step >> 1;
    if (nibble & 4) diff += this.step;
    if (nibble & 8) diff = -diff;

    this.predictor = Math.max(-32768, Math.min(32767, this.predictor + diff));
    this.step = STEP_TABLE[this.stepIndex];
    return this.predictor;
  }
}

// ---- FFT ADPCM Helpers ----

// For FFT ADPCM compression, we follow the OpenWebRX approach:
// 1. Scale Float32 dB values to Int16 (dB × 100 for 0.01 dB resolution)
// 2. Prepend N warmup samples to prime the ADPCM predictor
// 3. Reset encoder per frame (stateless — no inter-frame dependency)
// 4. On decode, strip warmup samples and convert back to Float32

/** Number of warmup samples prepended to each FFT ADPCM frame */
export const FFT_ADPCM_PAD = 10;

/**
 * Encode an FFT frame (Float32 dB values) to ADPCM.
 * Returns Uint8Array of ADPCM nibbles. The encoder is reset per frame
 * (stateless). Warmup padding is prepended so the predictor converges
 * before the real data begins.
 *
 * Wire format:
 *   [4 bytes header: Int16 minDb + Int16 maxDb, LE]
 *   [ADPCM nibbles for (PAD + fftSize) Int16 samples]
 *
 * The Int16 samples are dB × 100 (e.g., -80.5 dB → -8050).
 */
// Module-level scratch buffers for encodeFftAdpcm — avoids 4 allocations per call.
// Safe: Node.js event loop is single-threaded; these are never used concurrently.
// Sized to max fftSize (65536) + padding.
const _fftAdpcmMaxSamples = 65536 + FFT_ADPCM_PAD;
const _fftAdpcmInt16Scratch = new Int16Array(_fftAdpcmMaxSamples);
// ADPCM output: ceil((totalSamples)/2) bytes + 4-byte header
const _fftAdpcmOutScratch = new Uint8Array(4 + Math.ceil(_fftAdpcmMaxSamples / 2));
// Per-frame ADPCM raw bytes scratch (encoder output before header prepend)
const _fftAdpcmEncodeScratch = new Uint8Array(Math.ceil(_fftAdpcmMaxSamples / 2));
// Singleton encoder — reset per frame, never re-constructed
const _fftAdpcmEncoder = new ImaAdpcmEncoder();

export function encodeFftAdpcm(
  fftData: Float32Array,
  minDb: number,
  maxDb: number,
): Uint8Array {
  const len = fftData.length;
  const totalSamples = FFT_ADPCM_PAD + len;

  // Use scratch buffers if data fits; fall back to fresh allocation for unusual sizes
  const int16Buf = totalSamples <= _fftAdpcmMaxSamples
    ? _fftAdpcmInt16Scratch.subarray(0, totalSamples)
    : new Int16Array(totalSamples);

  const firstVal = Math.max(-32768, Math.min(32767, Math.round(fftData[0] * 100)));
  for (let i = 0; i < FFT_ADPCM_PAD; i++) {
    int16Buf[i] = firstVal;
  }
  for (let i = 0; i < len; i++) {
    int16Buf[FFT_ADPCM_PAD + i] = Math.max(-32768, Math.min(32767, Math.round(fftData[i] * 100)));
  }

  const encoder = _fftAdpcmEncoder;
  encoder.reset();
  const adpcm = encoder.encode(int16Buf, _fftAdpcmEncodeScratch);

  // Write into scratch result buffer if it fits
  const resultLen = 4 + adpcm.length;
  const result = resultLen <= _fftAdpcmOutScratch.length
    ? _fftAdpcmOutScratch.subarray(0, resultLen)
    : new Uint8Array(resultLen);
  const headerView = new DataView(result.buffer, result.byteOffset, 4);
  headerView.setInt16(0, Math.round(minDb), true);
  headerView.setInt16(2, Math.round(maxDb), true);
  result.set(adpcm, 4);

  return result;
}

/**
 * Decode an ADPCM-encoded FFT frame back to Float32 dB values.
 * Decodes ADPCM nibbles directly to Float32 (÷100) without allocating
 * an intermediate Int16Array — eliminates ~128KB of GC pressure per frame
 * at 65536 FFT bins.
 *
 * @param payload The raw payload (after stripping the message type byte).
 *   Format: [4 bytes header] [ADPCM nibbles]
 * @returns Float32Array of dB values
 */
export function decodeFftAdpcm(payload: ArrayBuffer): Float32Array {
  const adpcm = new Uint8Array(payload, 4);
  const totalSamples = adpcm.length * 2;
  const fftLen = totalSamples - FFT_ADPCM_PAD;
  const fftData = new Float32Array(fftLen);

  // Decode ADPCM directly to Float32 — inline the decoder to avoid
  // creating an Int16Array intermediate. State matches ImaAdpcmDecoder.
  let predictor = 0;
  let stepIndex = 0;
  let step = STEP_TABLE[0];
  let sampleIdx = 0;

  for (let byteIdx = 0; byteIdx < adpcm.length; byteIdx++) {
    const byte = adpcm[byteIdx];

    // Low nibble first, then high nibble
    for (let nibblePos = 0; nibblePos < 2; nibblePos++) {
      const nibble = nibblePos === 0 ? (byte & 0x0f) : ((byte >> 4) & 0x0f);

      stepIndex = Math.max(0, Math.min(88, stepIndex + INDEX_TABLE[nibble]));

      let diff = step >> 3;
      if (nibble & 1) diff += step >> 2;
      if (nibble & 2) diff += step >> 1;
      if (nibble & 4) diff += step;
      if (nibble & 8) diff = -diff;

      predictor = Math.max(-32768, Math.min(32767, predictor + diff));
      step = STEP_TABLE[stepIndex];

      // Skip warmup padding, write directly as Float32 dB (÷100)
      if (sampleIdx >= FFT_ADPCM_PAD) {
        fftData[sampleIdx - FFT_ADPCM_PAD] = predictor / 100;
      }
      sampleIdx++;
    }
  }

  return fftData;
}
