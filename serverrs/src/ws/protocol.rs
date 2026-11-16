//! WebSocket binary protocol for no-sdr.
//!
//! Server -> client messages use a single type-byte prefix followed by
//! little-endian typed array payloads. Client -> server messages are JSON text.
//!
//! The binary protocol is byte-compatible with the original Go implementation.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::codec::adpcm::encode_fft_adpcm;
use crate::codec::{compress_fft, FftDeflateEncoder};

// Message type bytes (server -> client)
pub const MSG_FFT: u8 = 0x01; // Float32Array (dB magnitudes)
pub const MSG_IQ: u8 = 0x02; // Int16Array (interleaved I/Q)
pub const MSG_META: u8 = 0x03; // UTF-8 JSON (ServerMeta)
pub const MSG_FFT_COMPRESSED: u8 = 0x04; // Int16(minDb) + Int16(maxDb) + Uint8[N]
pub const MSG_AUDIO: u8 = 0x05; // Int16Array mono samples
pub const MSG_DECODER: u8 = 0x06; // JSON-encoded decoder messages
pub const MSG_SIGNAL_LEVEL: u8 = 0x07; // Float32 dB value
pub const MSG_FFT_ADPCM: u8 = 0x08; // ADPCM on Int16(dB x 100)
pub const MSG_IQ_ADPCM: u8 = 0x09; // Uint32(sampleCount) + Uint32(sampleRate) + Uint8(channels) + Uint8(reserved) + ADPCM bytes
pub const MSG_RDS: u8 = 0x0A; // UTF-8 JSON (RDS data)
pub const MSG_FFT_DEFLATE: u8 = 0x0B; // Int16(minDb) + Int16(maxDb) + Uint32(binCount) + deflate
pub const MSG_AUDIO_OPUS: u8 = 0x0C; // Uint16(sampleCount) + Uint8(channels) + Opus packet
pub const MSG_FFT_HISTORY: u8 = 0x0D; // Waterfall history burst
/// A foreground decoder's zoomed spectrum. Sent only after the client asks
/// for it with `{"cmd":"decoder_scope","enabled":true}`.
pub const MSG_DECODER_SCOPE: u8 = 0x0E; // [version][flags][reserved][startHz][bins][hzPerBin][minDb][maxDb][u8 bins]

// ---- V1 segmented multi-tier waterfall protocol ----
//
// Affected FFT messages (0x01, 0x04, 0x08, 0x0B, 0x0D) may carry a `verFlags`
// byte immediately after the type byte. Legacy frames omit it entirely.
//
// `verFlags` layout:
//   low nibble = protocol version (= `WF_VER`)
//   bit 0x10   = TILED: a 6-byte tier/tile block follows
//   bits 0x20/0x40/0x80 reserved (= 0)
//
// 6-byte tier/tile block (present only when TILED):
//   [u8 tier][u8 reserved0 = 0][u16 tileIndex LE][u16 tileCount LE]

/// Current waterfall protocol version carried in the low nibble of `verFlags`.
pub const WF_VER: u8 = 1;
/// `verFlags` bit set when a 6-byte tier/tile block follows.
pub const WF_FLAG_TILED: u8 = 0x10;
/// `verFlags` value for a tiled V1 FFT frame (`WF_VER | WF_FLAG_TILED`).
pub const WF_VERFLAGS_TILED: u8 = WF_VER | WF_FLAG_TILED; // 0x11

/// Append the 6-byte tier/tile block to `buf`.
#[inline]
fn push_tile_block(buf: &mut Vec<u8>, tier: u8, tile_index: u16, tile_count: u16) {
    buf.push(tier);
    buf.push(0); // reserved0
    buf.extend_from_slice(&tile_index.to_le_bytes());
    buf.extend_from_slice(&tile_count.to_le_bytes());
}

/// One connected listener's tuning position for the users ribbon.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UserLocation {
    pub client_id: String,
    pub conn_index: i64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub profile_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ip: Option<String>,
    pub frequency_hz: i64,
    pub mode: String,
    pub bandwidth: i64,
}

/// Metadata sent to a connected client.
///
/// Field order mirrors the Go struct so serialized key order matches.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerMeta {
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dongle_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub center_freq: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fft_size: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fft_fps: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iq_sample_rate: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tuning_step: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bandwidth: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tune_offset: Option<i64>,
    // Error fields
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    // Welcome fields
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conn_index: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_fft_codecs: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_iq_codecs: Option<Vec<String>>,
    // Dongle status fields
    #[serde(skip_serializing_if = "Option::is_none")]
    pub running: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_count: Option<i64>,
    // Users ribbon
    #[serde(skip_serializing_if = "Option::is_none")]
    pub users: Option<Vec<UserLocation>>,
    // Segmented multi-tier waterfall negotiation. Both `None` by default; the
    // manager/meta-build code sets them when the session speaks protocol v1.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waterfall_protocol: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waterfall_tile_bins: Option<u32>,
}

/// Parsed command from the client (JSON text).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClientCommand {
    #[serde(default)]
    pub cmd: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub dongle_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub profile_id: String,
    #[serde(default, skip_serializing_if = "is_zero_i64")]
    pub offset: i64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub mode: String,
    #[serde(default, skip_serializing_if = "is_zero_i64")]
    pub bandwidth: i64,
    #[serde(default, skip_serializing_if = "is_zero_i64")]
    pub hz: i64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub fft_codec: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub iq_codec: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stereo_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub password: String,
    #[serde(default, skip_serializing_if = "is_zero_f64")]
    pub level: f64,
    /// Noise-blanker threshold multiplier. The client historically sent
    /// `threshold` while the server only read `level`; accept both.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threshold: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub muted: Option<bool>,
    /// FM de-emphasis in microseconds (50 or 75).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deemphasis: Option<f64>,
    /// Foreground decoder scope frame rate (2–20 fps). Only meaningful for
    /// `cmd: "decoder_scope"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fps: Option<u32>,
    /// Hide a helper connection from the public users ribbon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
    /// Segmented waterfall viewport negotiation (`cmd: "waterfall_view"`):
    /// the display width in CSS pixels the client wants bins for.
    #[serde(default)]
    pub viewport_px: i64,
    /// Fractional start of the viewport within the full span (0.0..=1.0).
    #[serde(default)]
    pub start_frac: f64,
    /// Fractional end of the viewport within the full span (0.0..=1.0).
    #[serde(default)]
    pub end_frac: f64,
}

fn is_zero_i64(v: &i64) -> bool {
    *v == 0
}

fn is_zero_f64(v: &f64) -> bool {
    *v == 0.0
}

/// Sent back to the client when a codec is rejected or confirmed.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodecStatus {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub fft_codec: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub fft_msg: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub iq_codec: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub iq_msg: String,
}

/// Pack a `ServerMeta` as `[0x03][UTF-8 JSON]`.
pub fn pack_meta_message(meta: &ServerMeta) -> Vec<u8> {
    let json = serde_json::to_vec(meta).unwrap_or_default();
    let mut buf = Vec::with_capacity(1 + json.len());
    buf.push(MSG_META);
    buf.extend_from_slice(&json);
    buf
}

/// Pack a decoder result as `[MSG_DECODER][UTF-8 JSON]`.
///
/// The client consumes `{ decoderType, data }`; `data` is intentionally
/// decoder-specific so a panel can be added without changing the wire
/// envelope.
pub fn pack_decoder_message(decoder_type: &str, data: Value) -> Vec<u8> {
    let value = serde_json::json!({
        "decoderType": decoder_type,
        "data": data,
    });
    let json = serde_json::to_vec(&value).unwrap_or_default();
    let mut buf = Vec::with_capacity(1 + json.len());
    buf.push(MSG_DECODER);
    buf.extend_from_slice(&json);
    buf
}

/// Pack a foreground decoder's zoomed spectrum.
///
/// Wire (after the leading type byte):
/// `[u8 version][u8 flags][u16 reserved][f64 startHz][u32 binCount]`
/// `[f32 hzPerBin][i16 minDb][i16 maxDb][u8 bins...]`.
///
/// `startHz` is the absolute RF frequency of the first bin. The bins are
/// linear in dB between `minDb` and `maxDb`.
pub fn pack_decoder_scope(
    start_hz: f64,
    hz_per_bin: f32,
    min_db: f32,
    max_db: f32,
    bins: &[u8],
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(24 + bins.len());
    buf.push(MSG_DECODER_SCOPE);
    buf.push(1); // version
    buf.push(0); // flags
    buf.extend_from_slice(&0u16.to_le_bytes()); // reserved
    buf.extend_from_slice(&start_hz.to_le_bytes());
    buf.extend_from_slice(&(bins.len() as u32).to_le_bytes());
    buf.extend_from_slice(&hz_per_bin.to_le_bytes());
    buf.extend_from_slice(&(min_db.round() as i16).to_le_bytes());
    buf.extend_from_slice(&(max_db.round() as i16).to_le_bytes());
    buf.extend_from_slice(bins);
    buf
}

/// Send codec fallback info as a META message with `type = "codec_status"`.
pub fn pack_codec_status_message(status: &CodecStatus) -> Vec<u8> {
    let mut map = serde_json::Map::new();
    map.insert("type".to_string(), serde_json::Value::String("codec_status".into()));
    if !status.fft_codec.is_empty() {
        map.insert("fftCodec".into(), serde_json::Value::String(status.fft_codec.clone()));
        map.insert("fftMsg".into(), serde_json::Value::String(status.fft_msg.clone()));
    }
    if !status.iq_codec.is_empty() {
        map.insert("iqCodec".into(), serde_json::Value::String(status.iq_codec.clone()));
        map.insert("iqMsg".into(), serde_json::Value::String(status.iq_msg.clone()));
    }
    let json = serde_json::to_vec(&serde_json::Value::Object(map)).unwrap_or_default();
    let mut buf = Vec::with_capacity(1 + json.len());
    buf.push(MSG_META);
    buf.extend_from_slice(&json);
    buf
}

/// Pack compressed FFT data: `[0x04][i16 minDb LE][i16 maxDb LE][u8...]`.
pub fn pack_fft_compressed_message(data: &[u8], min_db: i16, max_db: i16) -> Vec<u8> {
    let mut buf = Vec::with_capacity(1 + 4 + data.len());
    buf.push(MSG_FFT_COMPRESSED);
    buf.extend_from_slice(&min_db.to_le_bytes());
    buf.extend_from_slice(&max_db.to_le_bytes());
    buf.extend_from_slice(data);
    buf
}

/// Pack ADPCM-compressed FFT data: `[0x08][adpcm payload]`.
///
/// The payload already carries its own 4-byte min/max header.
pub fn pack_fft_adpcm_message(adpcm_payload: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(1 + adpcm_payload.len());
    buf.push(MSG_FFT_ADPCM);
    buf.extend_from_slice(adpcm_payload);
    buf
}

/// Pack deflate-compressed FFT data:
/// `[0x0B][i16 minDb][i16 maxDb][u32 binCount][deflate bytes]`.
pub fn pack_fft_deflate_message(
    deflated: &[u8],
    min_db: i16,
    max_db: i16,
    bin_count: u32,
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(1 + 8 + deflated.len());
    buf.push(MSG_FFT_DEFLATE);
    buf.extend_from_slice(&min_db.to_le_bytes());
    buf.extend_from_slice(&max_db.to_le_bytes());
    buf.extend_from_slice(&bin_count.to_le_bytes());
    buf.extend_from_slice(deflated);
    buf
}

/// Pack raw IQ samples with a self-describing header:
/// `[0x02][u32 sampleRate][u8 channels=2][u8 reserved=0][i16 samples...]`.
pub fn pack_iq_message(samples: &[i16], sample_rate: u32) -> Vec<u8> {
    let mut buf = Vec::with_capacity(1 + 6 + samples.len() * 2);
    buf.push(MSG_IQ);
    buf.extend_from_slice(&sample_rate.to_le_bytes());
    buf.push(2); // always 2-channel interleaved I/Q
    buf.push(0); // reserved
    for s in samples {
        buf.extend_from_slice(&s.to_le_bytes());
    }
    buf
}

/// Pack ADPCM-compressed IQ data:
/// `[0x09][u32 sampleCount][u32 sampleRate][u8 channels=2][u8 0][adpcm]`.
pub fn pack_iq_adpcm_message(adpcm: &[u8], sample_count: u32, sample_rate: u32) -> Vec<u8> {
    let mut buf = Vec::with_capacity(1 + 10 + adpcm.len());
    buf.push(MSG_IQ_ADPCM);
    buf.extend_from_slice(&sample_count.to_le_bytes());
    buf.extend_from_slice(&sample_rate.to_le_bytes());
    buf.push(2); // always 2-channel interleaved I/Q
    buf.push(0); // reserved
    buf.extend_from_slice(adpcm);
    buf
}

/// Pack an Opus-encoded audio frame:
/// `[0x0C][u16 sampleCount][u8 channels][Opus packet]`.
pub fn pack_audio_opus_message(packet: &[u8], sample_count: u16, channels: u8) -> Vec<u8> {
    let mut buf = Vec::with_capacity(1 + 2 + 1 + packet.len());
    buf.push(MSG_AUDIO_OPUS);
    buf.extend_from_slice(&sample_count.to_le_bytes());
    buf.push(channels);
    buf.extend_from_slice(packet);
    buf
}

/// Pack RDS data as a JSON binary message: `[0x0A][UTF-8 JSON]`.
pub fn pack_rds_message(rds_data: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(1 + rds_data.len());
    buf.push(MSG_RDS);
    buf.extend_from_slice(rds_data);
    buf
}

/// Pack a raw FFT frame: `[0x01][f32 LE...]`.
pub fn pack_fft_message(bins: &[f32]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(1 + bins.len() * 4);
    buf.push(MSG_FFT);
    for b in bins {
        buf.extend_from_slice(&b.to_le_bytes());
    }
    buf
}

// ------------------------------------------------------------------
// V1 tiled FFT packers
//
// Each mirrors its non-tiled counterpart but inserts a `verFlags = 0x11`
// byte followed by the 6-byte tier/tile block in the position defined by
// the frozen wire contract.
// ------------------------------------------------------------------

/// V1 tiled raw FFT frame:
/// `[0x01][0x11][tier][0][tileIndex u16][tileCount u16][f32 bins...]`.
pub fn pack_fft_raw_tiled(bins: &[f32], tier: u8, tile_index: u16, tile_count: u16) -> Vec<u8> {
    let mut buf = Vec::with_capacity(1 + 1 + 6 + bins.len() * 4);
    buf.push(MSG_FFT);
    buf.push(WF_VERFLAGS_TILED);
    push_tile_block(&mut buf, tier, tile_index, tile_count);
    for b in bins {
        buf.extend_from_slice(&b.to_le_bytes());
    }
    buf
}

/// V1 tiled compressed FFT frame:
/// `[0x04][0x11][tier][0][tileIndex u16][tileCount u16][i16 minDb][i16 maxDb][u8 bins...]`.
///
/// The bins are quantized from `bins` exactly as the non-tiled
/// `pack_fft_compressed_message` path does (via `compress_fft`).
pub fn pack_fft_compressed_tiled(
    bins: &[f32],
    min_db: i16,
    max_db: i16,
    tier: u8,
    tile_index: u16,
    tile_count: u16,
) -> Vec<u8> {
    let quantized = compress_fft(bins, min_db as f32, max_db as f32);
    let mut buf = Vec::with_capacity(1 + 1 + 6 + 4 + quantized.len());
    buf.push(MSG_FFT_COMPRESSED);
    buf.push(WF_VERFLAGS_TILED);
    push_tile_block(&mut buf, tier, tile_index, tile_count);
    buf.extend_from_slice(&min_db.to_le_bytes());
    buf.extend_from_slice(&max_db.to_le_bytes());
    buf.extend_from_slice(&quantized);
    buf
}

/// V1 tiled ADPCM FFT frame:
/// `[0x08][0x11][tier][0][tileIndex u16][tileCount u16][adpcm payload]`.
///
/// The ADPCM payload carries its own inner `[i16 minDb][i16 maxDb]` header
/// (produced by `encode_fft_adpcm`); it is NOT duplicated or relocated. The
/// min/max values used are the canonical FFT range (-130/0 dB), matching the
/// non-tiled `adpcm` codec path in the dongle manager.
pub fn pack_fft_adpcm_tiled(bins: &[f32], tier: u8, tile_index: u16, tile_count: u16) -> Vec<u8> {
    const MIN_DB: f32 = -130.0;
    const MAX_DB: f32 = 0.0;
    let payload = encode_fft_adpcm(bins, MIN_DB, MAX_DB);
    let mut buf = Vec::with_capacity(1 + 1 + 6 + payload.len());
    buf.push(MSG_FFT_ADPCM);
    buf.push(WF_VERFLAGS_TILED);
    push_tile_block(&mut buf, tier, tile_index, tile_count);
    buf.extend_from_slice(&payload);
    buf
}

/// V1 tiled deflate FFT frame:
/// `[0x0B][0x11][tier][0][tileIndex u16][tileCount u16][i16 minDb][i16 maxDb][u32 binCount][deflate bytes]`.
///
/// `binCount` is the decompressed bin count of this tile. The deflate body is
/// produced by the shared `FftDeflateEncoder` exactly as the non-tiled
/// `deflate` codec path does.
pub fn pack_fft_deflate_tiled(
    bins: &[f32],
    min_db: i16,
    max_db: i16,
    tier: u8,
    tile_index: u16,
    tile_count: u16,
    enc: &mut FftDeflateEncoder,
) -> Vec<u8> {
    let body = enc
        .encode(bins, min_db as f32, max_db as f32)
        .unwrap_or_default();
    let mut buf = Vec::with_capacity(1 + 1 + 6 + 8 + body.len());
    buf.push(MSG_FFT_DEFLATE);
    buf.push(WF_VERFLAGS_TILED);
    push_tile_block(&mut buf, tier, tile_index, tile_count);
    buf.extend_from_slice(&min_db.to_le_bytes());
    buf.extend_from_slice(&max_db.to_le_bytes());
    buf.extend_from_slice(&(bins.len() as u32).to_le_bytes());
    buf.extend_from_slice(&body);
    buf
}

/// V1 tiled waterfall history burst:
/// `[0x0D][0x11][tier][0][tileIndex u16][tileCount u16][u16 frameCount]`
/// `[u32 binCount][i16 minDb][i16 maxDb][u8 codec][payload]`.
///
/// `codec` selects the payload encoding: 0 = NONE (raw quantized u8 frames),
/// 1 = DEFLATE (delta + raw deflate over all frames), 2 = ADPCM. The frames
/// are quantized/compressed exactly as the non-tiled history path does. All
/// frames are assumed to share `binCount = frames[0].len()`.
pub fn pack_fft_history_tiled(
    frames: &[Vec<f32>],
    min_db: i16,
    max_db: i16,
    codec: u8,
    tier: u8,
    tile_index: u16,
    tile_count: u16,
) -> Vec<u8> {
    let frame_count = frames.len() as u16;
    let bin_count = frames.first().map(|f| f.len()).unwrap_or(0);
    let min_f = min_db as f32;
    let max_f = max_db as f32;
    let range = (max_f - min_f).max(1e-6);

    // Quantize all frames to u8 (contiguous, frame-major), mirroring the
    // non-tiled history builder's `compress_fft` quantization.
    let mut quantized: Vec<u8> = Vec::with_capacity(frame_count as usize * bin_count);
    for frame in frames {
        quantized.extend_from_slice(&compress_fft(frame, min_f, max_f));
    }

    let payload: Vec<u8> = match codec {
        1 => {
            // delta over the whole quantized buffer, then raw deflate
            use std::io::Write;
            let mut delta = Vec::with_capacity(quantized.len());
            if let Some(first) = quantized.first() {
                delta.push(*first);
                for i in 1..quantized.len() {
                    delta.push(quantized[i].wrapping_sub(quantized[i - 1]));
                }
            }
            let mut e =
                flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::new(6));
            if e.write_all(&delta).is_ok() {
                e.finish().unwrap_or_default()
            } else {
                Vec::new()
            }
        }
        2 => {
            // ADPCM over reconstructed float dB values
            let mut float_db = Vec::with_capacity(quantized.len());
            for b in &quantized {
                float_db.push(*b as f32 / 255.0 * range + min_f);
            }
            encode_fft_adpcm(&float_db, min_f, max_f)
        }
        _ => quantized,
    };

    let mut buf = Vec::with_capacity(1 + 1 + 6 + 2 + 4 + 2 + 2 + 1 + payload.len());
    buf.push(MSG_FFT_HISTORY);
    buf.push(WF_VERFLAGS_TILED);
    push_tile_block(&mut buf, tier, tile_index, tile_count);
    buf.extend_from_slice(&frame_count.to_le_bytes());
    buf.extend_from_slice(&(bin_count as u32).to_le_bytes());
    buf.extend_from_slice(&min_db.to_le_bytes());
    buf.extend_from_slice(&max_db.to_le_bytes());
    buf.push(codec);
    buf.extend_from_slice(&payload);
    buf
}

/// Pack a mono audio frame: `[0x05][i16 LE...]`.
pub fn pack_audio_message(samples: &[i16]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(1 + samples.len() * 2);
    buf.push(MSG_AUDIO);
    for s in samples {
        buf.extend_from_slice(&s.to_le_bytes());
    }
    buf
}

/// Pack a signal-level frame: `[0x07][f32 LE]`.
pub fn pack_signal_level_message(level_db: f32) -> Vec<u8> {
    let mut buf = Vec::with_capacity(5);
    buf.push(MSG_SIGNAL_LEVEL);
    buf.extend_from_slice(&level_db.to_le_bytes());
    buf
}

/// Parse a JSON text command from the client.
pub fn parse_client_command(data: &[u8]) -> anyhow::Result<ClientCommand> {
    let cmd: ClientCommand = serde_json::from_slice(data)
        .map_err(|e| anyhow::anyhow!("invalid client command: {e}"))?;
    if cmd.cmd.is_empty() {
        anyhow::bail!("missing 'cmd' field");
    }
    Ok(cmd)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_fft_compressed() {
        let msg = pack_fft_compressed_message(&[10, 20, 30, 40, 50], -120, 0);
        assert_eq!(msg[0], MSG_FFT_COMPRESSED);
        assert_eq!(i16::from_le_bytes([msg[1], msg[2]]), -120);
        assert_eq!(i16::from_le_bytes([msg[3], msg[4]]), 0);
        assert_eq!(&msg[5..], &[10, 20, 30, 40, 50]);
        assert_eq!(msg.len(), 1 + 4 + 5);
    }

    #[test]
    fn pack_iq_adpcm() {
        let msg = pack_iq_adpcm_message(&[0xAB, 0xCD, 0xEF, 0x12], 1024, 48000);
        assert_eq!(msg[0], MSG_IQ_ADPCM);
        assert_eq!(u32::from_le_bytes([msg[1], msg[2], msg[3], msg[4]]), 1024);
        assert_eq!(u32::from_le_bytes([msg[5], msg[6], msg[7], msg[8]]), 48000);
        assert_eq!(msg[9], 2);
        assert_eq!(msg[10], 0);
        assert_eq!(&msg[11..], &[0xAB, 0xCD, 0xEF, 0x12]);
        assert_eq!(msg.len(), 1 + 10 + 4);
    }

    #[test]
    fn pack_fft_deflate() {
        let msg = pack_fft_deflate_message(&[0x78, 0x9C, 1, 2, 3], -100, -10, 4096);
        assert_eq!(msg[0], MSG_FFT_DEFLATE);
        assert_eq!(i16::from_le_bytes([msg[1], msg[2]]), -100);
        assert_eq!(i16::from_le_bytes([msg[3], msg[4]]), -10);
        assert_eq!(
            u32::from_le_bytes([msg[5], msg[6], msg[7], msg[8]]),
            4096
        );
        assert_eq!(&msg[9..], &[0x78, 0x9C, 1, 2, 3]);
    }

    #[test]
    fn pack_audio_opus() {
        let msg = pack_audio_opus_message(&[0xFC, 0xFF, 0xFE, 0, 1], 960, 2);
        assert_eq!(msg[0], MSG_AUDIO_OPUS);
        assert_eq!(u16::from_le_bytes([msg[1], msg[2]]), 960);
        assert_eq!(msg[3], 2);
        assert_eq!(&msg[4..], &[0xFC, 0xFF, 0xFE, 0, 1]);
    }

    #[test]
    fn pack_iq() {
        let samples = [100i16, -200, 32767, -32768, 0];
        let msg = pack_iq_message(&samples, 240_000);
        assert_eq!(msg[0], MSG_IQ);
        assert_eq!(
            u32::from_le_bytes([msg[1], msg[2], msg[3], msg[4]]),
            240_000
        );
        assert_eq!(msg[5], 2);
        assert_eq!(msg[6], 0);
        for (i, expected) in samples.iter().enumerate() {
            let off = 7 + i * 2;
            assert_eq!(i16::from_le_bytes([msg[off], msg[off + 1]]), *expected);
        }
        assert_eq!(msg.len(), 1 + 6 + samples.len() * 2);
    }

    #[test]
    fn pack_meta() {
        let meta = ServerMeta {
            msg_type: "welcome".into(),
            center_freq: Some(100.5e6),
            sample_rate: Some(2_400_000),
            fft_size: Some(4096),
            fft_fps: Some(30),
            mode: Some("FM".into()),
            bandwidth: Some(12500),
            dongle_id: Some("dongle-0".into()),
            profile_id: Some("fm-band".into()),
            tune_offset: Some(5000),
            ..Default::default()
        };
        let msg = pack_meta_message(&meta);
        assert_eq!(msg[0], MSG_META);
        let decoded: ServerMeta = serde_json::from_slice(&msg[1..]).unwrap();
        assert_eq!(decoded, meta);
        // Omitted fields must not appear.
        let raw = std::str::from_utf8(&msg[1..]).unwrap();
        assert!(!raw.contains("clientId"));
        assert!(raw.starts_with("{\"type\":\"welcome\""));
    }

    #[test]
    fn pack_rds() {
        let rds = br#"{"ps":"ROCK FM","rt":"Now Playing"}"#;
        let msg = pack_rds_message(rds);
        assert_eq!(msg[0], MSG_RDS);
        assert_eq!(&msg[1..], rds);
    }

    #[test]
    fn parse_commands() {
        let cmd = parse_client_command(
            br#"{"cmd":"subscribe","dongleId":"dongle-0","profileId":"fm-band"}"#,
        )
        .unwrap();
        assert_eq!(cmd.cmd, "subscribe");
        assert_eq!(cmd.dongle_id, "dongle-0");
        assert_eq!(cmd.profile_id, "fm-band");

        let cmd = parse_client_command(br#"{"cmd":"tune","offset":50000}"#).unwrap();
        assert_eq!(cmd.offset, 50000);

        let cmd = parse_client_command(br#"{"cmd":"mode","mode":"USB"}"#).unwrap();
        assert_eq!(cmd.mode, "USB");

        let cmd =
            parse_client_command(br#"{"cmd":"codec","fftCodec":"adpcm","iqCodec":"opus"}"#).unwrap();
        assert_eq!(cmd.fft_codec, "adpcm");
        assert_eq!(cmd.iq_codec, "opus");

        let cmd = parse_client_command(br#"{"cmd":"audio_enabled","enabled":true}"#).unwrap();
        assert_eq!(cmd.enabled, Some(true));

        let cmd = parse_client_command(
            br#"{"cmd":"set_pre_filter_nb_threshold","threshold":12.5}"#,
        )
        .unwrap();
        assert_eq!(cmd.threshold, Some(12.5));
        assert_eq!(cmd.level, 0.0);

        let cmd = parse_client_command(
            br#"{"cmd":"set_pre_filter_nb_threshold","level":8.0}"#,
        )
        .unwrap();
        assert_eq!(cmd.level, 8.0);
        assert_eq!(cmd.threshold, None);

        let cmd = parse_client_command(br#"{"cmd":"deemphasis","deemphasis":50}"#).unwrap();
        assert_eq!(cmd.cmd, "deemphasis");
        assert_eq!(cmd.deemphasis, Some(50.0));

        assert!(parse_client_command(b"not json").is_err());
        assert!(parse_client_command(br#"{"dongleId":"x"}"#).is_err());
    }

    #[test]
    fn dongle_status_meta() {
        let meta = ServerMeta {
            msg_type: "dongle_status".into(),
            dongle_id: Some("d1".into()),
            running: Some(true),
            client_count: Some(3),
            ..Default::default()
        };
        let v = serde_json::to_value(&meta).unwrap();
        assert_eq!(v["type"], "dongle_status");
        assert_eq!(v["dongleId"], "d1");
        assert_eq!(v["running"], true);
        assert_eq!(v["clientCount"], 3);
        assert!(v.get("profileId").is_none());
    }

    #[test]
    fn decoder_message_shape() {
        let msg = pack_decoder_message("ft8", serde_json::json!({"text": "CQ N0CALL"}));
        assert_eq!(msg[0], MSG_DECODER);
        let value: Value = serde_json::from_slice(&msg[1..]).unwrap();
        assert_eq!(value["decoderType"], "ft8");
        assert_eq!(value["data"]["text"], "CQ N0CALL");
    }

    #[test]
    fn decoder_scope_frame_shape() {
        let msg = pack_decoder_scope(14_074_000.0, 12.5, -130.0, 0.0, &[0, 128, 255]);
        assert_eq!(msg[0], MSG_DECODER_SCOPE);
        assert_eq!(msg[1], 1);
        assert_eq!(u32::from_le_bytes(msg[13..17].try_into().unwrap()), 3);
        assert_eq!(f32::from_le_bytes(msg[17..21].try_into().unwrap()), 12.5);
        assert_eq!(i16::from_le_bytes(msg[21..23].try_into().unwrap()), -130);
        assert_eq!(i16::from_le_bytes(msg[23..25].try_into().unwrap()), 0);
        assert_eq!(&msg[25..], &[0, 128, 255]);
    }

    #[test]
    fn user_locations_meta_shape() {
        let msg = pack_meta_message(&ServerMeta {
            msg_type: "user_locations".into(),
            dongle_id: Some("d1".into()),
            users: Some(vec![UserLocation {
                client_id: "abc".into(),
                conn_index: 2,
                profile_id: "p1".into(),
                ip: Some("192.0.2.5".into()),
                frequency_hz: 14_074_000,
                mode: "usb".into(),
                bandwidth: 2_400,
            }]),
            ..Default::default()
        });
        assert_eq!(msg[0], MSG_META);
        let v: serde_json::Value = serde_json::from_slice(&msg[1..]).unwrap();
        assert_eq!(v["type"], "user_locations");
        assert_eq!(v["dongleId"], "d1");
        assert_eq!(v["users"][0]["clientId"], "abc");
        assert_eq!(v["users"][0]["connIndex"], 2);
        assert_eq!(v["users"][0]["frequencyHz"], 14_074_000);
        assert_eq!(v["users"][0]["ip"], "192.0.2.5");
        assert_eq!(v["users"][0]["mode"], "usb");
    }

    #[test]
    fn codec_status_json() {
        let msg = pack_codec_status_message(&CodecStatus {
            fft_codec: "none".into(),
            fft_msg: "codec 'x' not available on this server, using 'none'".into(),
            ..Default::default()
        });
        assert_eq!(msg[0], MSG_META);
        let v: serde_json::Value = serde_json::from_slice(&msg[1..]).unwrap();
        assert_eq!(v["type"], "codec_status");
        assert_eq!(v["fftCodec"], "none");
        assert!(v.get("iqCodec").is_none());
    }

    // ---- V1 tiled waterfall protocol ----

    /// Assert the leading `[type][0x11][tier][0][tileIndex][tileCount]` prefix
    /// and return the offset of the first byte after the tier/tile block.
    fn assert_tiled_prefix(
        msg: &[u8],
        msg_type: u8,
        tier: u8,
        tile_index: u16,
        tile_count: u16,
    ) -> usize {
        assert_eq!(msg[0], msg_type, "type byte");
        assert_eq!(msg[1], 0x11, "verFlags = ver(1) | TILED(0x10)");
        assert_eq!(msg[1] & 0x0F, WF_VER, "version nibble");
        assert_eq!(msg[1] & WF_FLAG_TILED, WF_FLAG_TILED, "TILED bit");
        assert_eq!(msg[1] & 0xE0, 0, "reserved bits must be zero");
        assert_eq!(msg[2], tier, "tier");
        assert_eq!(msg[3], 0, "reserved0");
        assert_eq!(u16::from_le_bytes([msg[4], msg[5]]), tile_index, "tileIndex");
        assert_eq!(u16::from_le_bytes([msg[6], msg[7]]), tile_count, "tileCount");
        8
    }

    #[test]
    fn tiled_fft_raw_bytes() {
        let bins = [1.0f32, -2.5, 300.0];
        let msg = pack_fft_raw_tiled(&bins, 2, 5, 9);
        let off = assert_tiled_prefix(&msg, MSG_FFT, 2, 5, 9);
        for (i, b) in bins.iter().enumerate() {
            let o = off + i * 4;
            assert_eq!(
                f32::from_le_bytes(msg[o..o + 4].try_into().unwrap()),
                *b
            );
        }
        assert_eq!(msg.len(), off + bins.len() * 4);
    }

    #[test]
    fn tiled_fft_compressed_bytes() {
        let bins = [-130.0f32, -65.0, 0.0];
        let msg = pack_fft_compressed_tiled(&bins, -130, 0, 1, 0, 4);
        let off = assert_tiled_prefix(&msg, MSG_FFT_COMPRESSED, 1, 0, 4);
        assert_eq!(
            i16::from_le_bytes([msg[off], msg[off + 1]]),
            -130,
            "minDb"
        );
        assert_eq!(i16::from_le_bytes([msg[off + 2], msg[off + 3]]), 0, "maxDb");
        // Quantized bins must match the shared compress_fft path exactly.
        let expected = compress_fft(&bins, -130.0, 0.0);
        assert_eq!(&msg[off + 4..], &expected[..]);
    }

    #[test]
    fn tiled_fft_adpcm_bytes() {
        let bins = vec![-90.0f32; 16];
        let msg = pack_fft_adpcm_tiled(&bins, 3, 7, 7);
        let off = assert_tiled_prefix(&msg, MSG_FFT_ADPCM, 3, 7, 7);
        // Inner ADPCM payload keeps its own [i16 min][i16 max] header, not
        // duplicated by the tiled wrapper.
        let expected = encode_fft_adpcm(&bins, -130.0, 0.0);
        assert_eq!(&msg[off..], &expected[..]);
        assert_eq!(i16::from_le_bytes([msg[off], msg[off + 1]]), -130);
        assert_eq!(i16::from_le_bytes([msg[off + 2], msg[off + 3]]), 0);
    }

    #[test]
    fn tiled_fft_deflate_bytes() {
        let bins = [-120.0f32, -60.0, -10.0, 0.0];
        let mut enc = FftDeflateEncoder::new(bins.len());
        let msg = pack_fft_deflate_tiled(&bins, -130, 0, 4, 2, 3, &mut enc);
        let off = assert_tiled_prefix(&msg, MSG_FFT_DEFLATE, 4, 2, 3);
        assert_eq!(i16::from_le_bytes([msg[off], msg[off + 1]]), -130, "minDb");
        assert_eq!(i16::from_le_bytes([msg[off + 2], msg[off + 3]]), 0, "maxDb");
        assert_eq!(
            u32::from_le_bytes(msg[off + 4..off + 8].try_into().unwrap()),
            bins.len() as u32,
            "binCount = tile bins"
        );
        // Body must match the shared encoder output for the same inputs.
        let mut enc2 = FftDeflateEncoder::new(bins.len());
        let body = enc2.encode(&bins, -130.0, 0.0).unwrap();
        assert_eq!(&msg[off + 8..], &body[..]);
    }

    #[test]
    fn tiled_fft_history_none_bytes() {
        let frames = vec![vec![-130.0f32, 0.0, -65.0], vec![0.0f32, -130.0, -65.0]];
        let msg = pack_fft_history_tiled(&frames, -130, 0, 0, 1, 1, 2);
        let off = assert_tiled_prefix(&msg, MSG_FFT_HISTORY, 1, 1, 2);
        assert_eq!(u16::from_le_bytes([msg[off], msg[off + 1]]), 2, "frameCount");
        assert_eq!(
            u32::from_le_bytes(msg[off + 2..off + 6].try_into().unwrap()),
            3,
            "binCount"
        );
        assert_eq!(i16::from_le_bytes([msg[off + 6], msg[off + 7]]), -130);
        assert_eq!(i16::from_le_bytes([msg[off + 8], msg[off + 9]]), 0);
        assert_eq!(msg[off + 10], 0, "codec = NONE");
        // Raw payload = quantized frames concatenated.
        let mut expected = Vec::new();
        for f in &frames {
            expected.extend_from_slice(&compress_fft(f, -130.0, 0.0));
        }
        assert_eq!(&msg[off + 11..], &expected[..]);
    }

    #[test]
    fn tiled_fft_history_deflate_adpcm_headers() {
        let frames = vec![vec![-100.0f32; 8], vec![-50.0f32; 8]];
        for codec in [1u8, 2u8] {
            let msg = pack_fft_history_tiled(&frames, -130, 0, codec, 0, 0, 1);
            let off = assert_tiled_prefix(&msg, MSG_FFT_HISTORY, 0, 0, 1);
            assert_eq!(u16::from_le_bytes([msg[off], msg[off + 1]]), 2);
            assert_eq!(
                u32::from_le_bytes(msg[off + 2..off + 6].try_into().unwrap()),
                8
            );
            assert_eq!(msg[off + 10], codec);
            assert!(msg.len() > off + 11, "payload present");
        }
    }

    #[test]
    fn legacy_packers_unchanged() {
        // Non-tiled packers must NOT emit a verFlags byte: byte 1 is still
        // the first payload byte of the legacy layout.
        let raw = pack_fft_message(&[1.0f32, 2.0]);
        assert_eq!(raw[0], MSG_FFT);
        assert_eq!(f32::from_le_bytes(raw[1..5].try_into().unwrap()), 1.0);

        let comp = pack_fft_compressed_message(&[10, 20, 30], -120, 0);
        assert_eq!(comp[0], MSG_FFT_COMPRESSED);
        assert_eq!(i16::from_le_bytes([comp[1], comp[2]]), -120);
        assert_eq!(i16::from_le_bytes([comp[3], comp[4]]), 0);
        assert_eq!(&comp[5..], &[10, 20, 30]);

        let adpcm = pack_fft_adpcm_message(&[0xAA, 0xBB]);
        assert_eq!(adpcm[0], MSG_FFT_ADPCM);
        assert_eq!(&adpcm[1..], &[0xAA, 0xBB]);

        let deflate = pack_fft_deflate_message(&[0x78, 0x9C, 1], -100, -10, 4096);
        assert_eq!(deflate[0], MSG_FFT_DEFLATE);
        assert_eq!(i16::from_le_bytes([deflate[1], deflate[2]]), -100);
        assert_eq!(i16::from_le_bytes([deflate[3], deflate[4]]), -10);
        assert_eq!(u32::from_le_bytes(deflate[5..9].try_into().unwrap()), 4096);
        assert_eq!(&deflate[9..], &[0x78, 0x9C, 1]);
    }

    #[test]
    fn waterfall_view_command_parses() {
        let cmd = parse_client_command(
            br#"{"cmd":"waterfall_view","viewportPx":1920,"startFrac":0.25,"endFrac":0.75,"fps":15}"#,
        )
        .unwrap();
        assert_eq!(cmd.cmd, "waterfall_view");
        assert_eq!(cmd.viewport_px, 1920);
        assert_eq!(cmd.start_frac, 0.25);
        assert_eq!(cmd.end_frac, 0.75);
        assert_eq!(cmd.fps, Some(15));
    }

    #[test]
    fn waterfall_meta_fields_optional() {
        // Absent by default.
        let meta = ServerMeta {
            msg_type: "welcome".into(),
            ..Default::default()
        };
        let v = serde_json::to_value(&meta).unwrap();
        assert!(v.get("waterfallProtocol").is_none());
        assert!(v.get("waterfallTileBins").is_none());

        // Present when set.
        let meta = ServerMeta {
            msg_type: "subscribed".into(),
            waterfall_protocol: Some(1),
            waterfall_tile_bins: Some(1024),
            ..Default::default()
        };
        let v = serde_json::to_value(&meta).unwrap();
        assert_eq!(v["waterfallProtocol"], 1);
        assert_eq!(v["waterfallTileBins"], 1024);
    }
}
