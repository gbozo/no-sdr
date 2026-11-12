//! Native SDRplay RSP source (vendor `sdrplay_api` service, dlopen'd).

mod source;

pub use source::{config_from_dongle, SdrPlaySource};
