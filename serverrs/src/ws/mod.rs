//! WebSocket protocol, client state and connection manager.
//!
//! Wire-compatible with the original Go implementation.

pub mod client;
pub mod manager;
pub mod protocol;
pub mod ratelimit;

pub use client::{
    AllowedCodecs, Client, ClientInfo, ClientState, Outgoing, WriteQueue, DEFAULT_WRITE_CH_SIZE,
};
pub use manager::{SharedWsManager, UpgradeQuery, WsManager, SERVER_VERSION};
pub use protocol::{
    pack_audio_message, pack_audio_opus_message, pack_codec_status_message,
    pack_decoder_message, pack_fft_adpcm_message, pack_fft_compressed_message, pack_fft_deflate_message,
    pack_fft_message, pack_iq_adpcm_message, pack_iq_message, pack_meta_message,
    pack_rds_message, pack_signal_level_message, parse_client_command, ClientCommand,
    CodecStatus, ServerMeta, MSG_AUDIO, MSG_AUDIO_OPUS, MSG_DECODER, MSG_FFT, MSG_FFT_ADPCM,
    MSG_FFT_COMPRESSED, MSG_FFT_DEFLATE, MSG_FFT_HISTORY, MSG_IQ, MSG_IQ_ADPCM, MSG_META,
    MSG_RDS, MSG_SIGNAL_LEVEL,
};
pub use ratelimit::RateLimiter;
