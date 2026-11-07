//! IQ data source abstraction.
//!
//! Mirrors `serverng/internal/dongle/source.go`.

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use tokio::sync::{mpsc, watch};

/// Commands understood by rtl_tcp-compatible sources.
#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub(crate) enum SourceCommand {
    /// Raw rtl_tcp command byte + big-endian u32 payload.
    Raw { cmd: u8, value: u32 },
    /// Stop the command writer task.
    Close,
}

/// Handle used to tune a running source.
///
/// The handle owns an unbounded channel feeding a writer task, so command
/// methods are synchronous and never block the caller.
#[derive(Clone)]
pub struct CommandHandle {
    tx: mpsc::UnboundedSender<SourceCommand>,
}

impl CommandHandle {
    pub(crate) fn new(tx: mpsc::UnboundedSender<SourceCommand>) -> Self {
        Self { tx }
    }

    pub fn command(&self, cmd: u8, value: u32) -> Result<()> {
        self.tx
            .send(SourceCommand::Raw { cmd, value })
            .map_err(|_| anyhow!("source command channel closed"))
    }

    pub fn set_frequency(&self, hz: u32) -> Result<()> {
        self.command(0x01, hz)
    }

    pub fn set_sample_rate(&self, hz: u32) -> Result<()> {
        self.command(0x02, hz)
    }

    pub fn set_gain_mode(&self, mode: u32) -> Result<()> {
        self.command(0x03, mode)
    }

    pub fn set_gain(&self, tenths_db: u32) -> Result<()> {
        self.command(0x04, tenths_db)
    }

    pub fn set_frequency_correction(&self, ppm: u32) -> Result<()> {
        self.command(0x05, ppm)
    }

    pub fn set_agc_mode(&self, mode: u32) -> Result<()> {
        self.command(0x08, mode)
    }

    pub fn set_direct_sampling(&self, mode: u32) -> Result<()> {
        self.command(0x09, mode)
    }

    pub fn set_offset_tuning(&self, mode: u32) -> Result<()> {
        self.command(0x0A, mode)
    }

    pub fn set_bias_t(&self, enabled: u32) -> Result<()> {
        self.command(0x0E, enabled)
    }

    /// RSP-specific: RF gain reduction (20-59 dB).
    pub fn set_rf_gain_reduction(&self, db: u32) -> Result<()> {
        self.command(0x20, db)
    }

    /// RSP-specific: LNA state.
    pub fn set_lna_state(&self, state: u32) -> Result<()> {
        self.command(0x21, state)
    }

    /// RSP-specific: antenna port.
    pub fn set_antenna_port(&self, port: u32) -> Result<()> {
        self.command(0x22, port)
    }

    /// RSP-specific: broadcast notch filter.
    pub fn set_notch_filter(&self, enabled: u32) -> Result<()> {
        self.command(0x23, enabled)
    }

    /// RSP-specific: reference clock output.
    pub fn set_ref_clock(&self, enabled: u32) -> Result<()> {
        self.command(0x24, enabled)
    }
}

/// Interface implemented by every IQ data source.
#[async_trait]
pub trait Source: Send {
    /// Streams raw uint8 interleaved IQ chunks until cancelled or the source
    /// fails. Consumes the source; the manager keeps a `CommandHandle` to tune
    /// it while running.
    async fn run(self: Box<Self>, out: mpsc::Sender<Vec<u8>>, cancel: watch::Receiver<bool>);

    /// Returns a handle for tune commands, or `None` for non-commandable
    /// sources (e.g. the demo generator).
    fn command_handle(&self) -> Option<CommandHandle> {
        None
    }

    /// Human-readable description for logs.
    fn description(&self) -> String;
}
