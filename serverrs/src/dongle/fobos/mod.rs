//! Native RigExpert Fobos SDR source (`libfobos`, dlopen'd).

mod source;

pub use source::{config_from_dongle, FobosSource};
