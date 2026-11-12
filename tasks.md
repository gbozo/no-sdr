# Tasks — Digital Decoders

Last updated: v2.12.0

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

- [ ] **VDL2** — 136.9 MHz, D8PSK 10500 baud, 25 kHz channel; use
      `sdroxide-vdl2`; table of messages/stations.
- [x] **ACARS** — 131.55/131.725 MHz AM-MSK; ACARS receiver adapted from
      `sdroxide-digi`, foreground/background; table (mode, address, label,
      block, text, CRC, time).
- [ ] **HFDL** — HF uplink/downlink; use `sdroxide-hfdl`; table of frames and
      stations.
- [x] **ADS-B** — 1090 MHz raw IQ, 2 MSPS; `sdroxide-adsb`; aircraft table
      plus OpenStreetMap with callsign, altitude, speed, heading, squawk and
      last-seen. Foreground and background; snapshots upsert as entities.
- [x] **AIS** — 161.975/162.025 MHz, 25 kHz; `sdroxide-ais`; vessel table
      plus OSM map (MMSI, name, type, position, course, speed, destination).
- [ ] **APRS** — 144.39 MHz (regional variants), AX.25 1200/9600 baud; use
      `sdroxide-aprs`; packet table plus map for position reports.
- [ ] **NAVTEX** — 518/490 kHz and 4209.5 kHz, SITOR-B; text panel with
      message type, station and timestamp.

## Utility and packet modes

- [ ] **ISM** — use `sdroxide-ism`; table of sensor/device frames.
- [ ] **PACKET** — AX.25 1200/9600 baud; reuse `sdroxide-ax25`/TNC modem
      primitives; packet table and raw hex view.

## Image modes

- [ ] **Weather fax** — use the WEFAX controller/decoder from `sdroxide-digi`;
      image viewer with line/time metadata, auto-start on VIS/APT where present.
- [ ] **SSTV** — use the SSTV controller/decoder; image viewer with mode, sync
      status and received-picture history.
- [ ] **Hellschreiber** — use the Hell controller; scrolling text/image panel.

## Keyboard and text modes

- [ ] **Olivia / THOR / FSQ** — use the text modem controller; text panel with
      mode parameters (tones, bandwidth, baud) and station log.
- [ ] **PSK31 / RTTY** — text panel, AFC/reverse controls, baud/shift display.
- [ ] Shared text-mode log with copy, clear, timestamp and frequency columns.

## Weak-signal modes

- [ ] **MSK144 / FSK441** — meteor-scatter tables with burst time, frequency,
      SNR and text.
- [ ] **FST4 / Q65** — mfsk-core decoders; tables with period, DT, SNR and
      message.
- [ ] **JT65 / JT9** — mfsk-core decoders; tables with period and DT.
- [ ] **WSPR / PI4** — WSPR spots and PI4 beacon results; optional upload to
      WSPRnet/PSK Reporter.

## Voice and messaging

- [ ] **FreeDV RADE** — use `sdroxide-rade`; audio playback panel and callsign/
      sync status.
- [ ] **JS8** — use the JS8 controller/protocol; table of directed/group
      messages and station list.

## Decoder output UI

- [ ] ADSB: map + most-recent-aircraft table (left table, right map).
- [ ] AIS: map + vessel table, track history.
- [ ] APRS: map + packet table, station paths.
- [ ] ACARS/VDL2/HFDL: message table with expandable raw frames.
- [ ] NAVTEX / PSK31 / RTTY / Olivia / THOR / FSQ / Hell: text log.
- [ ] SSTV / WEFAX: image panel with received-image history.
- [ ] RADE: audio/status panel.
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
