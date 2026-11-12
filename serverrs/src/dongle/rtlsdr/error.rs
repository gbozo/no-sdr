//! Errors, and the translation of USB failures into sentences an operator can
//! act on.
//!
//! Everything here ends up in front of a user: [`crate::dongle::rtlsdr::Error`] is what
//! `RtlSdrSource::open` returns and what `IqSource::open_status` puts on
//! screen. "permission denied (os error 13)" tells nobody what to do; "install
//! the udev rule and re-plug the dongle" does.

use std::fmt;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// No dongle matched — either none is plugged in, or none with the
    /// configured serial.
    #[error("{0}")]
    NotFound(String),

    /// The device is there but we cannot have it. Carries the actionable
    /// sentence, not the errno.
    #[error("{0}")]
    Access(String),

    /// A USB transfer failed.
    #[error("USB {op} failed: {source}")]
    Transfer {
        op: &'static str,
        source: nusb::transfer::TransferError,
    },

    /// A control transfer returned fewer bytes than the register read needed.
    #[error("short control read at {block:?} 0x{addr:04x}: wanted {want} bytes, got {got}")]
    ShortRead {
        block: &'static str,
        addr: u16,
        want: usize,
        got: usize,
    },

    /// The tuner chip is not one this driver drives.
    #[error(
        "unsupported tuner {0} — this driver handles R820T/R820T2/R828D; \
         use the SoapySDR backend for this dongle"
    )]
    UnsupportedTuner(String),

    /// A setting the hardware cannot produce.
    #[error("{0}")]
    Unsupported(String),

    /// The `rtl_tcp` link failed, or what answered on the far end was not an
    /// `rtl_tcp` server. Carries the sentence, like [`Error::Access`]: the
    /// remedies here are a hostname, a port, a firewall or a server that is
    /// not running, and none of those are visible in an errno.
    #[error("{0}")]
    Net(String),

    /// The tuner PLL failed to lock, so the radio is receiving noise rather
    /// than the requested frequency. Worth surfacing loudly: the symptom is
    /// otherwise indistinguishable from a dead antenna.
    #[error("tuner PLL did not lock at {0:.6} MHz")]
    PllUnlocked(f64),

    #[error("USB error: {0}")]
    Usb(#[from] nusb::Error),
}

/// Fold the tuner driver's errors into this crate's.
///
/// [`Error::PllUnlocked`] survives as itself rather than collapsing into a
/// string, because it is the one tuner failure this crate reasons about — a
/// dongle that streams noise because its synthesiser never locked looks exactly
/// like a dead antenna, and the distinction has to reach the operator.
impl From<crate::dongle::rtlsdr::r82xx::Error> for Error {
    fn from(e: crate::dongle::rtlsdr::r82xx::Error) -> Error {
        match e {
            crate::dongle::rtlsdr::r82xx::Error::PllUnlocked(mhz) => Error::PllUnlocked(mhz),
            other => Error::Unsupported(other.to_string()),
        }
    }
}

impl Error {
    /// Translate a device-open failure into an instruction.
    ///
    /// The three cases below are the entire support burden of this backend, so
    /// they are worth naming precisely. `EBUSY` in particular is nearly always
    /// another SDR program still holding the dongle, not a broken install.
    pub fn from_open(e: nusb::Error, what: &dyn fmt::Display) -> Error {
        use nusb::ErrorKind;
        match e.kind() {
            ErrorKind::PermissionDenied => Error::Access(format!(
                "permission denied opening {what} — install the udev rule \
                 (see the README) and re-plug the dongle"
            )),
            ErrorKind::Busy => Error::Access(format!(
                "{what} is held by another program (rtl_tcp, SDR#, gqrx, a \
                 SoapySDR client) or by the DVB kernel driver"
            )),
            // On Windows the dongle must be bound to WinUSB before anything can
            // claim it; unbound, the open fails as unsupported or not-found
            // rather than as a permission problem.
            ErrorKind::Unsupported | ErrorKind::NotFound if cfg!(windows) => {
                Error::Access(format!(
                    "{what} is not bound to WinUSB — run Zadig and select the \
                 WinUSB driver for this device (it stops working as a TV tuner \
                 afterwards)"
                ))
            }
            ErrorKind::Disconnected => {
                Error::NotFound(format!("{what} was unplugged while opening it"))
            }
            // macOS passes unrecognised IOKit failures through as a bare hex
            // `IOReturn`, and the one that actually shows up here —
            // kIOReturnNoResources, 0xe00002be, from claiming an interface on a
            // device that is mid-hotplug — tells an operator nothing. Both
            // remedies are physical.
            ErrorKind::Other if cfg!(target_os = "macos") => Error::Access(format!(
                "cannot open {what}: {e} — quit any other SDR software holding \
                 the dongle, then unplug it and plug it back in"
            )),
            _ => Error::Access(format!("cannot open {what}: {e}")),
        }
    }
}
