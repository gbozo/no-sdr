// ============================================================
// no-sdr-vbr-codec — Variable Bit Rate IQ Codec
// ============================================================
//
// Public-domain DSP building blocks:
//   1. A-law companding — resync/fallback (guaranteed 2:1)
//   2. LMS adaptive predictor (order 16) — exploits temporal
//      correlation in narrowband IQ
//   3. Golomb-Rice entropy coding — variable-length codes for
//      prediction residuals
//
// Block-based: 128 IQ pairs (256 Int16 values) per block.
// Per-block G parameter (1–5) auto-selected for VBR.
// Separate I/Q predictor state for proper complex signal tracking.
//
// Wire format per block:
//   [1 byte header: type(1 bit) + G(3 bits) + reserved(4 bits)]
//   [variable-length Golomb-Rice encoded residuals]
//   -or-
//   [0x80 header byte] [256 bytes A-law encoded samples]
//
// This codec is original work using standard public-domain
// algorithms. No proprietary code was referenced or copied.
//
// License: MIT (same as node-sdr)
// ============================================================

// ---- A-law Companding (ITU-T G.711) ----

/** A-law encode: Int16 → Uint8 (one sample) */
function alawEncode(sample: number): number {
  // Clamp to Int16 range
  let s = Math.max(-32768, Math.min(32767, sample));
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;

  let exponent = 0;
  let mantissa: number;

  if (s < 256) {
    // Linear region
    mantissa = (s >> 4) & 0x0f;
    exponent = 0;
  } else {
    // Logarithmic region
    let shifted = s >> 4;
    for (exponent = 1; exponent < 8; exponent++) {
      shifted >>= 1;
      if (shifted <= 0x1f) break;
    }
    mantissa = (s >> (exponent + 3)) & 0x0f;
  }

  const encoded = sign | (exponent << 4) | mantissa;
  return encoded ^ 0x55; // XOR with 0x55 per A-law spec
}

/** A-law decode: Uint8 → Int16 (one sample) */
function alawDecode(alaw: number): number {
  let val = alaw ^ 0x55;
  const sign = val & 0x80;
  const exponent = (val >> 4) & 0x07;
  const mantissa = val & 0x0f;

  let sample: number;
  if (exponent === 0) {
    sample = (mantissa << 4) | 0x08;
  } else {
    sample = ((mantissa << 4) | 0x08) << exponent;
    // The A-law decode adds a bias of (1 << (exponent + 2))
    // This is already handled by the shift above
  }

  return sign ? -sample : sample;
}

// ---- Bitstream Writer/Reader ----

/** Writes bits MSB-first into a growable byte buffer */
class BitstreamWriter {
  private buffer: number[] = [];
  private currentByte = 0;
  private bitPos = 7; // MSB-first: 7 down to 0

  /** Write n bits (value's LSB-first n bits, written MSB-first) */
  writeBits(value: number, n: number): void {
    for (let i = n - 1; i >= 0; i--) {
      if (value & (1 << i)) {
        this.currentByte |= (1 << this.bitPos);
      }
      this.bitPos--;
      if (this.bitPos < 0) {
        this.buffer.push(this.currentByte);
        this.currentByte = 0;
        this.bitPos = 7;
      }
    }
  }

  /** Write a single bit (0 or 1) */
  writeBit(bit: number): void {
    if (bit) this.currentByte |= (1 << this.bitPos);
    this.bitPos--;
    if (this.bitPos < 0) {
      this.buffer.push(this.currentByte);
      this.currentByte = 0;
      this.bitPos = 7;
    }
  }

  /** Flush remaining bits (zero-padded) and return the byte array */
  finish(): Uint8Array {
    if (this.bitPos < 7) {
      this.buffer.push(this.currentByte);
    }
    return new Uint8Array(this.buffer);
  }

  /** Current size in bytes (including partial) */
  get byteLength(): number {
    return this.buffer.length + (this.bitPos < 7 ? 1 : 0);
  }
}

/** Reads bits MSB-first from a Uint8Array */
class BitstreamReader {
  private data: Uint8Array;
  private byteIdx = 0;
  private bitPos = 7;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  /** Read a single bit (0 or 1) */
  readBit(): number {
    if (this.byteIdx >= this.data.length) return 0;
    const bit = (this.data[this.byteIdx] >> this.bitPos) & 1;
    this.bitPos--;
    if (this.bitPos < 0) {
      this.byteIdx++;
      this.bitPos = 7;
    }
    return bit;
  }

  /** Read n bits, MSB-first, return as integer */
  readBits(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i++) {
      value = (value << 1) | this.readBit();
    }
    return value;
  }

  /** Check if there are bits remaining */
  get hasMore(): boolean {
    return this.byteIdx < this.data.length;
  }
}

// ---- Golomb-Rice Coding ----

/**
 * Golomb-Rice encode a signed integer with parameter G.
 * Signed values are mapped to unsigned via interleaving:
 *   0 → 0, -1 → 1, 1 → 2, -2 → 3, 2 → 4, ...
 * Then encoded as: unary(quotient) + binary(remainder, G bits)
 */
function golombRiceEncode(writer: BitstreamWriter, value: number, g: number): void {
  // Signed → unsigned zigzag mapping
  const unsigned = value >= 0 ? value * 2 : (-value) * 2 - 1;

  const quotient = unsigned >> g;
  const remainder = unsigned & ((1 << g) - 1);

  // Unary coding of quotient: quotient ones followed by a zero
  // Cap at 15 to prevent runaway on outliers
  const cappedQ = Math.min(quotient, 15);
  for (let i = 0; i < cappedQ; i++) {
    writer.writeBit(1);
  }
  writer.writeBit(0); // terminator

  // If quotient was capped, write the overflow in a fixed 16-bit field
  if (quotient > 15) {
    writer.writeBits(unsigned, 16);
  } else {
    // Binary remainder (g bits)
    writer.writeBits(remainder, g);
  }
}

/**
 * Golomb-Rice decode a signed integer with parameter G.
 */
function golombRiceDecode(reader: BitstreamReader, g: number): number {
  // Read unary quotient
  let quotient = 0;
  while (reader.readBit() === 1 && quotient < 15) {
    quotient++;
  }

  let unsigned: number;
  if (quotient >= 15) {
    // Overflow: read full 16-bit value
    unsigned = reader.readBits(16);
  } else {
    const remainder = reader.readBits(g);
    unsigned = (quotient << g) | remainder;
  }

  // Unsigned → signed zigzag unmapping
  return (unsigned & 1) ? -((unsigned + 1) >> 1) : (unsigned >> 1);
}

// ---- LMS Adaptive Predictor ----

/** LMS predictor order — 16 taps is the sweet spot for narrowband IQ */
const LMS_ORDER = 16;

/** LMS step size (μ) as a right-shift value. μ = 2^-LMS_SHIFT */
const LMS_SHIFT = 12;

/**
 * LMS adaptive predictor state.
 * Maintains separate coefficient and history arrays.
 * One instance per I/Q channel.
 */
export class LmsPredictor {
  private coeffs: Int32Array;
  private history: Int32Array;
  private pos = 0;

  constructor() {
    this.coeffs = new Int32Array(LMS_ORDER);
    this.history = new Int32Array(LMS_ORDER);
  }

  /**
   * Predict the next sample based on history.
   * Returns the prediction as Int16-range value.
   */
  predict(): number {
    let sum = 0;
    for (let i = 0; i < LMS_ORDER; i++) {
      const idx = (this.pos - 1 - i + LMS_ORDER) & (LMS_ORDER - 1);
      sum += this.coeffs[i] * this.history[idx];
    }
    // Coefficients are scaled by 2^LMS_SHIFT, so shift back
    const pred = sum >> LMS_SHIFT;
    return Math.max(-32768, Math.min(32767, pred));
  }

  /**
   * Update coefficients using the LMS algorithm.
   * @param actual The actual sample value (reconstructed)
   * @param error The prediction error (actual - predicted)
   */
  update(actual: number, error: number): void {
    // LMS coefficient update: w[i] += μ * error * x[i]
    // With μ = 2^-LMS_SHIFT and avoiding multiplication overflow:
    // We use sign-based LMS (SLMS) for stability: update by ±|error|
    for (let i = 0; i < LMS_ORDER; i++) {
      const idx = (this.pos - 1 - i + LMS_ORDER) & (LMS_ORDER - 1);
      const h = this.history[idx];
      // Standard LMS update with leak factor for stability
      this.coeffs[i] -= this.coeffs[i] >> 8; // leak: decay toward zero
      if (h > 0) {
        this.coeffs[i] += error > 0 ? 1 : error < 0 ? -1 : 0;
      } else if (h < 0) {
        this.coeffs[i] -= error > 0 ? 1 : error < 0 ? -1 : 0;
      }
    }

    // Push actual sample into history
    this.history[this.pos] = actual;
    this.pos = (this.pos + 1) & (LMS_ORDER - 1);
  }

  /** Reset predictor state */
  reset(): void {
    this.coeffs.fill(0);
    this.history.fill(0);
    this.pos = 0;
  }
}

// ---- Block Parameters ----

/** Block size in IQ pairs. 128 pairs = 256 Int16 values = ~2.7ms at 48kHz */
export const VBR_BLOCK_IQ_PAIRS = 128;

/** Block size in Int16 samples (I and Q interleaved) */
export const VBR_BLOCK_SAMPLES = VBR_BLOCK_IQ_PAIRS * 2;

/** Header byte for A-law fallback block */
const ALAW_BLOCK_HEADER = 0x80;

/** Max G parameter for Golomb-Rice */
const MAX_G = 5;

/** Min G parameter */
const MIN_G = 1;

// ---- Encoder ----

/**
 * no-sdr-vbr-codec encoder.
 *
 * Streaming encoder: call encode() with Int16 IQ chunks of any size.
 * Internally buffers into 128-pair blocks, returns encoded blocks.
 * State persists across calls.
 *
 * Call reset() on mode/frequency change or reconnect.
 */
export class VbrEncoder {
  private predictorI = new LmsPredictor();
  private predictorQ = new LmsPredictor();
  private blockBuffer = new Int16Array(VBR_BLOCK_SAMPLES);
  private blockPos = 0;
  private forceAlaw = false; // Force next block to be A-law (resync)

  /**
   * Encode Int16 interleaved IQ data.
   * Returns an array of encoded blocks (may be 0 if buffering).
   * Each block is a Uint8Array ready for the wire.
   */
  encode(iqData: Int16Array): Uint8Array[] {
    const blocks: Uint8Array[] = [];
    let offset = 0;

    while (offset < iqData.length) {
      const remaining = VBR_BLOCK_SAMPLES - this.blockPos;
      const available = iqData.length - offset;
      const toCopy = Math.min(remaining, available);

      this.blockBuffer.set(
        iqData.subarray(offset, offset + toCopy),
        this.blockPos,
      );
      this.blockPos += toCopy;
      offset += toCopy;

      if (this.blockPos >= VBR_BLOCK_SAMPLES) {
        blocks.push(this.encodeBlock());
        this.blockPos = 0;
      }
    }

    return blocks;
  }

  /**
   * Flush any remaining buffered samples as an A-law block.
   * Call before disconnect or when switching modes.
   * Returns null if buffer is empty.
   */
  flush(): Uint8Array | null {
    if (this.blockPos === 0) return null;
    // Zero-pad the remaining samples
    this.blockBuffer.fill(0, this.blockPos);
    const block = this.encodeAlawBlock();
    this.blockPos = 0;
    return block;
  }

  /**
   * Reset encoder state. Sends A-law for the next block to resync.
   */
  reset(): void {
    this.predictorI.reset();
    this.predictorQ.reset();
    this.blockPos = 0;
    this.forceAlaw = true;
  }

  private encodeBlock(): Uint8Array {
    if (this.forceAlaw) {
      this.forceAlaw = false;
      return this.encodeAlawBlock();
    }

    // Trial-encode with LMS predictor to find residuals and optimal G
    const residualsI = new Int16Array(VBR_BLOCK_IQ_PAIRS);
    const residualsQ = new Int16Array(VBR_BLOCK_IQ_PAIRS);

    // Save predictor state so we can replay after choosing G
    const savedI = this.clonePredictor(this.predictorI);
    const savedQ = this.clonePredictor(this.predictorQ);

    let maxAbsResidual = 0;

    for (let i = 0; i < VBR_BLOCK_IQ_PAIRS; i++) {
      const sI = this.blockBuffer[i * 2];
      const sQ = this.blockBuffer[i * 2 + 1];

      const predI = this.predictorI.predict();
      const predQ = this.predictorQ.predict();

      const errI = sI - predI;
      const errQ = sQ - predQ;

      residualsI[i] = errI;
      residualsQ[i] = errQ;

      // Update predictors with actual values
      this.predictorI.update(sI, errI);
      this.predictorQ.update(sQ, errQ);

      const absI = errI < 0 ? -errI : errI;
      const absQ = errQ < 0 ? -errQ : errQ;
      if (absI > maxAbsResidual) maxAbsResidual = absI;
      if (absQ > maxAbsResidual) maxAbsResidual = absQ;
    }

    // Choose G based on residual magnitude distribution
    // G controls the Golomb-Rice parameter: larger G for larger residuals
    const g = this.chooseG(maxAbsResidual);

    // Encode residuals with Golomb-Rice
    const writer = new BitstreamWriter();
    for (let i = 0; i < VBR_BLOCK_IQ_PAIRS; i++) {
      golombRiceEncode(writer, residualsI[i], g);
      golombRiceEncode(writer, residualsQ[i], g);
    }
    const encodedBits = writer.finish();

    // If Golomb-Rice output is larger than A-law would be, use A-law instead
    // A-law block: 1 header + 256 bytes = 257 bytes
    if (encodedBits.length + 1 > VBR_BLOCK_SAMPLES + 1) {
      // Restore predictor state and use A-law
      this.restorePredictor(this.predictorI, savedI);
      this.restorePredictor(this.predictorQ, savedQ);
      // Update predictors with actual values (A-law path)
      for (let i = 0; i < VBR_BLOCK_IQ_PAIRS; i++) {
        const sI = this.blockBuffer[i * 2];
        const sQ = this.blockBuffer[i * 2 + 1];
        const predI = this.predictorI.predict();
        const predQ = this.predictorQ.predict();
        this.predictorI.update(sI, sI - predI);
        this.predictorQ.update(sQ, sQ - predQ);
      }
      return this.encodeAlawBlock();
    }

    // Header byte: bit 7 = 0 (VBR block), bits 6-4 = G (1-5), bits 3-0 = reserved
    const header = ((g & 0x07) << 4);
    const result = new Uint8Array(1 + encodedBits.length);
    result[0] = header;
    result.set(encodedBits, 1);
    return result;
  }

  private encodeAlawBlock(): Uint8Array {
    const result = new Uint8Array(1 + VBR_BLOCK_SAMPLES);
    result[0] = ALAW_BLOCK_HEADER;
    for (let i = 0; i < VBR_BLOCK_SAMPLES; i++) {
      result[1 + i] = alawEncode(this.blockBuffer[i]);
    }
    // Reset predictors on A-law block (fresh start for next block)
    this.predictorI.reset();
    this.predictorQ.reset();
    return result;
  }

  /**
   * Choose optimal Golomb-Rice parameter G based on residual statistics.
   * G = floor(log2(mean_abs_residual)) approximately.
   * Larger residuals → larger G → longer codewords but shorter unary prefix.
   */
  private chooseG(maxAbsResidual: number): number {
    if (maxAbsResidual < 2) return MIN_G;
    // log2 of max absolute residual, clamped to [MIN_G, MAX_G]
    const log2Max = Math.floor(Math.log2(maxAbsResidual + 1));
    // Scale: G ≈ log2(max) / 3, biased toward smaller G for better
    // compression on small residuals
    const g = Math.max(MIN_G, Math.min(MAX_G, Math.ceil(log2Max / 3)));
    return g;
  }

  /** Clone predictor state for trial encoding */
  private clonePredictor(p: LmsPredictor): {
    coeffs: Int32Array;
    history: Int32Array;
    pos: number;
  } {
    return {
      coeffs: new Int32Array((p as any).coeffs),
      history: new Int32Array((p as any).history),
      pos: (p as any).pos,
    };
  }

  /** Restore predictor state */
  private restorePredictor(
    p: LmsPredictor,
    saved: { coeffs: Int32Array; history: Int32Array; pos: number },
  ): void {
    (p as any).coeffs.set(saved.coeffs);
    (p as any).history.set(saved.history);
    (p as any).pos = saved.pos;
  }
}

// ---- Decoder ----

/**
 * no-sdr-vbr-codec decoder.
 *
 * Streaming decoder: call decode() with encoded blocks.
 * Returns Int16 interleaved IQ data.
 */
export class VbrDecoder {
  private predictorI = new LmsPredictor();
  private predictorQ = new LmsPredictor();

  /**
   * Decode a single VBR-encoded block.
   * @param block The raw encoded block bytes (including header).
   * @returns Int16Array of VBR_BLOCK_SAMPLES interleaved I/Q samples.
   */
  decodeBlock(block: Uint8Array): Int16Array {
    if (block.length === 0) {
      return new Int16Array(0);
    }

    const header = block[0];
    const isAlaw = (header & 0x80) !== 0;

    if (isAlaw) {
      return this.decodeAlawBlock(block);
    } else {
      return this.decodeVbrBlock(block);
    }
  }

  /**
   * Decode multiple concatenated VBR blocks from a wire message.
   * Wire format: [uint16 LE blockCount] [uint16 LE block1Len] [block1 bytes]
   *              [uint16 LE block2Len] [block2 bytes] ...
   * @returns Int16Array of all decoded samples concatenated.
   */
  decodeMessage(payload: ArrayBuffer): Int16Array {
    const view = new DataView(payload);
    const blockCount = view.getUint16(0, true);
    const allSamples = new Int16Array(blockCount * VBR_BLOCK_SAMPLES);
    let offset = 2;

    for (let b = 0; b < blockCount; b++) {
      const blockLen = view.getUint16(offset, true);
      offset += 2;
      const blockData = new Uint8Array(payload, offset, blockLen);
      const decoded = this.decodeBlock(blockData);
      allSamples.set(decoded, b * VBR_BLOCK_SAMPLES);
      offset += blockLen;
    }

    return allSamples;
  }

  /** Reset decoder state */
  reset(): void {
    this.predictorI.reset();
    this.predictorQ.reset();
  }

  private decodeAlawBlock(block: Uint8Array): Int16Array {
    const out = new Int16Array(VBR_BLOCK_SAMPLES);
    for (let i = 0; i < VBR_BLOCK_SAMPLES; i++) {
      out[i] = alawDecode(block[1 + i] ?? 0);
    }
    // Reset predictors on A-law block (fresh start)
    this.predictorI.reset();
    this.predictorQ.reset();
    return out;
  }

  private decodeVbrBlock(block: Uint8Array): Int16Array {
    const header = block[0];
    const g = (header >> 4) & 0x07;
    const bitstream = new Uint8Array(block.buffer, block.byteOffset + 1, block.length - 1);
    const reader = new BitstreamReader(bitstream);

    const out = new Int16Array(VBR_BLOCK_SAMPLES);

    for (let i = 0; i < VBR_BLOCK_IQ_PAIRS; i++) {
      // Decode residuals
      const errI = golombRiceDecode(reader, g);
      const errQ = golombRiceDecode(reader, g);

      // Reconstruct samples: actual = predicted + residual
      const predI = this.predictorI.predict();
      const predQ = this.predictorQ.predict();

      const sI = Math.max(-32768, Math.min(32767, predI + errI));
      const sQ = Math.max(-32768, Math.min(32767, predQ + errQ));

      out[i * 2] = sI;
      out[i * 2 + 1] = sQ;

      // Update predictors with reconstructed values
      this.predictorI.update(sI, errI);
      this.predictorQ.update(sQ, errQ);
    }

    return out;
  }
}

// ---- Wire Format Helpers ----

/**
 * Pack VBR-encoded blocks into a wire message.
 * Wire format: [uint16 LE blockCount] [uint16 LE block1Len] [block1]
 *              [uint16 LE block2Len] [block2] ...
 *
 * This format allows variable-size blocks to be concatenated
 * efficiently into a single WebSocket message.
 */
export function packVbrBlocks(blocks: Uint8Array[]): Uint8Array {
  if (blocks.length === 0) return new Uint8Array(0);

  // Calculate total size
  let totalSize = 2; // block count (uint16)
  for (const block of blocks) {
    totalSize += 2 + block.length; // length prefix (uint16) + block bytes
  }

  const result = new Uint8Array(totalSize);
  const view = new DataView(result.buffer);
  view.setUint16(0, blocks.length, true);

  let offset = 2;
  for (const block of blocks) {
    view.setUint16(offset, block.length, true);
    offset += 2;
    result.set(block, offset);
    offset += block.length;
  }

  return result;
}
