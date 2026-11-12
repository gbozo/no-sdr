//! The demodulator's I2C repeater, as a [`TunerBus`].
//!
//! All the RTL2832U-specific parts of reaching the tuner live here: the 8-byte
//! transfer limit, the write-then-restart-read shape, and the GPIO that gates a
//! Blog V4's upconverter.

use crate::dongle::rtlsdr::r82xx::{BusError, BusResult, TunerBus};

use crate::dongle::rtlsdr::rtl2832::Rtl2832;

/// The RTL2832U's I2C block writes at most this many bytes per transfer,
/// including the register index — so 7 payload bytes at a time.
///
/// This is the *demodulator's* limit, not the tuner's, which is why it lives
/// here rather than travelling with the driver.
const MAX_I2C_MSG_LEN: usize = 8;

/// Split a register write into transfers this bus can carry.
///
/// Pulled out as a free function purely so it can be tested without a dongle —
/// the chunk boundary is the one thing in this file that can be silently wrong,
/// and a tuner that receives the second half of its initialisation array at the
/// wrong register is deaf rather than broken.
fn chunks(reg: u8, data: &[u8]) -> Vec<(u8, Vec<u8>)> {
    let mut out = Vec::new();
    let mut pos = 0;
    let mut addr = reg;
    while pos < data.len() {
        let size = (data.len() - pos).min(MAX_I2C_MSG_LEN - 1);
        let mut buf = Vec::with_capacity(size + 1);
        buf.push(addr);
        buf.extend_from_slice(&data[pos..pos + size]);
        out.push((addr, buf));
        addr = addr.wrapping_add(size as u8);
        pos += size;
    }
    out
}

impl TunerBus for Rtl2832 {
    fn write_regs(&self, dev_addr: u8, reg: u8, data: &[u8]) -> BusResult<()> {
        for (_, buf) in chunks(reg, data) {
            self.usb()
                .i2c_write(dev_addr, &buf)
                .map_err(|e| BusError::new("write", e))?;
        }
        Ok(())
    }

    fn read_regs(&self, dev_addr: u8, reg: u8, out: &mut [u8]) -> BusResult<()> {
        // The part has no random-access read: it always starts at R0 and runs
        // on from there, so the register goes out first and the read follows.
        self.usb()
            .i2c_write(dev_addr, &[reg])
            .map_err(|e| BusError::new("read setup", e))?;
        let raw = self
            .usb()
            .i2c_read(dev_addr, out.len() as u16)
            .map_err(|e| BusError::new("read", e))?;
        if raw.len() < out.len() {
            return Err(BusError {
                op: "read",
                detail: format!("wanted {} bytes, got {}", out.len(), raw.len()),
            });
        }
        out.copy_from_slice(&raw[..out.len()]);
        Ok(())
    }

    fn set_upconverter_gate(&self, on: bool) -> BusResult<()> {
        self.set_gpio_bit_output(5, on)
            .map_err(|e| BusError::new("upconverter gate", e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The register index rides in the payload here, so only 7 data bytes fit
    /// per transfer — and each transfer restates the register it starts at.
    #[test]
    fn a_long_write_is_split_at_seven_payload_bytes() {
        let data: Vec<u8> = (0..30).collect();
        let got = chunks(0x05, &data);

        assert_eq!(
            got.len(),
            5,
            "30 bytes needs five transfers of at most seven"
        );
        assert_eq!(got[0].0, 0x05);
        assert_eq!(got[0].1, vec![0x05, 0, 1, 2, 3, 4, 5, 6]);
        // Second transfer picks up at 0x05 + 7.
        assert_eq!(got[1].0, 0x0c);
        assert_eq!(got[1].1, vec![0x0c, 7, 8, 9, 10, 11, 12, 13]);
        // The tail is short, not padded.
        assert_eq!(got[4].1, vec![0x21, 28, 29]);

        // Every transfer is within the block's limit, index byte included.
        assert!(got.iter().all(|(_, b)| b.len() <= MAX_I2C_MSG_LEN));
        // And the payload reassembles to exactly what went in.
        let rejoined: Vec<u8> = got
            .iter()
            .flat_map(|(_, b)| b[1..].iter().copied())
            .collect();
        assert_eq!(rejoined, data);
    }

    #[test]
    fn a_write_that_fits_stays_one_transfer() {
        let got = chunks(0x10, &[1, 2, 3, 4, 5, 6, 7]);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].1, vec![0x10, 1, 2, 3, 4, 5, 6, 7]);
    }
}
