// ============================================================
// node-sdr — WebSocket Binary Protocol
// ============================================================
//
// Server → Client (binary):
//   [type: uint8] [payload: ...]
//
// Client → Server (JSON text):
//   { "cmd": "...", ...params }
//
// ============================================================

// ---- Message Type Bytes (Server → Client) ----

/** FFT magnitude data — Float32Array of dB values, broadcast to all on dongle */
export const MSG_FFT = 0x01;

/** IQ sub-band data — Int16Array of interleaved I/Q samples, per-user */
export const MSG_IQ = 0x02;

/** JSON metadata — profile info, decoder output, status updates */
export const MSG_META = 0x03;

/** Compressed FFT — Uint8Array (0-255 mapped dB), low-bandwidth alternative */
export const MSG_FFT_COMPRESSED = 0x04;

/** Audio PCM — Int16Array mono samples, per-user demodulated audio */
export const MSG_AUDIO = 0x05;

/** Decoder data — JSON-encoded decoder messages (ADS-B positions, ACARS, etc.) */
export const MSG_DECODER = 0x06;

/** S-meter / signal level — Float32 dB value for user's tuned frequency */
export const MSG_SIGNAL_LEVEL = 0x07;

/** ADPCM-compressed FFT — Int16 dB×100 encoded as IMA-ADPCM nibbles with warmup padding */
export const MSG_FFT_ADPCM = 0x08;

/** ADPCM-compressed IQ — Int16 interleaved I/Q encoded as IMA-ADPCM nibbles */
export const MSG_IQ_ADPCM = 0x09;

/** Deflate-compressed FFT — delta-encoded Uint8 dB values compressed with raw deflate */
export const MSG_FFT_DEFLATE = 0x0B;
export const MSG_AUDIO_OPUS = 0x0C;

// ---- Codec Types ----

/** Available compression codecs for FFT data */
export type FftCodecType = 'none' | 'adpcm' | 'deflate';

/** Available codecs for IQ/audio data */
export type IqCodecType = 'none' | 'adpcm' | 'opus';

/** Union for backward compatibility */
export type CodecType = FftCodecType | IqCodecType;

// ---- Client Command Types ----

export type ClientCommand =
  | { cmd: 'subscribe'; dongleId: string; profileId?: string }
  | { cmd: 'unsubscribe' }
  | { cmd: 'tune'; offset: number } // frequency offset from center in Hz
  | { cmd: 'mode'; mode: string }
  | { cmd: 'bandwidth'; hz: number }
  | { cmd: 'squelch'; db: number | null }
  | { cmd: 'volume'; level: number }
  | { cmd: 'mute'; muted: boolean }
  | { cmd: 'audio_enabled'; enabled: boolean }
  | { cmd: 'waterfall_settings'; minDb: number; maxDb: number }
  | { cmd: 'codec'; fftCodec?: FftCodecType; iqCodec?: IqCodecType }
  | { cmd: 'stereo_enabled'; enabled: boolean }
  // Admin commands
  | { cmd: 'admin_auth'; password: string }
  | { cmd: 'admin_set_profile'; dongleId: string; profileId: string }
  | { cmd: 'admin_stop_dongle'; dongleId: string }
  | { cmd: 'admin_start_dongle'; dongleId: string };

// ---- Server Meta Messages ----

export type ServerMeta =
  | { type: 'welcome'; clientId: string; serverVersion: string }
  | { type: 'subscribed'; dongleId: string; profileId: string; centerFreq: number; sampleRate: number; fftSize: number; iqSampleRate: number; mode: string }
  | { type: 'profile_changed'; dongleId: string; profileId: string; centerFreq: number; sampleRate: number; fftSize: number; iqSampleRate: number; mode: string }
  | { type: 'dongle_status'; dongleId: string; running: boolean; clientCount: number }
  | { type: 'error'; message: string; code?: string }
  | { type: 'admin_auth_ok' }
  | { type: 'decoder_data'; decoderType: string; data: unknown };

// ---- Binary Message Helpers ----

/**
 * Pack a typed array with a message type byte prefix
 */
export function packBinaryMessage(type: number, payload: ArrayBuffer): ArrayBuffer {
  const buf = new ArrayBuffer(1 + payload.byteLength);
  const view = new Uint8Array(buf);
  view[0] = type;
  view.set(new Uint8Array(payload), 1);
  return buf;
}

/**
 * Unpack a binary message: returns [type, payload]
 */
export function unpackBinaryMessage(data: ArrayBuffer): [number, ArrayBuffer] {
  const type = new Uint8Array(data)[0];
  const payload = data.slice(1);
  return [type, payload];
}

/**
 * Pack FFT data (Float32Array) into a binary message
 */
export function packFftMessage(fftData: Float32Array): ArrayBuffer {
  return packBinaryMessage(MSG_FFT, fftData.buffer as ArrayBuffer);
}

/**
 * Pack compressed FFT data (Uint8Array 0-255) into a binary message.
 * Includes a 4-byte header: [minDb as Int16, maxDb as Int16] so the client
 * can reconstruct Float32 dB values without relying on local settings.
 */
export function packCompressedFftMessage(data: Uint8Array, minDb: number, maxDb: number): ArrayBuffer {
  // Header: 4 bytes (Int16 minDb + Int16 maxDb) + payload
  const buf = new ArrayBuffer(1 + 4 + data.length);
  const view = new DataView(buf);
  view.setUint8(0, MSG_FFT_COMPRESSED);
  view.setInt16(1, Math.round(minDb), true); // little-endian
  view.setInt16(3, Math.round(maxDb), true);
  new Uint8Array(buf, 5).set(data);
  return buf;
}

/**
 * Pack IQ sub-band data (Int16Array interleaved I/Q) into a binary message
 */
export function packIqMessage(iqData: Int16Array): ArrayBuffer {
  return packBinaryMessage(MSG_IQ, iqData.buffer as ArrayBuffer);
}

/**
 * Pack audio PCM data (Int16Array mono) into a binary message
 */
export function packAudioMessage(audioData: Int16Array): ArrayBuffer {
  return packBinaryMessage(MSG_AUDIO, audioData.buffer as ArrayBuffer);
}

/**
 * Pack a JSON metadata message
 */
export function packMetaMessage(meta: ServerMeta): ArrayBuffer {
  const json = JSON.stringify(meta);
  const encoder = new TextEncoder();
  const bytes = encoder.encode(json);
  return packBinaryMessage(MSG_META, bytes.buffer as ArrayBuffer);
}

/**
 * Compress FFT Float32 dB values to Uint8 (0-255) for low-bandwidth mode
 */
export function compressFft(
  fftData: Float32Array,
  minDb: number,
  maxDb: number,
): Uint8Array {
  const out = new Uint8Array(fftData.length);
  const range = maxDb - minDb;
  for (let i = 0; i < fftData.length; i++) {
    const normalized = (fftData[i] - minDb) / range;
    out[i] = Math.max(0, Math.min(255, Math.round(normalized * 255)));
  }
  return out;
}

/**
 * Pack ADPCM-compressed FFT data into a binary message.
 * The payload is produced by encodeFftAdpcm() from adpcm.ts.
 */
export function packFftAdpcmMessage(adpcmPayload: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(1 + adpcmPayload.length);
  const view = new Uint8Array(buf);
  view[0] = MSG_FFT_ADPCM;
  view.set(adpcmPayload, 1);
  return buf;
}

/**
 * Pack ADPCM-compressed IQ data into a binary message.
 * Header: [type byte] [uint32 LE sampleCount] [adpcm nibbles]
 * sampleCount is the original Int16 sample count (I and Q interleaved)
 * so the decoder knows the exact output size.
 */
export function packIqAdpcmMessage(adpcmData: Uint8Array, sampleCount: number): ArrayBuffer {
  const buf = new ArrayBuffer(1 + 4 + adpcmData.length);
  const view = new DataView(buf);
  view.setUint8(0, MSG_IQ_ADPCM);
  view.setUint32(1, sampleCount, true); // little-endian
  new Uint8Array(buf, 5).set(adpcmData);
  return buf;
}

/**
 * Pack deflate-compressed FFT data into a binary message.
 * Header: [type 0x0B] [Int16 minDb LE] [Int16 maxDb LE] [Uint16 binCount LE] [deflate payload]
 * The deflate payload contains delta-encoded Uint8 dB values compressed with raw deflate.
 * Delta encoding: first byte is absolute, subsequent bytes are (current - previous) as Int8.
 */
export function packFftDeflateMessage(
  deflatePayload: Uint8Array,
  minDb: number,
  maxDb: number,
  binCount: number,
): ArrayBuffer {
  const buf = new ArrayBuffer(1 + 8 + deflatePayload.length);
  const view = new DataView(buf);
  view.setUint8(0, MSG_FFT_DEFLATE);
  view.setInt16(1, Math.round(minDb), true);
  view.setInt16(3, Math.round(maxDb), true);
  view.setUint32(5, binCount, true);
  new Uint8Array(buf, 9).set(deflatePayload);
  return buf;
}

/**
 * Pack an Opus-encoded audio message.
 * Wire format: [0x0C] [Uint16 sampleCount LE] [Opus packet bytes]
 */
export function packAudioOpusMessage(opusPacket: Uint8Array, sampleCount: number, channels = 1): ArrayBuffer {
  // Wire: [0x0C] [Uint16 sampleCount LE] [Uint8 channels] [Opus packet bytes]
  const buf = new ArrayBuffer(1 + 2 + 1 + opusPacket.length);
  const view = new DataView(buf);
  view.setUint8(0, MSG_AUDIO_OPUS);
  view.setUint16(1, sampleCount, true);
  view.setUint8(3, channels);
  new Uint8Array(buf, 4).set(opusPacket);
  return buf;
}


