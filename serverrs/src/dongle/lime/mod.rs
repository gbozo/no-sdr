//! Native LimeSDR source (LimeSuite, dlopen'd).

mod source;

pub use source::{config_from_dongle, LimeSource};
