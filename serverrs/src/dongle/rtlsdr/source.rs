//! The blocking sample loop for a locally attached RTL-SDR.
//!
//! nusb's bulk API is queue-based: keep a handful of transfers in flight on
//! endpoint `0x81`, then drain completions and hand the raw 8-bit I/Q to the
//! manager. One `spawn_blocking` thread owns both the device and the command
//! channel, which preserves the driver's rule that register I/O never overlaps
//! with itself — the tuner sits behind a global I2C repeater on the demodulator.

use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use nusb::transfer::{Bulk, In, TransferError};
use nusb::Endpoint;
use nusb::MaybeFuture;
use tokio::sync::{mpsc, watch};
use tracing::{debug, error, info, warn};

use crate::dongle::source::{CommandHandle, Source, SourceCommand};

use super::config::RtlSdrHfMode;
use super::config::{RtlSdrAgc, RtlSdrConfig};
use super::device::Device;

/// The bulk IN endpoint carrying the sample stream.
const BULK_EP: u8 = 0x81;

/// How long to wait for a transfer before going back to serve control
/// messages. Short enough that a retune feels immediate, long enough that an
/// idle loop costs nothing.
const COMPLETE_TIMEOUT: Duration = Duration::from_millis(5);

/// Bounds on the advanced transfer settings, so a bad config file cannot wedge
/// the stream.
const MIN_TRANSFERS: usize = 4;
const MAX_TRANSFERS: usize = 64;
const MIN_TRANSFER_KIB: usize = 2;
const MAX_TRANSFER_KIB: usize = 256;

/// The endpoint's packet size. Every transfer length must be a multiple of it.
const BULK_PACKET: usize = 512;

/// Consecutive endpoint stalls tolerated before the stream is declared dead.
/// A healthy dongle never stalls; a repeating stall means the link cannot
/// carry the rate (USB 1.1 hub, bad cable) or the device is wedged, and
/// clearing the halt in a loop just burns CPU.
const MAX_STALLS: u32 = 10;

/// Where the dongle is left until the manager sends the user's tuning.
const DEFAULT_CENTER_HZ: f64 = 100_000_000.0;

/// A locally attached RTL-SDR driven by the native USB backend.
pub struct RtlSdrSource {
    device: Option<Device>,
    index: i32,
    label: String,
    cfg: RtlSdrConfig,
    cmd_rx: Option<mpsc::UnboundedReceiver<SourceCommand>>,
    cmd_handle: CommandHandle,
}

impl RtlSdrSource {
    /// Opens the dongle selected by serial (preferred) or USB index at the
    /// configured sample rate.
    ///
    /// The device is opened here, on the manager's blocking task, and then
    /// moved into the stream thread by [`Source::run`]. No register access
    /// happens concurrently with the stream, so the one-thread invariant holds.
    ///
    /// The rate must be the manager's resolved dongle rate rather than the
    /// driver default: opening at 2.4 MSPS and retuning only once the command
    /// loop starts both misreports the stream rate in logs and makes a dongle
    /// that cannot sustain 2.4 MSPS fail before the user's rate is applied.
    pub fn open(device_index: i32, serial: &str, sample_rate_hz: i32) -> Result<Self> {
        Self::open_with_settings(device_index, serial, sample_rate_hz, &Default::default())
    }

    /// Opens the dongle, applying the operator's `source.settings` overrides.
    ///
    /// `transfers` / `transferKib` bound the in-flight bulk geometry. They are
    /// the lever for hosts whose USB stack cannot keep up (old EHCI
    /// controllers, hubs, USB 1.1 ports): fewer, larger transfers reduce URB
    /// churn, more, smaller ones reduce FIFO-overflow stalls.
    pub fn open_with_settings(
        device_index: i32,
        serial: &str,
        sample_rate_hz: i32,
        settings: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<Self> {
        let mut cfg = RtlSdrConfig {
            device_index: device_index.max(0) as usize,
            sample_rate_hz: if sample_rate_hz > 0 {
                sample_rate_hz as f64
            } else {
                RtlSdrConfig::default().sample_rate_hz
            },
            ..RtlSdrConfig::default()
        };
        if let Some(v) = settings.get("transfers").and_then(|v| v.as_u64()) {
            cfg.transfers = v.clamp(MIN_TRANSFERS as u64, MAX_TRANSFERS as u64) as u8;
        }
        if let Some(v) = settings
            .get("transferKib")
            .or_else(|| settings.get("transfer_kib"))
            .and_then(|v| v.as_u64())
        {
            cfg.transfer_kib =
                v.clamp(MIN_TRANSFER_KIB as u64, MAX_TRANSFER_KIB as u64) as u16;
        }
        let serial = serial.trim();
        if !serial.is_empty() {
            cfg.serial = Some(serial.to_string());
        }

        let device = Device::open(&cfg, DEFAULT_CENTER_HZ)
            .with_context(|| format!("open local rtlsdr #{device_index} (serial {serial:?})"))?;
        let label = device.label().to_string();
        info!(
            index = device_index,
            label = %label,
            tuner = %device.tuner_name(),
            blog_v4 = device.is_blog_v4(),
            speed = ?device.usb().speed(),
            transfers = cfg.transfers,
            transfer_kib = cfg.transfer_kib,
            "rtlsdr device opened"
        );

        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        Ok(Self {
            device: Some(device),
            index: device_index,
            label,
            cfg,
            cmd_rx: Some(cmd_rx),
            cmd_handle: CommandHandle::new(cmd_tx),
        })
    }

    pub fn index(&self) -> i32 {
        self.index
    }
}

#[async_trait]
impl Source for RtlSdrSource {
    async fn run(self: Box<Self>, out: mpsc::Sender<Vec<u8>>, cancel: watch::Receiver<bool>) {
        let mut this = *self;
        let Some(device) = this.device.take() else {
            error!(index = this.index, "rtlsdr source has no device");
            return;
        };
        let Some(cmd_rx) = this.cmd_rx.take() else {
            error!(index = this.index, "rtlsdr source has no command channel");
            return;
        };
        let cfg = this.cfg.clone();
        let index = this.index;

        let result =
            tokio::task::spawn_blocking(move || run_stream(device, cfg, cmd_rx, out, cancel)).await;

        match result {
            Ok(Ok(())) => debug!(index, "rtlsdr read loop stopped"),
            Ok(Err(e)) => error!(index, error = %e, "rtlsdr read loop failed"),
            Err(e) => error!(index, error = %e, "rtlsdr read task failed"),
        }
    }

    fn command_handle(&self) -> Option<CommandHandle> {
        Some(self.cmd_handle.clone())
    }

    fn sample_rate_hz(&self) -> Option<u32> {
        self.device
            .as_ref()
            .map(|dev| dev.sample_rate().round() as u32)
    }

    fn description(&self) -> String {
        format!("local rtlsdr #{} ({})", self.index, self.label)
    }
}

fn geometry(cfg: &RtlSdrConfig) -> (usize, usize) {
    let transfers = (cfg.transfers as usize).clamp(MIN_TRANSFERS, MAX_TRANSFERS);
    let kib = (cfg.transfer_kib as usize).clamp(MIN_TRANSFER_KIB, MAX_TRANSFER_KIB);
    let bytes = (kib * 1024 / BULK_PACKET).max(1) * BULK_PACKET;
    (transfers, bytes)
}

/// Applies every queued command in order. Returns `true` when the source was
/// asked to close.
///
/// `ep` is given while streaming so a command that reinitialises the endpoint
/// (`SET_DIRECT_SAMPLING`) can quiesce the bulk queue first: resetting the
/// endpoint underneath in-flight URBs is what makes them come back as stalls.
fn drain_commands(
    dev: &mut Device,
    cmd_rx: &mut mpsc::UnboundedReceiver<SourceCommand>,
    tuner_auto: &mut bool,
    rtl_auto: &mut bool,
    gain_db: &mut f64,
    mut ep: Option<&mut Endpoint<Bulk, In>>,
) -> bool {
    loop {
        let Ok(cmd) = cmd_rx.try_recv() else {
            return false;
        };
        match cmd {
            SourceCommand::Raw { cmd, value } => {
                // Direct sampling powers the tuner down, re-inits it and resets
                // the endpoint; do that with an empty transfer queue.
                if cmd == 0x09 {
                    if let Some(ep) = ep.as_deref_mut() {
                        ep.cancel_all();
                        let deadline = Instant::now() + Duration::from_millis(200);
                        while ep.pending() > 0 && Instant::now() < deadline {
                            if ep.wait_next_complete(Duration::from_millis(20)).is_none() {
                                break;
                            }
                        }
                    }
                }
                if let Err(e) = apply_command(dev, cmd, value, tuner_auto, rtl_auto, gain_db) {
                    warn!(
                        cmd = format!("{cmd:#04x}"),
                        value,
                        error = %e,
                        "rtlsdr command failed"
                    );
                }
            }
            SourceCommand::Close => return true,
        }
    }
}

fn run_stream(
    mut dev: Device,
    cfg: RtlSdrConfig,
    mut cmd_rx: mpsc::UnboundedReceiver<SourceCommand>,
    out: mpsc::Sender<Vec<u8>>,
    cancel: watch::Receiver<bool>,
) -> Result<()> {
    let (in_flight, xfer_bytes) = geometry(&cfg);
    let mut ep = dev
        .usb()
        .interface()
        .endpoint::<Bulk, In>(BULK_EP)
        .map_err(|e| anyhow!("cannot open the rtlsdr bulk endpoint: {e}"))?;

    // The manager queues the profile's tuning/gain/direct-sampling batch right
    // after opening the device, so it is already here. Apply it BEFORE arming
    // the bulk endpoint: librtlsdr (and therefore rtl_tcp) resets the buffer
    // only after all setup commands, and arming first leaves the first URBs
    // racing the rate/LO programming — the stall loop old hosts hit.
    let mut tuner_auto = cfg.agc.tuner_auto();
    let mut rtl_auto = cfg.agc.rtl_auto();
    let mut gain_db = cfg.tuner_gain_db;
    if drain_commands(
        &mut dev,
        &mut cmd_rx,
        &mut tuner_auto,
        &mut rtl_auto,
        &mut gain_db,
        None,
    ) {
        dev.shutdown();
        return Ok(());
    }

    dev.reset_buffer()?;
    for _ in 0..in_flight {
        ep.submit(ep.allocate(xfer_bytes));
    }

    let speed = dev.usb().speed();
    info!(
        transfers = in_flight,
        transfer_kib = xfer_bytes / 1024,
        rate_hz = dev.sample_rate(),
        speed = ?speed,
        "rtlsdr streaming"
    );
    if matches!(speed, Some(nusb::Speed::Low) | Some(nusb::Speed::Full))
        && dev.sample_rate() > 1_024_000.0
    {
        warn!(
            speed = ?speed,
            rate_hz = dev.sample_rate(),
            "USB link is full-speed (USB 1.1) but the sample rate needs a \
             high-speed link: the bulk endpoint will stall. Use a USB 2.0 port \
             or drop to ~1 MSPS (or run rtl_tcp on a host where the dongle \
             enumerates at high speed)"
        );
    }

    // A short transfer can end on an odd byte. Dropping it would swap I and Q
    // for the rest of the session, so carry it into the next completion.
    let mut odd_carry: Option<u8> = None;
    let mut shutdown = false;
    let mut last_data = Instant::now();
    let mut constant_run = 0u32;
    let mut stalls = 0u32;

    loop {
        if *cancel.borrow() {
            debug!("rtlsdr read loop cancelled");
            break;
        }

        // Collapse the command channel between transfers. A retune costs
        // milliseconds of I2C, so apply whatever is queued in order rather
        // than letting a dial drag back up behind the operator's hand.
        if drain_commands(
            &mut dev,
            &mut cmd_rx,
            &mut tuner_auto,
            &mut rtl_auto,
            &mut gain_db,
            Some(&mut ep),
        ) {
            shutdown = true;
        }
        if shutdown {
            break;
        }

        // Refill before draining so the device always has a transfer armed.
        while ep.pending() < in_flight {
            ep.submit(ep.allocate(xfer_bytes));
        }

        // A dongle that stops delivering samples, or delivers the same byte
        // forever, is wedged even though USB still reports success. Reopening
        // is the only recovery short of replugging; let the manager's retry
        // loop do it rather than feeding the client a constant stream.
        if last_data.elapsed() > Duration::from_secs(3) {
            return Err(anyhow!(
                "no IQ samples for {} s; reinitialising the RTL-SDR",
                last_data.elapsed().as_secs()
            ));
        }

        let Some(completion) = ep.wait_next_complete(COMPLETE_TIMEOUT) else {
            continue;
        };

        let mut buf = completion.buffer;
        match completion.status {
            Ok(()) => {
                let data = take_even(&buf, &mut odd_carry);
                if !data.is_empty() {
                    last_data = Instant::now();
                    stalls = 0;
                    if data.iter().all(|b| *b == data[0]) {
                        constant_run += 1;
                        if constant_run >= 500 {
                            return Err(anyhow!(
                                "RTL-SDR IQ stream is constant ({} bytes of {:#04x}); \
                                 reinitialising the device",
                                data.len(),
                                data[0]
                            ));
                        }
                    } else {
                        constant_run = 0;
                    }
                    if out.blocking_send(data).is_err() {
                        debug!("rtlsdr output channel closed");
                        break;
                    }
                }
            }
            Err(TransferError::Disconnected) => {
                return Err(anyhow!("the RTL-SDR was unplugged"));
            }
            Err(TransferError::Stall) => {
                stalls += 1;
                if stalls > MAX_STALLS {
                    return Err(anyhow!(
                        "the RTL-SDR bulk endpoint stalled {stalls} times in a row at \
                         {:.2} MSPS (USB {:?}). A dongle on a high-speed link that \
                         streams fine under rtl_tcp/librtlsdr points at the endpoint \
                         being reset while reads are queued (direct sampling) or at \
                         the host's URB handling, not at raw link throughput. Try the \
                         transfer overrides (source.settings.transfers / transferKib) \
                         or rtl_tcp as the fallback, and include this log line in a \
                         bug report",
                        dev.sample_rate() / 1e6,
                        dev.usb().speed()
                    ));
                }
                // Warn about the first stalls, then keep quiet: a burst of them
                // is the same problem and would flood the log.
                if stalls <= 3 {
                    warn!(
                        stalls,
                        speed = ?dev.usb().speed(),
                        rate_hz = dev.sample_rate(),
                        "rtlsdr endpoint stalled; clearing and resynchronising"
                    );
                } else {
                    debug!(stalls, "rtlsdr endpoint stalled again");
                }
                let _ = ep.clear_halt().wait();
                dev.reset_buffer()?;
                odd_carry = None;
            }
            Err(TransferError::Cancelled) => {}
            Err(e) => debug!(error = %e, "rtlsdr transfer error"),
        }

        buf.clear();
        ep.submit(buf);
    }

    // Cancel outstanding transfers and let them come back before the interface
    // is dropped.
    ep.cancel_all();
    let deadline = Instant::now() + Duration::from_millis(500);
    while ep.pending() > 0 && Instant::now() < deadline {
        if ep.wait_next_complete(Duration::from_millis(50)).is_none() {
            break;
        }
    }

    dev.shutdown();
    Ok(())
}

/// Keep the returned buffer an even number of bytes, carrying a trailing odd
/// byte into the next transfer so I/Q pairing never shifts.
fn take_even(bytes: &[u8], carry: &mut Option<u8>) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + 1);
    if let Some(c) = carry.take() {
        out.push(c);
    }
    out.extend_from_slice(bytes);
    if out.len() % 2 == 1 {
        *carry = out.pop();
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn apply_command(
    dev: &mut Device,
    cmd: u8,
    value: u32,
    tuner_auto: &mut bool,
    rtl_auto: &mut bool,
    gain_db: &mut f64,
) -> Result<()> {
    match cmd {
        0x01 => dev.set_center(value as f64)?,
        // Re-programming the rate also moves the tuner filter, the IF and the
        // LO, so leave the hardware alone when the command matches what it is
        // already producing (the manager sends the initial rate again after
        // opening the device at that same rate).
        0x02 => {
            let requested = value as f64;
            if (dev.sample_rate() - requested).abs() >= 1.0 {
                dev.set_sample_rate(requested)?;
            }
        }
        // rtl_tcp gain mode: 0 = automatic tuner gain, 1 = manual.
        0x03 => {
            *tuner_auto = value == 0;
            info!(
                tuner_auto = *tuner_auto,
                rtl_auto = *rtl_auto,
                "tuner gain mode set"
            );
            dev.set_agc(RtlSdrAgc::from_parts(*tuner_auto, *rtl_auto))?;
            if !*tuner_auto {
                // The manager follows the mode with an explicit SET_GAIN, which
                // logs the hardware step; keep this one at debug to avoid two
                // identical info lines per switch.
                let eff = dev.set_gain_db(*gain_db)?;
                debug!(requested_db = *gain_db, effective_db = eff, "tuner gain re-asserted with mode");
            }
        }
        // Tenths of a dB, as carried by rtl_tcp.
        0x04 => {
            *gain_db = value as f64 / 10.0;
            if !*tuner_auto {
                // The R820T only offers a discrete gain table; report the step
                // the hardware actually selected, not just what we asked for.
                let eff = dev.set_gain_db(*gain_db)?;
                info!(
                    requested_db = *gain_db,
                    effective_db = eff,
                    "tuner gain applied (snapped to hardware step)"
                );
            }
        }
        0x05 => dev.set_ppm(value as i32)?,
        // RTL digital AGC, independent of the tuner's own loop.
        0x08 => {
            *rtl_auto = value != 0;
            dev.set_agc(RtlSdrAgc::from_parts(*tuner_auto, *rtl_auto))?;
        }
        // Direct sampling. librtlsdr encodes 1 = I-ADC and 2 = Q-ADC; no
        // shipping dongle wires its HF port to I, so both select Q.
        0x09 => {
            let mode = match value {
                0 => RtlSdrHfMode::Off,
                1 | 2 => RtlSdrHfMode::DirectQ,
                _ => RtlSdrHfMode::Off,
            };
            dev.set_hf_mode(mode)?;
        }
        // librtlsdr rejects offset tuning on every R82xx part; there is no
        // hardware mode to select.
        0x0A => {
            if value != 0 {
                warn!("rtlsdr: offset tuning is not supported by the R82xx tuner; ignoring");
            }
        }
        0x0E => dev.set_bias_tee(value != 0)?,
        _ => debug!(
            cmd = format!("{cmd:#04x}"),
            value, "unhandled rtlsdr command"
        ),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn odd_transfers_never_shift_iq_phase() {
        let stream: Vec<u8> = (0..64u8).collect();
        let mut carry = None;
        let mut out = Vec::new();
        let mut pos = 0;

        for chunk in [3usize, 5, 7, 1, 9, 2, 11, 6, 13, 7] {
            let end = (pos + chunk).min(stream.len());
            if pos >= end {
                break;
            }
            out.extend_from_slice(&take_even(&stream[pos..end], &mut carry));
            pos = end;
        }

        assert_eq!(pos, stream.len());
        assert_eq!(out.len() % 2, 0);
        if let Some(c) = carry {
            out.push(c);
        }
        assert_eq!(out, stream, "odd-length chunking must not shift I/Q phase");
    }

    #[test]
    fn geometry_rounds_to_whole_packets() {
        let mut cfg = RtlSdrConfig::default();
        let (n, bytes) = geometry(&cfg);
        assert_eq!(n, 16);
        assert_eq!(bytes % BULK_PACKET, 0);

        cfg.transfers = 0;
        cfg.transfer_kib = 0;
        let (n, bytes) = geometry(&cfg);
        assert_eq!(n, MIN_TRANSFERS);
        assert!(bytes >= BULK_PACKET && bytes % BULK_PACKET == 0);

        cfg.transfers = 255;
        cfg.transfer_kib = 4096;
        let (n, bytes) = geometry(&cfg);
        assert_eq!(n, MAX_TRANSFERS);
        assert_eq!(bytes, MAX_TRANSFER_KIB * 1024);
    }
}
