//! WebSocket binary protocol for no-sdr.
//!
//! Server -> client messages use a single type-byte prefix followed by
//! little-endian typed array payloads. Client -> server messages are JSON text.
//!
//! This is a byte-for-byte port of `serverng/internal/ws/protocol.go`.

use serde::{Deserialize, Serialize};

// Message type bytes (server -> client)
pub const MSG_FFT: u8 = 0x01; // Float32Array (dB magnitudes)
pub const MSG_IQ: u8 = 0x02; // Int16Array (interleaved I/Q)
pub const MSG_META: u8 = 0x03; // UTF-8 JSON (ServerMeta)
pub const MSG_FFT_COMPRESSED: u8 = 0x04; // Int16(minDb) + Int16(maxDb) + Uint8[N]
pub const MSG_AUDIO: u8 = 0x05; // Int16Array mono samples
pub const MSG_DECODER: u8 = 0x06; // JSON-encoded decoder messages
pub const MSG_SIGNAL_LEVEL: u8 = 0x07; // Float32 dB value
pub const MSG_FFT_ADPCM: u8 = 0x08; // ADPCM on Int16(dB x 100)
pub const MSG_IQ_ADPCM: u8 = 0x09; // Uint32(sampleCount) + ADPCM bytes
pub const MSG_RDS: u8 = 0x0A; // UTF-8 JSON (RDS data)
pub const MSG_FFT_DEFLATE: u8 = 0x0B; // Int16(minDb) + Int16(maxDb) + Uint32(binCount) + deflate
pub const MSG_AUDIO_OPUS: u8 = 0x0C; // Uint16(sampleCount) + Uint8(channels) + Opus packet
pub const MSG_FFT_HISTORY: u8 = 0x0D; // Waterfall history burst

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub muted: Option<bool>,
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

        assert!(parse_client_command(b"not json").is_err());
        assert!(parse_client_command(br#"{"dongleId":"x"}"#).is_err());
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
}
