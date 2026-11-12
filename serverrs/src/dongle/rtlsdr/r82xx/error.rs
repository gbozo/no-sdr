//! What the tuner can refuse, and why.

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The bus underneath failed. Flattened to a sentence on the way in — see
    /// [`crate::dongle::rtlsdr::r82xx::bus::BusError`].
    #[error("{0}")]
    Bus(#[from] crate::dongle::rtlsdr::r82xx::bus::BusError),

    /// The synthesiser did not lock, so the tuner is delivering noise rather
    /// than the requested frequency. Worth surfacing loudly: the symptom is
    /// otherwise indistinguishable from a dead antenna.
    #[error("tuner PLL did not lock at {0:.6} MHz")]
    PllUnlocked(f64),

    /// A setting the part cannot produce.
    #[error("{0}")]
    Unsupported(String),
}
