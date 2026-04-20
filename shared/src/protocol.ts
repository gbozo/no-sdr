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
  | { cmd: 'waterfall_settings'; minDb: number; maxDb: number }
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
 * Pack compressed FFT data (Uint8Array 0-255) into a binary message
 */
export function packCompressedFftMessage(data: Uint8Array): ArrayBuffer {
  return packBinaryMessage(MSG_FFT_COMPRESSED, data.buffer as ArrayBuffer);
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
