# Native SDR driver expansion

Status: all listed drivers are implemented. RTL-SDR, HackRF, Airspy R2/Mini,
Airspy HF+, HydraSDR RFOne, ELAD FDM, RX-888 Mk2 and PlutoSDR are native
sources. SDRplay, LimeSDR and Fobos SDR are vendor-library sources loaded with
`dlopen` at runtime. RTL-SDR is the only family hardware-tested so far.

The Rust backend uses one adapter module per source under
`serverrs/src/dongle/`. This note maps the sdroxide drivers onto our code and
records the vendor-library requirements and quirks.

Licensing: sdroxide is GPL-3.0-or-later, the same as this project. Its drivers
are clean-room/transcribed from BSD-3-Clause or GPL-2.0-or-later vendor code,
each file carries provenance notes. Reuse is compatible.

## Candidate drivers

| Source type | sdroxide crate | USB | Output from driver | Host DSP required | Relative effort |
|---|---|---|---|---|---|
| `hackrf` | `sdroxide-hackrf` | nusb | signed 8-bit I/Q | none for RX | **Low** |
| `airspy` | `sdroxide-airspy` | nusb | `Complex32` | DC block, fs/4 rotation, half-band decimation | Medium |
| `airspyhf` | `sdroxide-airspyhf` | nusb | `Complex32` | DC removal, IQ image balance, fine NCO | Medium |
| `hydrasdr` | `sdroxide-hydrasdr` | nusb | `Complex32` | same family as Airspy R2 | Medium |
| `rx888` | `sdroxide-rx888` | nusb | `Complex32` + wide FFT | FX3 firmware upload, DDC, tuner | High |
| `elad` | `sdroxide-elad` | nusb | `Complex32` | per-rate FPGA image, CAT/dial follow | High |
| `pluto` | `sdroxide-pluto` | network (IIOD) | `Complex32` | AD9361 gain/filter; mDNS discovery | Medium |
| `sdrplay` | `sdroxide-sdrplay` | vendor API service | `Complex32` | vendor service/DLL | Implemented |
| `lime` | `sdroxide-lime` | LimeSuite via `dlopen` | `Complex32` | vendor library | Implemented |
| `fobos` | `sdroxide-fobos` | `libfobos` | `Complex32` | vendor library | Implemented |

Network radios already covered by the existing `rtl_tcp`-compatible source path
(`rtl_tcp`, `airspy_tcp`, `hfp_tcp`, `rsp_tcp`). Pluto is the one network SDR
that does not speak that protocol.

## Why the drivers are reusable

All of the pure-Rust drivers have the same shape:

- one blocking thread owns the USB device;
- control arrives over a channel;
- samples are produced into a ring buffer;
- the exposed handle has `set_center_hz`, `set_rate_hz`, gain/antenna/bias
  setters, and a read method (`rx_read(&mut [u8])` or `rx_read(&mut [f32])`).

That maps directly onto our `Source` trait: open a handle, run a blocking loop
that reads samples and sends `Vec<u8>` to the manager, and translate our
`SourceCommand` bytes into handle setters.

A dependency spike was tested: `sdroxide-hackrf` builds as a pinned git
dependency in about 13 seconds once `sdroxide-dsp` is replaced with a local
shim. The real `sdroxide-dsp` crate drags in DeepFilterNet/tract/ndarray, which
we do not need for hardware I/O.

### Recommended dependency shape

Option A, smallest diff:

```toml
[dependencies]
sdroxide-hackrf = { git = "https://github.com/dividebysandwich/sdroxide", rev = "<pinned>", optional = true }

[patch."https://github.com/dividebysandwich/sdroxide"]
sdroxide-dsp = { path = "vendor/sdroxide-dsp" }
```

The shim starts with:

```rust
pub type Complex32 = num_complex::Complex<f32>;
```

and grows only when a driver needs more (`blackman_harris`, `Nco`,
`as_interleaved`, and for RX-888 `WbDdc`/`WideSpectrum`).

Option B, long-term: vendor the driver crates under `serverrs/vendor/` and keep
the same patch shim. Better reproducibility, much larger diff.

## Pipeline quirks

### 1. Our `Source` contract is unsigned 8-bit I/Q

`serverrs/src/dongle/source.rs` returns `Vec<u8>`; `manager.rs`,
`FftProcessor`, and `IqExtractor` all assume interleaved **unsigned** 8-bit
samples centred on 127.5.

- HackRF produces **signed** 8-bit: XOR each byte with `0x80` before sending.
- Airspy, Airspy HF+, HydraSDR, RX-888 and ELAD produce `Complex32`:
  convert with `((clamp(v, -1, 1) * 127.5) + 127.5) as u8` at the source
  boundary.
- This preserves the existing protocol and client but quantizes 12/16-bit
  radios to 8 bits. For HF weak-signal work a later step should add an
  `Int16` source format (and format-aware conversion in the FFT/IQ extractor)
  rather than keeping everything at 8 bits.

### 2. Source settings are currently RTL-specific

`apply_dongle_settings` always sends rtl_tcp opcodes: gain mode, gain,
frequency correction, direct sampling, bias-T, RTL AGC, offset tuning. Other
radios either ignore these or need different controls.

Recommended change:

- Add `SourceConfig.settings: serde_json::Map<String, Value>` (or a typed
  per-source struct) alongside the existing common fields.
- Make `apply_dongle_settings` source-aware:
  - common: frequency, sample rate, bias-T, IQ correction;
  - RTL: direct sampling, RTL AGC, offset tuning, single gain;
  - HackRF: LNA dB, VGA dB, amp, baseband filter;
  - Airspy/HydraSDR: gain step, gain curve, LNA/mixer AGC, RF port;
  - HF+: AGC, threshold, attenuator, LNA, calibration PPB, host DSP;
  - RX-888: ADC rate, VGA, attenuator, dither, PGA, tuner gain/AGC;
  - ELAD: attenuator, preselector.
- Extend `CommandHandle` with either typed setters or generic
  `Settings(serde_json::Value)` messages. Opcode-per-setting works for one
  driver but does not scale to five.

### 3. Open-time configuration

The RTL-SDR source can open at defaults and receive every setting afterwards
because librtlsdr allows it. Several sdroxide drivers need the sample rate,
gain step and antenna at `open()` time (and some, such as RX-888 and ELAD,
choose firmware/FPGA images from the rate).

`create_source` already computes `sample_rate` and has the profile; pass a
source-specific config into each native `open()`. A later rate change may need
a source restart rather than a `set_rate_hz` command.

### 4. Device enumeration is RTL-only

`/api/admin/devices` calls `enumerate_local_devices()` from the rtlsdr module.
A generic endpoint is needed:

```text
GET /api/admin/devices?type=hackrf
```

or return a grouped map:

```json
{ "rtlsdr": [...], "hackrf": [...], "airspy": [...] }
```

Each sdroxide driver has a `Device::list()`-style enumerator and serial
matching rules (Airspy/HackRF match on serial suffix; HF+ uses the 16 hex
digits; RX-888 may have no serial).

### 5. Admin UI is RTL-centric

`client/src/admin/sections/DevicesSection.tsx` currently exposes:

- one `gain`
- `directSampling`
- `offsetTuning`
- `digitalAgc`
- one fixed RTL sample-rate list
- host/port only for TCP sources

Needed:

- add source types `hackrf`, `airspy`, `airspyhf`, `hydrasdr`, `rx888`,
  `elad`, `pluto`;
- a per-source settings panel (conditional fields);
- per-source sample-rate dropdowns;
- hide RTL-only toggles for non-RTL sources;
- keep `serial` and `deviceIndex` as common device selection;
- surface open errors (firmware upload, WinUSB binding, serial mismatch) in
  the existing action-error area.

### 6. Profiles and presets assume 2.4 MSPS

`DongleConfig.sampleRate` is the hardware ceiling: `DongleProfile.sampleRate`
may ask for a narrower span but is clamped to the dongle rate, and the device
is opened at the resolved rate (profile rate when lower, dongle rate
otherwise) instead of the driver's built-in default. A missing dongle rate
falls back to the profile rate, then 1 MSPS. Presets are written around RTL
rates, so adding radios with only 2/4/8/10/20 MSPS means:

- source-specific rate lists;
- profile creation should snap to a supported rate;
- the client must not assume 2.4 MSPS when displaying/spanning.

## Phased implementation

### Phase 1 — plumbing + HackRF pilot

1. Add `SourceConfig.settings` / typed source settings.
2. Make `apply_dongle_settings` source-aware; add generic settings commands.
3. Add source-specific sample rates and conditional admin fields.
4. Add `hackrf`:
   - pinned `sdroxide-hackrf` dependency + minimal `sdroxide-dsp` shim;
   - `HackRfSource` adapter with XOR `0x80` conversion;
   - `manager.rs` branch `"hackrf"`;
   - enumeration via `HackRfDevice`.
5. Verify build and, when hardware is available, RX at 2/4/8 MSPS with
   LNA/VGA/amp changes and bias-T.

### Phase 1 implementation notes

- Cargo feature `hackrf`, enabled by default.
- `sdroxide-hackrf` is pinned to
  `6f0994e72850a15d2a7440d1fde742934a38aea0`; `sdroxide-dsp` is patched to the
  local shim in `serverrs/vendor/sdroxide-dsp`.
- Adapter: `serverrs/src/dongle/hackrf/`; manager branch `"hackrf"`.
- Settings live under `source.settings`:
  `lnaDb`, `vgaDb`, `amp`, `filterBwHz`, plus optional `ppm`, `transfers`,
  `transferKib`.
- Signed 8-bit samples are XORed with `0x80` at the source boundary.
- Admin: source type, serial field, HackRF LNA/VGA/filter/RF-amp controls and
  HackRF sample-rate list are in place. Enumeration is still manual-serial;
  a `?type=hackrf` device list is a follow-up.
- Not yet hardware-tested: no HackRF was attached during implementation.

### Airspy R2 / Mini implementation notes

- Cargo feature `airspy`, enabled by default.
- Same pinned sdroxide revision as HackRF; the local `sdroxide-dsp` shim adds
  `blackman_harris` for the driver's half-band design.
- Adapter: `serverrs/src/dongle/airspy/`; manager branch `"airspy"`.
- Settings: `gainStep` (0–21), `gainCurve` (0 linearity / 1 sensitivity),
  `lnaAgc`, `mixerAgc`, `dcBlock`, plus optional `packing`, `transfers`,
  `transferKib`.
- `Complex32` is converted to unsigned 8-bit at the source boundary.
- Admin sample rates: 2.5, 3, 6, 10 MSPS.
- Not yet hardware-tested.

### Airspy HF+ implementation notes

- Cargo feature `airspyhf`, enabled by default.
- Same pinned sdroxide revision; the local `sdroxide-dsp` shim now also provides
  the scalar `Nco` used by the HF+ host DSP.
- Adapter: `serverrs/src/dongle/airspyhf/`; manager branch `"airspyhf"`.
- Settings: `agc`, `agcThresholdHigh`, `attenuatorDb` (negative dB), `lna`,
  `calibrationPpb`, `libDsp`.
- Sample rates: 192, 228, 256, 384, 456, 650, 768, 912 kSPS.
- Rate changes require reopening the receiver; the adapter logs that instead
  of pretending to apply them live.
- Not yet hardware-tested.

### HydraSDR RFOne implementation notes

- Cargo feature `hydrasdr`, enabled by default.
- Adapter: `serverrs/src/dongle/hydrasdr/`; manager branch `"hydrasdr"`.
- Settings: `gainStep`, `gainCurve`, `lnaAgc`, `mixerAgc`, `rfPort`
  (0 ANT / 1 CABLE1 / 2 CABLE2), `dcBlock`, optional `packing`, `transfers`,
  `transferKib`.
- Sample rates: 2.5, 4.096, 5, 6, 8, 10, 12 MSPS.
- Not yet hardware-tested.

### ELAD implementation notes

- Cargo feature `elad`, enabled by default.
- Adapter: `serverrs/src/dongle/elad/`; manager branch `"elad"`.
- Settings: `attenuator`, `preselector`.
- Sample rates: 192, 384, 768, 1536, 3072, 6144 kSPS. The rate selects an FPGA
  image at open, so live rate changes require reopening.
- Not yet hardware-tested.

### RX-888 Mk2 implementation notes

- Cargo feature `rx888`, enabled by default.
- The local `sdroxide-dsp` shim now carries the WOLA wideband DDC, wideband
  spectrum and SIMD kernel pieces (`realfft` + `rustfft`).
- Adapter: `serverrs/src/dongle/rx888/`; manager branch `"rx888"`.
- Settings: `adcRateHz`, `ddcBins`, `vgaDb`, `attenuatorDb`, `dither`, `pga`,
  `tunerGainDb`, `tunerAgc`, `biasTeeVhf` (HF bias uses the normal `biasT`).
- Default: 64.8 Msps ADC; output rate is `adcRateHz · ddcBins / 8192`.
- The admin output-rate choice is derived from the selected ADC rate and DDC bin
  count, and the dongle sample rate is updated when either changes.
- Not yet hardware-tested.

### PlutoSDR implementation notes

- Cargo feature `pluto`, enabled by default.
- Network source over IIOD (default port 30431), not USB. Uses `source.host`
  and `source.port`; blank host defaults to `192.168.2.1`.
- Adapter: `serverrs/src/dongle/pluto/`; manager branch `"pluto"`.
- Settings: `rxGainDb`, `agc` (0 manual / 1 slow / 2 fast / 3 hybrid),
  `rfBandwidthHz`, `rxPort`, `ppm`, `bufferSamples`.
- Sample rates: 521 kSPS, 1, 2, 2.5, 3.84, 5 MSPS.
- No udev rule: the Pluto is reached over its network gadget.
- Not yet hardware-tested.

### SDRplay RSP implementation notes

- Cargo feature `sdrplay`, enabled by default. The crate only links `libloading`;
  the actual `sdrplay_api` library and `sdrplay_apiService` are found at
  **runtime**.
- Adapter: `serverrs/src/dongle/sdrplay/`; manager branch `"sdrplay"`.
- Settings: `bwKhz` (0 = auto), `ifGrDb` (20–59), `lnaState`, `agc`
  (0 off / 1 100 Hz / 2 50 Hz / 3 5 Hz), `agcSetpointDbfs`, `ppm`, `rfNotch`,
  `dabNotch`, `antenna`, `duoTuner` (0/1), `hdr`, `hdrBw` (0–3),
  `extendedIfGr`, `biasTee`.
- Sample rates: 250 k, 500 k, 1, 2, 3, 4, 5, 6, 8 and 10 MSPS.
- Linux: install SDRplay's API package (which includes the service and its udev
  rules), then `sudo systemctl enable --now sdrplay`. An RSP1 (`1df7:2500`)
  also needs `msi2500`/`msi001` blacklisted so the DVB driver does not claim it.
- Windows/macOS: install the vendor API; the DLL/dylib must be on the loader
  path. No library is bundled in the release archive.
- Receive only.

### LimeSDR implementation notes

- Cargo feature `lime`, enabled by default. `sdroxide-lime` loads LimeSuite via
  `dlopen`; nothing is linked at build time.
- Adapter: `serverrs/src/dongle/lime/`; manager branch `"lime"`.
- Settings: `device` (falls back to `source.serial`), `channel` (0/1),
  `oversample` (0, 1, 2, 4, 8, 16, 32), `rxGainDb`, `antennaRx` (`LNAH`,
  `LNAL`, `LNAW`), `lpfRxHz` (0 = auto), `calibrate`, `iqCorrection`,
  `fifoKsamples`, `throughputVsLatency`.
- Sample rates: 100 k, 250 k, 500 k, 750 k, 1, 2, 2.5, 5, 10, 15.36, 20, 30.72
  and 40 MSPS. The Mini-specific low rates are included in the same list; the
  driver reports the achieved rate at open.
- Linux: install LimeSuite and its udev rules (`64-limesuite.rules` from the
  package). No extra rule is shipped here.
- Receive only in this build; the driver's TX path is intentionally not armed.

### Fobos SDR implementation notes

- Cargo feature `fobos`, enabled by default. `sdroxide-fobos` loads `libfobos`
  via `dlopen`; nothing is linked at build time.
- Adapter: `serverrs/src/dongle/fobos/`; manager branch `"fobos"`.
- Settings: `port` (0 `RF`, 1 `HF1`, 2 `HF2`, 3 `HF1+HF2`), `lnaGain` (0–3),
  `vgaGain` (0–31), `clkExternal`.
- Sample rates: 625 k, 1.25, 2.5, 5, 8, 10, 12.5, 16, 20, 25, 32, 40, 50 and
  80 MSPS. The RF port snaps requests below 8 MSPS up to 8 MSPS; HF ports use the
  software DDC and can reach 625 kSPS.
- The HF ports use direct sampling; LNA/VGA do nothing there. `HF1+HF2` streams
  the primary channel in this build (WebSDR has one receiver per dongle).
- Install the vendor `libfobos` package and its udev rules. Receive only.

### Phase 2 — Airspy family

- `airspy` (R2/Mini): f32→u8 conversion, gain step/curve, LNA/Mixer AGC.
- `airspyhf`: host DC/IQ-balance/NCO already inside the driver; expose AGC,
  attenuator, LNA, calibration PPB and `lib_dsp`.
- `hydrasdr`: same shape as Airspy plus RF port.

### Phase 3 — wideband / specialty

- `rx888`: firmware upload, ADC rate, tuner crossover; consider exposing the
  driver's wide spectrum later.
- `elad`: FPGA image selection per rate, attenuator/preselector.
- `pluto`: IIOD network source, not USB; add to the network source path rather
  than the USB one.

### Vendor-library builds

- `sdrplay`, `lime`, `fobos` compile everywhere because the vendor libraries are
  only opened at runtime. They are part of the default feature set; a machine
  without the library/service still builds, starts, and reports a specific error
  when a dongle using that source is opened.
- CI builds with `--all-features`; no vendor SDK is installed on the runners.
- Release archives do **not** bundle vendor libraries. The operator installs
  them separately and starts the SDRplay service where applicable.

## Admin device scan

`GET /api/admin/devices?type=<source>` enumerates every implemented backend
without opening a device. Omitting `type` scans all of them. The response is a
flat list of `{source, name, serial, index, address, label, detail}` rows.
The admin page filters that list by the selected source type and copies the
serial, index or network address into the dongle config.
