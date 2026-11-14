//! Knobs the native RTL-SDR driver needs to open and stream a dongle.
//!
//! This is deliberately a small local type rather than the YAML `DongleConfig`:
//! the manager applies the user's settings through the same `SourceCommand`
//! channel used for `rtl_tcp`, so by the time the driver is open only the
//! defaults below matter. Keeping it here also avoids a dependency on the
//! configuration layer from the USB code.

/// How an RTL-SDR reaches HF. The R82xx tuner starts at 24 MHz, so anything
/// below that needs help from the dongle's hardware.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RtlSdrHfMode {
    /// Tuner only — nothing below 24 MHz.
    Off,
    /// Use whatever this dongle has: the V4's upconverter, or direct sampling
    /// on a V3. Switched automatically at the crossover.
    #[default]
    Auto,
    /// Force direct sampling on the ADC's Q branch (the V3's HF port). Has no
    /// meaning on a Blog V4, which upconverts instead.
    DirectQ,
}

impl RtlSdrHfMode {
    /// Paired with [`Self::from_code`]; keep the two in step.
    pub fn code(self) -> u8 {
        match self {
            RtlSdrHfMode::Off => 0,
            RtlSdrHfMode::Auto => 1,
            RtlSdrHfMode::DirectQ => 2,
        }
    }

    pub fn from_code(code: u8) -> RtlSdrHfMode {
        match code {
            0 => RtlSdrHfMode::Off,
            2 => RtlSdrHfMode::DirectQ,
            _ => RtlSdrHfMode::Auto,
        }
    }
}

/// Which automatic gain loops to enable. The tuner AGC lives in the R82xx;
/// the RTL AGC is the demod's digital one. They are independent and can both
/// run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RtlSdrAgc {
    /// Manual tuner gain, no automatic loops.
    #[default]
    Manual,
    Tuner,
    Rtl,
    Both,
}

impl RtlSdrAgc {
    /// Whether the R82xx runs its own LNA/mixer gain loop.
    pub fn tuner_auto(self) -> bool {
        matches!(self, RtlSdrAgc::Tuner | RtlSdrAgc::Both)
    }

    /// Whether the demod's digital AGC runs.
    pub fn rtl_auto(self) -> bool {
        matches!(self, RtlSdrAgc::Rtl | RtlSdrAgc::Both)
    }

    /// Compose the two independent switches into the enum the driver takes.
    pub fn from_parts(tuner_auto: bool, rtl_auto: bool) -> RtlSdrAgc {
        match (tuner_auto, rtl_auto) {
            (false, false) => RtlSdrAgc::Manual,
            (true, false) => RtlSdrAgc::Tuner,
            (false, true) => RtlSdrAgc::Rtl,
            (true, true) => RtlSdrAgc::Both,
        }
    }
}

/// Defaults used while a dongle is being opened. The manager sends the user's
/// actual values as commands immediately afterwards.
#[derive(Debug, Clone)]
pub struct RtlSdrConfig {
    /// USB serial of the dongle to open, if it has a meaningful one.
    pub serial: Option<String>,
    /// Position among the matching dongles when no serial is set (0 = first).
    pub device_index: usize,
    /// Sample rate in Hz. The resampler only reaches 225–300 kHz and
    /// 900 kHz–3.2 MHz; everything between is rejected by the hardware.
    pub sample_rate_hz: f64,
    /// Crystal error in parts per million.
    pub ppm: i32,
    /// Tuner gain in dB when AGC is off. Snapped to the nearest hardware step.
    pub tuner_gain_db: f64,
    pub agc: RtlSdrAgc,
    pub hf_mode: RtlSdrHfMode,
    /// Bias tee: DC on the antenna coax for a remote LNA.
    pub bias_tee: bool,
    /// Bulk transfers kept in flight (advanced).
    pub transfers: u8,
    /// Size of each bulk transfer in KiB (advanced).
    pub transfer_kib: u16,
}

impl Default for RtlSdrConfig {
    fn default() -> Self {
        RtlSdrConfig {
            serial: None,
            device_index: 0,
            sample_rate_hz: 1_000_000.0,
            ppm: 0,
            tuner_gain_db: 30.0,
            agc: RtlSdrAgc::Tuner,
            hf_mode: RtlSdrHfMode::Auto,
            bias_tee: false,
            transfers: 16,
            transfer_kib: 16,
        }
    }
}

impl RtlSdrConfig {
    /// Rates the resampler can produce. Kept in step with the settings UI and
    /// with [`crate::dongle::rtlsdr::regs::rate_supported`].
    pub const SAMPLE_RATES: [f64; 9] = [
        250_000.0,
        960_000.0,
        1_024_000.0,
        1_200_000.0,
        1_536_000.0,
        1_800_000.0,
        2_048_000.0,
        2_400_000.0,
        3_200_000.0,
    ];
}
