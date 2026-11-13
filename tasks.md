# Tasks — Digital Decoders

Last updated: v2.15.0

FT8/FT4/FT2 background and foreground decoding are implemented. The items below
are the remaining decoder work, in intended order.

## Delivered

- [x] Background decoder manager (one worker per dongle, OpenWebRX-style)
- [x] Foreground per-client decoder command
- [x] FT8, FT4 and FT2 decode paths
- [x] `MSG_DECODER` transport
- [x] SQLite message history, retention and read API
- [x] Decode table + decoder-frequency waterfall split view
- [x] RTL-SDR stream watchdog

See `docs/decoders.md` for the current architecture and config format.

## Immediate decoder framework work

- [ ] Decoder capability registry (`/api/decoder/capabilities`): mode name,
      transport kind (slotted/continuous/burst), required IQ width, settings
      schema, output kind (table/map/image/audio).
- [ ] Make the client decoder workspace data-driven from that registry instead
      of the hard-coded FT8/FT4/FT2 selector.
- [ ] Add a continuous/burst channel kind alongside the current UTC-slot path.
- [ ] Add a shared decoder worker budget/limit so many decoders cannot exhaust
      CPU or unbounded queues.
- [ ] Add decoder health/status: last audio, last decode, dropped slots,
      CPU/queue depth, last error.
- [ ] Verify the secondary decoder waterfall polling against live FFT frames and
      fix the `waiting for spectrum…` state if it persists.
- [ ] Admin CRUD for decoder definitions (currently YAML-only).
- [ ] Per-decoder settings validation and capability-driven controls.
- [ ] Decoder-specific layout switch in the bottom workspace: table, map, image
      or audio depending on decoder type.

## Aviation and marine data

- [x] **VDL2** — 136.8125 MHz, D8PSK 10500 baud, fourteen 25 kHz channels;
      `sdroxide-vdl2`; message log + station table, filter by station.
- [x] **ACARS** — 131.55/131.725 MHz AM-MSK; ACARS receiver adapted from
      `sdroxide-digi`, foreground/background; table (mode, address, label,
      block, text, CRC, time).
- [x] **HFDL** — ARINC 635; 24 kHz lane via `sdroxide-hfdl`/`xng-mode-hfdl`;
      rolling event log with ground station, SNR, frequency skew, FEC count and
      position fixes; foreground and background.
- [x] **ADS-B** — 1090 MHz raw IQ, 2 MSPS; `sdroxide-adsb`; aircraft table
      plus OpenStreetMap with callsign, altitude, speed, heading, squawk and
      last-seen. Foreground and background; snapshots upsert as entities.
- [x] **AIS** — 161.975/162.025 MHz, 25 kHz; `sdroxide-ais`; vessel table
      plus OSM map (MMSI, name, type, position, course, speed, destination).
- [x] **APRS** — 144.39 MHz (regional variants), AX.25 1200 baud Bell 202;
      `sdroxide-aprs` + `sdroxide-ax25` over the NBFM/48 kHz audio path;
      packet table plus OSM map for position reports; foreground and
      background.
- [x] **NAVTEX** — 518/490 kHz and 4209.5 kHz, SITOR-B; text panel with
      message type, station and timestamp; foreground and background.

## Utility and packet modes

- [x] **ISM** — `sdroxide-ism` native lane over raw IQ; device table with
      readings, channel plan and foreground/background operation.
- [x] **PACKET** — AX.25 1200/9600 baud; reuse `sdroxide-ax25`/TNC modem
      primitives; packet table and raw hex view.

## Time signals

- [x] **DCF77** — 77.5 kHz amplitude pulse-width receiver; 59-bit minute
      decoder with BCD/parity and CET/CEST, DST, leap-second, holiday and
      clock-change flags; foreground and background.
- [x] **ALS162** — 162 kHz phase-modulated receiver; 25/50/25 ms triangular
      pulse detection, 1/2-pulse bit clock, 59-bit BCD/parity minute decoder;
      foreground and background.
- [x] Time-signal panel with decoded local time, date, UTC offset and
      DST/leap/holiday/clock-change flags.

## Image modes

- [x] **Weather fax** — `sdroxide-dsp` WEFAX receiver adapted locally; USB
      audio channel; image viewer with IOC/LPM, phasing, subcarrier and line
      status; foreground and background.
- [x] **SSTV** — `sdroxide-dsp` SSTV receiver adapted locally; VIS auto-detect,
      progressive RGB lines, callsign/FSTV ID, mode and sync status, received-
      picture history; foreground and background.
- [x] **Hellschreiber** — `sdroxide-dsp` HellRx adapted locally; USB audio
      channel at 12 kHz, Feld/Slow/X5/X9/FSK245/FSK105/Hell80 variants,
      scrolling dot-column raster; foreground and background.

## Keyboard and text modes

- [x] **Olivia / THOR / FSQ** — local MFSK receivers; USB audio channel at
      8 kHz modem rate, configurable tones/bandwidth/baud, running text log.
- [x] **PSK31 / RTTY** — local PSK31 and RTTY receivers; USB audio channel at
      8 kHz modem rate, Varicode/Baudot text, AFC/reverse settings and
      baud/shift display.
- [x] Shared text-mode log with clear, chunk view, timestamp and frequency
      columns.

## Weak-signal modes

- [x] **MSK144 / FSK441** — meteor-scatter tables with burst time, frequency,
      SNR and text.
- [x] **FST4 / Q65** — mfsk-core decoders; tables with period, DT, SNR and
      message.
- [x] **JT65 / JT9** — mfsk-core decoders; tables with period and DT.
- [x] **WSPR / PI4** — WSPR 120-second spots and PI4 one-minute beacon results;
      shared weak-signal table, PI4 variant/fit columns.
- [ ] Optional WSPRnet/PSK Reporter spot upload for WSPR decodes.

## Voice and messaging

- [x] **JS8** — JS8Call protocol adapted locally; message table with directed
      and group traffic plus heard-station list.

## Decoder output UI

- [ ] ADSB: map + most-recent-aircraft table (left table, right map).
- [ ] AIS: map + vessel table, track history.
- [x] APRS: map + packet table, station paths.
- [ ] ACARS/VDL2/HFDL: message table with expandable raw frames.
- [x] NAVTEX: message table with full-text panel.
- [x] ISM: device/readings table with selected-device raw frame details.
- [x] Olivia / THOR / FSQ: text log.
- [ ] PSK31 / RTTY: text log with AFC/reverse controls.
- [x] Hellschreiber: scrolling dot-raster panel.
- [x] WEFAX: image panel with IOC/LPM, phasing, subcarrier and line status.
- [x] SSTV: image panel with received-image history.
- [x] JS8: message table + heard-station list.
- [x] Entity selection: clicking a row highlights the map marker and opens
      details/history (ADS-B).
- [x] Decoder-specific secondary pane replaces the zoom waterfall for map and
      image modes (ADS-B uses the table + OSM map).

## Persistence and APIs

- [x] Store typed entities in `decoder_entities` for aircraft with upsert and
      first/last-seen indexes. Vessels, APRS stations and message senders remain.
- [x] Add `/api/decoder/aircraft`; `/api/decoder/vessels` remains.
- [ ] Add filters by decoder id, dongle, mode and time range to
      `/api/decoder/messages`.
- [ ] Add DB schema version/migrations and safe retention/compaction.
- [ ] Optional spot upload: PSK Reporter, WSPRnet, APRS-IS, with config opt-in.
- [ ] Export decoded messages/entities as JSON/CSV.

## Porting and build constraints

- [ ] Selectively port decoder crates from sdroxide rather than linking the
      entire `sdroxide-digi` crate by default.
- [ ] Keep heavy/vendor or C/C++-backed decoders behind opt-in Cargo features.
- [ ] Audit licenses (GPL/AGPL) and add attribution for ported code.
- [ ] Add feature-matrix CI for each decoder family.
- [ ] Add recorded IQ/audio test vectors for every decoder.
- [ ] Hardware validation matrix for each decoder family.

## Validation checklist per decoder

- [ ] Synthetic encode/decode round-trip test.
- [ ] Recorded real-signal decode test.
- [ ] Foreground and background operation.
- [ ] SQLite persistence and API retrieval.
- [ ] Correct UI layout and empty/error states.
- [ ] CPU and queue behaviour with multiple decoders enabled.
- [ ] Documentation in `docs/decoders.md` and decoder config reference.
