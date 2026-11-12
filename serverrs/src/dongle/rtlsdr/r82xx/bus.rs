//! The register bus the tuner sits on.
//!
//! # Why it is register-oriented rather than byte-oriented
//!
//! The obvious interface is "send these bytes to this address", and it bakes in
//! a limit belonging to one transport. The RTL2832U's I2C block carries at most
//! 8 bytes per transfer *including* the register index, so it chunks at 7
//! payload bytes; the FX3 carries the register in `wIndex` with 64 bytes of
//! payload beside it. Passing a byte blob would push the demodulator's limit
//! onto a bus that does not have it — and the tuner does not care either way,
//! because chunking is invisible to it.

/// A register-addressed bus reaching the tuner.
///
/// Object-safe on purpose. There is one call path, and a vtable dispatch is
/// nothing beside the USB round trip on the other side of it.
pub trait TunerBus {
    /// Write `data` to consecutive registers starting at `reg`.
    fn write_regs(&self, dev_addr: u8, reg: u8, data: &[u8]) -> BusResult<()>;

    /// Read `out.len()` consecutive registers starting at `reg`, **raw** — the
    /// caller undoes the part's bit reversal, because that is a property of the
    /// tuner rather than of the bus it is on.
    fn read_regs(&self, dev_addr: u8, reg: u8, out: &mut [u8]) -> BusResult<()>;

    /// Gate an off-chip upconverter, where the board has one.
    ///
    /// Named for what it does rather than for the pin it happens to land on: an
    /// RTL-SDR Blog V4 drives GPIO 5 of the demodulator, and no other board in
    /// this workspace has an upconverter at all. Default: nothing to gate.
    fn set_upconverter_gate(&self, _on: bool) -> BusResult<()> {
        Ok(())
    }
}

pub type BusResult<T> = std::result::Result<T, BusError>;

/// A transport failure, flattened to a sentence.
///
/// Deliberately not generic over the transport's own error. Nothing in either
/// backend matches on a tuner-bus failure — they are all displayed — so
/// carrying the transport type through every signature in this crate would buy
/// nothing and cost a type parameter on [`crate::dongle::rtlsdr::r82xx::R82xx`] itself.
#[derive(Debug, thiserror::Error)]
#[error("tuner bus {op} failed: {detail}")]
pub struct BusError {
    pub op: &'static str,
    pub detail: String,
}

impl BusError {
    pub fn new(op: &'static str, e: impl std::fmt::Display) -> BusError {
        BusError {
            op,
            detail: e.to_string(),
        }
    }
}

/// A recording stand-in for the bus, so the tuner's traffic can be asserted
/// without hardware.
///
/// Not test-gated: both backends want it in their own test suites, and it
/// carries no dependencies and no I/O.
#[allow(dead_code)]
pub struct MockBus {
    /// Every write, as `(device address, first register, payload)`.
    pub writes: std::cell::RefCell<Vec<(u8, u8, Vec<u8>)>>,
    /// What a read returns, stated **post**-bit-reversal — i.e. in the values
    /// the tuner driver will actually see, which is the only form in which
    /// these numbers mean anything.
    pub reply: [u8; 5],
    pub gates: std::cell::RefCell<Vec<bool>>,
}

#[allow(dead_code)]
impl MockBus {
    /// A tuner that locks first time, reports VCO fine-tune 1 and a filter
    /// calibration code of 5 — the path with no retries, so the trace is
    /// identical on every run.
    pub fn healthy() -> MockBus {
        MockBus {
            writes: std::cell::RefCell::new(Vec::new()),
            // Byte 2 bit 6 is the PLL lock flag. Byte 4 carries two fields:
            // 0x10 is VCO fine-tune 1, and 0x05 is a filter calibration code
            // that is neither 0 nor 0x0f, so the calibration converges on its
            // first pass.
            reply: [0x00, 0x00, 0x40, 0x00, 0x15],
            gates: std::cell::RefCell::new(Vec::new()),
        }
    }

    /// The recorded traffic, one line per transfer: `addr reg payload…`.
    pub fn trace(&self) -> Vec<String> {
        self.writes
            .borrow()
            .iter()
            .map(|(addr, reg, data)| {
                let bytes: Vec<String> = data.iter().map(|b| format!("{b:02x}")).collect();
                format!("{addr:02x} {reg:02x} {}", bytes.join(" "))
            })
            .collect()
    }
}

impl TunerBus for MockBus {
    fn write_regs(&self, dev_addr: u8, reg: u8, data: &[u8]) -> BusResult<()> {
        self.writes
            .borrow_mut()
            .push((dev_addr, reg, data.to_vec()));
        Ok(())
    }

    fn read_regs(&self, _dev_addr: u8, _reg: u8, out: &mut [u8]) -> BusResult<()> {
        for (i, b) in out.iter_mut().enumerate() {
            // Re-reverse, so the driver's own bitrev lands back on `reply`.
            *b = crate::dongle::rtlsdr::r82xx::tables::bitrev(
                self.reply.get(i).copied().unwrap_or(0),
            );
        }
        Ok(())
    }

    fn set_upconverter_gate(&self, on: bool) -> BusResult<()> {
        self.gates.borrow_mut().push(on);
        Ok(())
    }
}
