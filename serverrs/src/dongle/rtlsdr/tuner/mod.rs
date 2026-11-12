//! Tuner detection, and the demodulator's side of the tuner's register bus.
//!
//! The driver itself is [`crate::dongle::rtlsdr::r82xx`], shared with the RX-888 backend —
//! the same chip family sits behind both, and the only thing that differs is
//! how its registers are reached. What stays here is what is genuinely about
//! *this* dongle: probing over the I2C repeater, and the transport itself.

pub mod bus;

use crate::dongle::rtlsdr::error::{Error, Result};
use crate::dongle::rtlsdr::r82xx::{Chip, R82xx, R820T_I2C_ADDR, R828D_I2C_ADDR, R82XX_CHECK_VAL};
use crate::dongle::rtlsdr::rtl2832::Rtl2832;

/// Identify the tuner behind the demodulator's I2C repeater.
///
/// The caller must have the repeater open. Failure names the chip when it can,
/// because "unsupported tuner" without a name leaves the operator with nothing
/// to search for.
pub fn probe(dev: &Rtl2832) -> Result<Chip> {
    // A probe read that errors just means "nothing answered at this address",
    // which is a normal outcome while walking candidates — not a failure.
    //
    // Note the *absence* of a bit reversal here. `R82xx::read` reverses,
    // because that is the tuner driver's own read path, but the probe compares
    // the raw byte — exactly as upstream does. Reversing in both places makes
    // every dongle look like an unsupported tuner.
    let check = |addr: u8, reg: u8| dev.i2c_read_reg(addr, reg).ok();

    // R820T and R820T2 answer at 0x34 and are not distinguishable from each
    // other over I2C — upstream reports both as R820T and so do we.
    if check(R820T_I2C_ADDR, 0x00) == Some(R82XX_CHECK_VAL) {
        return Ok(Chip::R820T);
    }

    // An R828D needs a reset pulse before it answers.
    dev.reset_tuner()?;
    if check(R828D_I2C_ADDR, 0x00) == Some(R82XX_CHECK_VAL) {
        return Ok(Chip::R828D);
    }

    // Name the legacy parts we deliberately do not drive, so the message is
    // actionable rather than just a refusal.
    const LEGACY: [(u8, u8, u8, &str); 4] = [
        (0xc8, 0x02, 0x40, "Elonics E4000"),
        (0xc6, 0x00, 0xa1, "Fitipower FC0013"),
        (0xc2, 0x00, 0xa1, "Fitipower FC0012"),
        (0xac, 0x01, 0x56, "FCI FC2580"),
    ];
    for (addr, reg, expect, name) in LEGACY {
        if check(addr, reg) == Some(expect) {
            return Err(Error::UnsupportedTuner(name.to_string()));
        }
    }

    Err(Error::UnsupportedTuner("unrecognised".to_string()))
}

/// Build a tuner for a probed chip.
pub fn open(dev: &Rtl2832, chip: Chip, is_blog_v4: bool, ppm: i32) -> Result<R82xx> {
    let mut tuner = R82xx::new(chip, is_blog_v4, ppm);
    tuner.init(dev)?;
    tracing::info!(
        "tuner: {}{}",
        tuner.name(),
        if is_blog_v4 { " (RTL-SDR Blog V4)" } else { "" }
    );
    Ok(tuner)
}
