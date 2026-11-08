//! Dongle sources, manager, recording, notifications and Opus pipeline.
//!
//! Mirrors `serverng/internal/dongle`.

pub mod demo;
pub mod manager;
pub mod opus_pipeline;
pub mod recorder;
pub mod rtlsdr;
pub mod rtltcp;
pub mod source;

pub use demo::{DemoConfig, DemoSource, SignalConfig};
pub use manager::{
    default_bandwidth_for_mode, output_rate_for_mode, ConfigNotification, DongleInfo, DongleState,
    Manager, ServerConfigInfo, STATUS_ERROR, STATUS_RETRYING, STATUS_RUNNING, STATUS_STARTING,
    STATUS_STOPPED,
};
pub use opus_pipeline::{
    bitrate_for_quality, channels_for_mode, OpusPipeline, OpusPipelineConfig, OpusResult,
};
pub use recorder::{Recorder, RecordingStatus};
pub use rtlsdr::{enumerate_local_devices, LocalDeviceInfo, RtlSdrSource};
pub use rtltcp::{spawn_rtl_tcp, RtlDongleInfo, RtlTcpSource};
pub use source::{CommandHandle, Source};
