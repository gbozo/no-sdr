//! The RTL2832U demodulator: everything that is not the tuner.
//!
//! Transcribed from osmocom `librtlsdr` `src/librtlsdr.c` — `rtlsdr_init_baseband`,
//! `rtlsdr_set_sample_rate`, `rtlsdr_set_if_freq`, `rtlsdr_set_direct_sampling`,
//! the GPIO helpers and the tuner probe.
//!
//! In DVB-T service this chip demodulates; here everything after the ADC is
//! switched off and it acts as a digital down-converter feeding raw 8-bit I/Q
//! out of the bulk endpoint. Most of the init sequence below is therefore
//! "turn that off": AGC loops, the PID filter, adjacent-channel rejection.

use std::time::Duration;

use crate::dongle::rtlsdr::error::{Error, Result};
use crate::dongle::rtlsdr::regs::{self, FIR_DEFAULT, RTL_XTAL_HZ};
use crate::dongle::rtlsdr::usb::{Block, UsbDev};

// USB block registers.
const USB_SYSCTL: u16 = 0x2000;
const USB_EPA_CTL: u16 = 0x2148;
const USB_EPA_MAXPKT: u16 = 0x2158;

// System block registers.
const DEMOD_CTL: u16 = 0x3000;
const GPO: u16 = 0x3001;
const GPOE: u16 = 0x3003;
const GPD: u16 = 0x3004;
const DEMOD_CTL_1: u16 = 0x300b;

/// GPIO carrying the bias tee on RTL-SDR Blog V3/V4 hardware. Also the
/// R828D's slave-demod power line, which is why it is named once here.
#[cfg_attr(not(feature = "bias-t"), allow(dead_code))]
const GPIO_BIAS_TEE: u8 = 0;
/// GPIO that resets the tuner. Used to bring an R828D into a known state
/// before probing for it.
const GPIO_TUNER_RESET: u8 = 5;

/// The R82xx's default intermediate frequency — the DVB-T 6 MHz mode's.
///
/// The tuner owns this number, so it is re-exported rather than restated: the
/// DDC below has to be programmed to whatever IF the tuner's filter choice
/// actually leaves it on.
pub use crate::dongle::rtlsdr::r82xx::DEFAULT_IF_HZ as R82XX_IF_FREQ;

/// Which ADC branch feeds the DDC when the tuner is bypassed.
///
/// The tuner cannot reach below 24 MHz, so HF on a non-upconverting dongle
/// means feeding the antenna straight into the ADC and letting the DDC do the
/// tuning. `Q` is the branch the V3's HF port is wired to; `I` exists for
/// completeness and is not offered in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[allow(dead_code)] // `I` is the other ADC branch. No dongle wires its HF
                    // port to it, so it is never selected, but the register
                    // encoding is only comprehensible as a pair.
pub enum DirectSampling {
    #[default]
    Off,
    I,
    Q,
}

/// The demodulator half of a dongle.
pub struct Rtl2832 {
    usb: UsbDev,
    /// Nominal reference crystal, before ppm correction.
    rtl_xtal: f64,
    ppm: i32,
    rate: f64,
    center: f64,
    if_hz: f64,
    direct: DirectSampling,
    /// Whether the bias tee is currently energised, so shutdown can put it
    /// back. Leaving DC on a coax after the program exits is not acceptable.
    bias_tee: bool,
}

impl Rtl2832 {
    pub fn new(usb: UsbDev) -> Rtl2832 {
        Rtl2832 {
            usb,
            rtl_xtal: RTL_XTAL_HZ,
            ppm: 0,
            rate: 0.0,
            center: 0.0,
            if_hz: 0.0,
            direct: DirectSampling::Off,
            bias_tee: false,
        }
    }

    pub fn usb(&self) -> &UsbDev {
        &self.usb
    }

    pub fn rate(&self) -> f64 {
        self.rate
    }

    pub fn direct_sampling(&self) -> DirectSampling {
        self.direct
    }

    /// The reference crystal with the ppm correction applied — what the DDC's
    /// arithmetic must be computed against.
    pub fn corrected_rtl_xtal(&self) -> f64 {
        regs::apply_ppm(self.rtl_xtal, self.ppm)
    }

    // ---- demodulator register access ------------------------------------

    pub fn demod_read_reg(&self, page: u8, addr: u16, len: u16) -> Result<u16> {
        let data =
            self.usb
                .read_array_raw(regs::demod_value(addr), regs::demod_read_index(page), len)?;
        Ok(regs::decode_reg(&data))
    }

    /// Write a demodulator register.
    ///
    /// The dummy read afterwards is not decoration: some writes do not latch
    /// without a following bus cycle. librtlsdr does the same, and it lives
    /// here — inside the one function every demod write goes through — so it
    /// cannot be forgotten at a call site.
    pub fn demod_write_reg(&self, page: u8, addr: u16, val: u16, len: u16) -> Result<()> {
        let buf = regs::encode_reg(val, len);
        self.usb.write_array_raw(
            regs::demod_value(addr),
            regs::demod_write_index(page),
            &buf[..len as usize],
        )?;
        let _ = self.demod_read_reg(0x0a, 0x01, 1);
        Ok(())
    }

    /// Open or close the demodulator's I2C repeater, through which every tuner
    /// transaction passes.
    ///
    /// This is a global mode bit, which is why all register access is confined
    /// to one thread — see the invariant in [`crate::dongle::rtlsdr::usb`].
    pub fn i2c_repeater(&self, on: bool) -> Result<()> {
        self.demod_write_reg(1, 0x01, if on { 0x18 } else { 0x10 }, 1)
    }

    /// Read one register from an I2C device behind the repeater.
    pub fn i2c_read_reg(&self, i2c_addr: u8, reg: u8) -> Result<u8> {
        self.usb.i2c_write(i2c_addr, &[reg])?;
        Ok(self
            .usb
            .i2c_read(i2c_addr, 1)?
            .first()
            .copied()
            .unwrap_or(0))
    }

    /// Drive a GPIO as an output and set its level in one step. Used by the
    /// Blog V4's upconverter switch on GPIO 5.
    pub fn set_gpio_bit_output(&self, gpio: u8, on: bool) -> Result<()> {
        self.set_gpio_output(gpio)?;
        self.set_gpio_bit(gpio, on)
    }

    // ---- bring-up --------------------------------------------------------

    /// Put the chip into SDR mode. Order matters throughout; this follows
    /// `rtlsdr_init_baseband` step for step.
    pub fn init_baseband(&mut self) -> Result<()> {
        // USB endpoint configuration.
        self.usb.write_reg(Block::Usb, USB_SYSCTL, 0x09, 1)?;
        self.usb.write_reg(Block::Usb, USB_EPA_MAXPKT, 0x0002, 2)?;
        self.usb.write_reg(Block::Usb, USB_EPA_CTL, 0x1002, 2)?;

        // Power on the demodulator.
        self.usb.write_reg(Block::Sys, DEMOD_CTL_1, 0x22, 1)?;
        self.usb.write_reg(Block::Sys, DEMOD_CTL, 0xe8, 1)?;

        self.soft_reset()?;

        // Disable spectrum inversion and adjacent-channel rejection.
        self.demod_write_reg(1, 0x15, 0x00, 1)?;
        self.demod_write_reg(1, 0x16, 0x0000, 2)?;

        // Clear the DDC shift and IF frequency registers.
        for i in 0..6 {
            self.demod_write_reg(1, 0x16 + i, 0x00, 1)?;
        }

        self.set_fir(&FIR_DEFAULT)?;

        // SDR mode, digital AGC off.
        self.demod_write_reg(0, 0x19, 0x05, 1)?;

        // FSM state-holding registers.
        self.demod_write_reg(1, 0x93, 0xf0, 1)?;
        self.demod_write_reg(1, 0x94, 0x0f, 1)?;

        // Both AGC loops off.
        self.demod_write_reg(1, 0x11, 0x00, 1)?;
        self.demod_write_reg(1, 0x04, 0x00, 1)?;

        // PID filter off.
        self.demod_write_reg(0, 0x61, 0x60, 1)?;

        // Default ADC I/Q datapath.
        self.demod_write_reg(0, 0x06, 0x80, 1)?;

        // Zero-IF, DC cancellation, I/Q estimation and compensation.
        self.demod_write_reg(1, 0xb1, 0x1b, 1)?;

        // Silence the 4.096 MHz clock output on pin TP_CK0 — it is a spur
        // otherwise.
        self.demod_write_reg(0, 0x0d, 0x83, 1)?;

        Ok(())
    }

    /// Pulse the demodulator's soft reset.
    fn soft_reset(&self) -> Result<()> {
        self.demod_write_reg(1, 0x01, 0x14, 1)?;
        self.demod_write_reg(1, 0x01, 0x10, 1)
    }

    /// Load the decimating FIR's taps.
    pub fn set_fir(&self, taps: &[i32; regs::FIR_LEN]) -> Result<()> {
        let fir = regs::pack_fir(taps)
            .ok_or_else(|| Error::Unsupported("FIR tap out of range".into()))?;
        for (i, b) in fir.iter().enumerate() {
            self.demod_write_reg(1, 0x1c + i as u16, *b as u16, 1)?;
        }
        Ok(())
    }

    /// Configure the chip for an R82xx tuner: low-IF rather than zero-IF.
    ///
    /// These four settings belong together. The R82xx is run at a low IF, so
    /// the ADC takes the I branch only, zero-IF mode is off, and the spectrum
    /// is inverted because the low IF lands on the wrong side. Change one
    /// without the others and the radio still produces a spectrum — a mirrored
    /// or offset one, which is much harder to notice than silence.
    pub fn configure_for_r82xx(&mut self) -> Result<()> {
        self.demod_write_reg(1, 0xb1, 0x1a, 1)?;
        self.demod_write_reg(0, 0x08, 0x4d, 1)?;
        self.set_if_freq(R82XX_IF_FREQ)?;
        self.demod_write_reg(1, 0x15, 0x01, 1)?;
        Ok(())
    }

    // ---- frequency and rate ---------------------------------------------

    /// Program the DDC's frequency. Computed against the ppm-corrected
    /// crystal, so it must be re-run whenever ppm changes.
    pub fn set_if_freq(&mut self, if_hz: f64) -> Result<()> {
        let r = regs::if_freq_regs(if_hz, self.corrected_rtl_xtal());
        self.demod_write_reg(1, 0x19, r[0] as u16, 1)?;
        self.demod_write_reg(1, 0x1a, r[1] as u16, 1)?;
        self.demod_write_reg(1, 0x1b, r[2] as u16, 1)?;
        self.if_hz = if_hz;
        Ok(())
    }

    /// Set the sample rate, returning the rate the hardware actually produces.
    ///
    /// The caller must report the returned value onward rather than the
    /// requested one — see [`regs::resamp_ratio`].
    pub fn set_sample_rate(&mut self, rate_hz: f64) -> Result<f64> {
        let requested = rate_hz.round() as u32;
        if !regs::rate_supported(requested) {
            return Err(Error::Unsupported(format!(
                "{:.0} Hz is outside the RTL2832U's resampler range — it can do \
                 225–300 kHz and 900 kHz–3.2 MHz, nothing between",
                rate_hz
            )));
        }

        // librtlsdr computes the ratio from the *nominal* crystal and applies
        // ppm through the separate correction registers below, rather than by
        // skewing the ratio. Follow it exactly: the two are not equivalent to
        // the last bit, and matching the reference is what makes a usbmon diff
        // against `rtl_sdr` meaningful.
        let (ratio, achieved) = regs::resamp_ratio(self.rtl_xtal, requested);
        self.demod_write_reg(1, 0x9f, (ratio >> 16) as u16, 2)?;
        self.demod_write_reg(1, 0xa1, (ratio & 0xffff) as u16, 2)?;
        self.set_sample_freq_correction()?;
        self.soft_reset()?;

        self.rate = achieved;
        if (achieved - rate_hz).abs() > 0.5 {
            tracing::debug!("sample rate {rate_hz:.0} Hz requested, {achieved:.3} Hz achieved");
        }
        Ok(achieved)
    }

    /// Write the resampler's ppm offset registers.
    fn set_sample_freq_correction(&self) -> Result<()> {
        let [hi, lo] = regs::ppm_regs(self.ppm);
        self.demod_write_reg(1, 0x3f, lo as u16, 1)?;
        self.demod_write_reg(1, 0x3e, hi as u16, 1)
    }

    /// Change the crystal error correction.
    ///
    /// ppm reaches the hardware by three separate routes and they must move
    /// together: the resampler's own offset registers, the DDC frequency
    /// (computed from the corrected crystal), and the tuner PLL (computed from
    /// a corrected *tuner* crystal, which on an R828D is a different part
    /// entirely). Applying only some of them leaves the radio partly
    /// corrected, which is worse than uncorrected because it looks fixed.
    ///
    /// Returns `true` when the caller must retune the tuner — this function
    /// cannot do it, since the tuner is owned separately.
    pub fn set_ppm(&mut self, ppm: i32) -> Result<bool> {
        if ppm == self.ppm {
            return Ok(false);
        }
        self.ppm = ppm;
        self.set_sample_freq_correction()?;
        // Re-apply the DDC frequency against the newly corrected crystal.
        let if_hz = self.if_hz;
        self.set_if_freq(if_hz)?;
        Ok(true)
    }

    /// Record the centre frequency the tuner (or the DDC, when direct
    /// sampling) was set to.
    pub fn set_center(&mut self, hz: f64) {
        self.center = hz;
    }

    // ---- direct sampling --------------------------------------------------

    /// Switch the ADC-direct path on or off.
    ///
    /// Returns `true` when the tuner must be re-initialised afterwards
    /// (leaving direct sampling), which the caller does because it owns the
    /// tuner. Turning it *on* powers the tuner down first, so the caller must
    /// have done that before calling.
    pub fn set_direct_sampling(&mut self, mode: DirectSampling) -> Result<bool> {
        if mode == self.direct {
            return Ok(false);
        }
        match mode {
            DirectSampling::Off => {
                self.direct = mode;
                // The caller re-initialises the tuner and then calls
                // `configure_for_r82xx`, which restores the low-IF settings.
                self.demod_write_reg(0, 0x06, 0x80, 1)?;
                Ok(true)
            }
            DirectSampling::I | DirectSampling::Q => {
                // Zero-IF off, spectrum inversion off, I branch only.
                self.demod_write_reg(1, 0xb1, 0x1a, 1)?;
                self.demod_write_reg(1, 0x15, 0x00, 1)?;
                self.demod_write_reg(0, 0x08, 0x4d, 1)?;
                // Swapping the ADC inputs is what selects between the two
                // physical branches; the V3's HF port is on Q.
                let swap = if mode == DirectSampling::Q {
                    0x90
                } else {
                    0x80
                };
                self.demod_write_reg(0, 0x06, swap, 1)?;
                self.direct = mode;
                Ok(false)
            }
        }
    }

    // ---- endpoint and GPIO ------------------------------------------------

    /// Flush the endpoint's FIFO.
    ///
    /// Must run immediately before the first bulk submit, and again after
    /// anything that stalls the stream: a rate change, a direct-sampling
    /// switch, or an endpoint halt. Without it the first transfers carry
    /// whatever was left in the FIFO from the previous configuration.
    pub fn reset_buffer(&self) -> Result<()> {
        self.usb.write_reg(Block::Usb, USB_EPA_CTL, 0x1002, 2)?;
        self.usb.write_reg(Block::Usb, USB_EPA_CTL, 0x0000, 2)
    }

    fn set_gpio_output(&self, gpio: u8) -> Result<()> {
        let bit = 1u8 << gpio;
        let d = self.usb.read_reg(Block::Sys, GPD, 1)? as u8;
        self.usb.write_reg(Block::Sys, GPD, (d & !bit) as u16, 1)?;
        let e = self.usb.read_reg(Block::Sys, GPOE, 1)? as u8;
        self.usb.write_reg(Block::Sys, GPOE, (e | bit) as u16, 1)
    }

    fn set_gpio_bit(&self, gpio: u8, on: bool) -> Result<()> {
        let bit = 1u8 << gpio;
        let r = self.usb.read_reg(Block::Sys, GPO, 1)? as u8;
        let v = if on { r | bit } else { r & !bit };
        self.usb.write_reg(Block::Sys, GPO, v as u16, 1)
    }

    /// Energise or de-energise the bias tee: roughly 4.5 V DC on the antenna
    /// coax, for a mast-head amplifier.
    ///
    /// Destructive into anything that is not expecting it — a transceiver, a
    /// DC-shorted antenna, a preamp fed from elsewhere. Default off, and
    /// [`Rtl2832::shutdown`] puts it back.
    pub fn set_bias_tee(&mut self, on: bool) -> Result<()> {
        #[cfg(not(feature = "bias-t"))]
        {
            // This build must never put DC on the feedline, even if a caller
            // reaches the demodulator directly rather than through `Device`.
            let _ = on;
            return Ok(());
        }

        #[cfg(feature = "bias-t")]
        {
            self.set_gpio_output(GPIO_BIAS_TEE)?;
            self.set_gpio_bit(GPIO_BIAS_TEE, on)?;
            if on != self.bias_tee {
                tracing::info!(
                    "bias tee {}",
                    if on { "ON — DC on the coax" } else { "off" }
                );
            }
            self.bias_tee = on;
            Ok(())
        }
    }

    /// Pulse the tuner reset line. Needed to bring an R828D into a state where
    /// it answers on I2C.
    pub fn reset_tuner(&self) -> Result<()> {
        self.set_gpio_output(GPIO_TUNER_RESET)?;
        self.set_gpio_bit(GPIO_TUNER_RESET, true)?;
        std::thread::sleep(Duration::from_millis(1));
        self.set_gpio_bit(GPIO_TUNER_RESET, false)
    }

    /// The demodulator's own digital AGC.
    pub fn set_rtl_agc(&self, on: bool) -> Result<()> {
        self.demod_write_reg(0, 0x19, if on { 0x25 } else { 0x05 }, 1)
    }

    /// Leave the hardware in a state that is safe to walk away from.
    ///
    /// Best-effort: this runs on the way out, and a dongle that has already
    /// been yanked out of the port cannot be tidied. The bias tee is the part
    /// that matters — everything else is reset by the next open.
    pub fn shutdown(&mut self) {
        if self.bias_tee {
            if let Err(e) = self.set_bias_tee(false) {
                tracing::warn!("could not turn the bias tee off on shutdown: {e}");
            }
        }
    }
}
