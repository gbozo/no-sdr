# Handoff — ADS-B decoder with OpenStreetMap

## Mission

Implement **ADS-B / Mode S** as the next digital decoder, with:

- **Left:** live aircraft table
- **Right:** OpenStreetMap map with aircraft positions
- **Both foreground and background** decoder support
- Existing FT8/FT4/FT2 behaviour must remain unchanged

This is a full implementation task, not just a UI mock-up.

## Repository state

- Repo: `/home/opencode/src/no-sdr`
- Branch: `main`
- Decoder work is committed in `f8acb48`:
  `feat(decoders): add FT8/FT4/FT2 background and foreground decoding`
- Only `tasks.md` is currently modified (decoder backlog).
- Server currently runs locally at `http://127.0.0.1:3000`; log `/tmp/no-sdr-local.log`.
- Do **not** commit, push or create a release unless explicitly instructed.

Read these before editing:

- `AGENTS.md`
- `docs/decoders.md`
- `tasks.md`
- `serverrs/src/decoders/mod.rs`
- `serverrs/src/decoders/store.rs`
- `serverrs/src/dongle/manager.rs`
- `client/src/components/DecoderDisplay.tsx`
- `client/src/store/index.ts`
- `client/src/engine/sdr-engine.ts`

## Existing decoder architecture

Current implementation is in `serverrs/src/decoders/mod.rs`:

- `DecoderManager` starts one worker per dongle.
- Slotted modes FT8/FT4/FT2 use:
  - `IqExtractor`
  - USB `SsbDemod`
  - linear resampling to 12 kHz
  - wall-clock slot buffer
  - a separate slot decode worker
- Foreground mode is per-client (`cmd: "decoder"`), background mode comes from
  `config.yaml` `decoders:`.
- Results use `MSG_DECODER` (`0x06`): `{decoderType, data}`.
- SQLite history is in `serverrs/src/decoders/store.rs`.
- Client consumes messages through `SdrEngine.onDecoderData`.
- The UI currently assumes every decoder is a slotted FT8-family mode:
  `client/src/components/DecoderDisplay.tsx` is a table + zoomed waterfall.

ADS-B is different: it needs **raw IQ at 1090 MHz**, not 12 kHz audio. Do not
route it through `IqExtractor`/`SsbDemod`.

## ADS-B decoder source

Use the pinned sdroxide crate:

- `sdroxide-adsb` at the same git revision already used by the other sdroxide
  dependencies (`6f0994e...`).
- It is pure Rust, no C dependency.
- Key API in `crates/sdroxide-adsb/src/controller.rs`:

```rust
AdsbController::new(window_center_hz: f64, window_rate_hz: f64, cfg: AdsbSettings)
controller.on_rx_iq(&[Complex32]);
controller.set_window(center_hz, rate_hz);
controller.set_home(Some((lat, lon)));
controller.poll() -> Vec<AdsbAction>;
```

`AdsbAction::Status(Box<AdsbStatus>)` contains:

- `aircraft: Vec<AdsbAircraft>`
- `unavailable`, `degraded`, `suggest_center_hz`
- `window_center_hz`, `window_rate_hz`
- `preambles`, `frames`, `bad_crc`, `unmatched`

`AdsbAircraft` fields to expose:

- `icao: u32`
- `callsign: String`
- `category: Option<String>`
- `lat: Option<f64>`, `lon: Option<f64>`
- `track: Vec<(f32, f32)>` (history)
- `altitude_ft`, `gnss_altitude_ft`
- `ground_speed_kt`, `track_deg`, `vertical_rate_fpm`
- `turn_rate_deg_s`, `on_ground`, `squawk`, `emergency`
- `rssi_dbfs`, `frames`, `first_at`, `last_at`, `last_pos_at`, `raw_hex`

Constants/types are in `crates/sdroxide-types/src/adsb.rs`:

- `ADSB_FREQ_HZ = 1_090_000_000`
- `ADSB_MIN_RATE_HZ = 2_000_000`
- `ADSB_GOOD_RATE_HZ = 2_400_000`
- `AdsbSettings`, `AdsbStatus`, `AdsbAircraft`

### Receiver constraints

The dongle/profile must deliver at least 2 MSPS and the window must contain
1090 MHz. Use `sdroxide_adsb::window_covers(center_hz, rate_hz)`.

If the current dongle cannot meet that, do **not** silently show an empty list.
Emit `unavailable`/`degraded` text and show it in the UI.

## Backend implementation

### 1. Cargo feature

Add an optional `sdroxide-adsb` dependency and a default `adsb` feature in
`serverrs/Cargo.toml`. It uses `sdroxide-types`/`sdroxide-dsp`; no C build.

### 2. Decoder kind

Add an ADS-B path to the decoder subsystem. Suggested shape:

```rust
enum DecoderKind {
    Mfsk(AnyDecoder),
    Ft2,
    Adsb(AdsbController),
}
```

But because ADS-B takes raw IQ, it is cleaner to add a separate
`AdsbWorker` / `RawIqDecoder` rather than forcing it through `Channel`.

Requirements:

- receive raw `Cu8` interleaved IQ from `DecoderManager::push_chunk`
- convert to `Complex32` at the source boundary
- feed `controller.on_rx_iq(...)`
- update `set_window(center_hz, rate_hz)` when the profile changes
- poll status about twice per second
- broadcast snapshots as `MSG_DECODER` with `decoderType: "adsb"`

Suggested JSON payload:

```json
{
  "decoderType": "adsb",
  "data": {
    "aircraft": [ ...AdsbAircraft fields... ],
    "unavailable": null,
    "degraded": null,
    "suggestCenterHz": null,
    "windowCenterHz": 1090000000,
    "windowRateHz": 2400000,
    "preambles": 123,
    "frames": 45,
    "badCrc": 8,
    "unmatched": 2
  }
}
```

### 3. Background configuration

Accept `mode: adsb` in `decoders:`:

```yaml
decoders:
  - id: adsb-local
    enabled: true
    dongleId: dongle-mooroo30
    mode: adsb
    frequencyHz: 1090000000
    bandwidthHz: 2400000
```

Notes:

- `frequencyHz` is 1090 MHz.
- The profile sample rate must be 2.4 MSPS for full sensitivity; 2.0 MSPS is
  accepted but degraded.
- The background `DecoderConfig` currently assumes dongle-level workers; keep
  that model.
- `AdsbSettings` defaults are fine; expose later settings such as
  `drop_map_s`, `drop_list_s`, history points, and max aircraft if needed.

### 4. Foreground configuration

Client sends:

```json
{ "cmd": "decoder", "mode": "adsb" }
```

The existing foreground `ClientPipeline` is audio/12k-IQ based. Add a raw-IQ
tap for ADS-B:

- create a per-client ADS-B worker when mode is `adsb`
- feed raw dongle chunks (respecting the dongle/profile center/rate)
- send snapshots only to that client
- stop the worker on decoder off / disconnect / dongle stop

Do not break the existing foreground FT8 path.

### 5. Persistence

Do not insert an entire aircraft snapshot into `decoder_messages` every 500 ms.
Instead:

- use `decoder_entities` with `kind = "aircraft"` and `entity_key = icao`
- upsert callsign, position, altitude, speed, squawk, last_seen, raw JSON
- optionally write notable events to `decoder_messages`
- add read APIs such as `/api/decoder/aircraft` later

The current `decoder_entities` table exists but has no accessors yet.

## Client implementation

### State

Add to `client/src/store/index.ts`:

- `adsbAircraft` signal (map keyed by ICAO or array upsert)
- `adsbStatus` signal containing unavailable/degraded/stats
- actions to merge a snapshot and clear on decoder off/tune/dongle change

`App.tsx` already wires `engine.onDecoderData`; add a branch for `"adsb"`.

### Selector

- Add `ADS-B` to the decoder selector (`ControlPanel.tsx` and
  `DecoderDisplay.tsx`).
- Selecting it should set `store.decoderMode('adsb')`.
- Do not show the FT8 zoom waterfall for ADS-B.

### Layout

`DecoderDisplay.tsx` needs a decoder-type switch:

- `ft8`/`ft4`/`ft2`: existing table + zoomed waterfall.
- `adsb`: **left aircraft table + right OpenStreetMap**.

Suggested ADS-B layout:

```
┌─────────────────────────────────────────────────────────────┐
│ ADS-B  [FT8] [FT4] [FT2] [ADS-B]                    status │
├──────────────────────────────┬──────────────────────────────┤
│ Aircraft table               │ OpenStreetMap                │
│ ICAO  CALLSIGN  ALT  GS  TRK │   aircraft markers           │
│ ...                          │   selected track/history     │
└──────────────────────────────┴──────────────────────────────┘
```

### Aircraft table

Columns:

- ICAO hex
- callsign
- altitude ft
- ground speed kt
- track degrees
- vertical rate fpm
- squawk
- last seen / age
- maybe distance from home

Sort by callsign, altitude, or last seen. Selecting a row:

- highlights the map marker
- pans/fits the map to that aircraft
- opens a details popup/side card

Empty state:

- `No aircraft heard`
- if `unavailable`/`degraded`, show that message prominently
- show `preambles/frames/badCrc` diagnostics in small text

### OpenStreetMap

Use **Leaflet** (`leaflet` + `leaflet/dist/leaflet.css`) for the simplest,
mature implementation.

- Tile URL: `https://tile.openstreetmap.org/{z}/{x}/{y}.png`
- Attribution: `© OpenStreetMap contributors`
- Follow OSM tile usage policy; no bulk/offline scraping.
- Create the map once in `onMount`, destroy on cleanup.
- Use a persistent marker layer; update markers in place on each snapshot.
- Marker glyph: small plane/arrow rotated by `track_deg`; fall back to a circle
  when track is unknown.
- Draw `track` history as a polyline and optionally a short leader vector.
- Selected aircraft: accent-colored marker, popup with callsign, altitude,
  speed, squawk, emergency, last seen, raw ICAO.
- Provide a “fit aircraft” button and a “follow selected” toggle.
- Handle aircraft without lat/lon: table row only, no marker.
- Do not recreate the Leaflet map on every WebSocket snapshot.

### Broker/data flow

```
sdroxide-adsb AdsbController
  → AdsbAction::Status snapshot
  → pack_decoder_message("adsb", json)
  → MSG_DECODER
  → SdrEngine.onDecoderData("adsb", data)
  → store.adsbAircraft / adsbStatus
  → DecoderDisplay ADS-B table + Leaflet map
```

## Files likely to change

Backend:

- `serverrs/Cargo.toml`
- `serverrs/src/decoders/mod.rs` (or a new `adsb.rs`)
- `serverrs/src/config.rs`
- `serverrs/src/dongle/manager.rs`
- `serverrs/src/api/decoders.rs` (entity APIs later)
- `serverrs/src/decoders/store.rs` (entity upserts)
- `serverrs/src/ws/protocol.rs` only if a dedicated packer is useful

Client:

- `client/package.json` (`leaflet`, `@types/leaflet`)
- `client/src/store/index.ts`
- `client/src/components/DecoderDisplay.tsx`
- new `client/src/components/AdsbMap.tsx` (recommended)
- `client/src/components/ControlPanel.tsx`
- `client/src/App.tsx` only if layout switching needs changes
- `client/src/shared/types.ts` / `modes.ts` if the decoder type needs widening

Docs:

- `docs/decoders.md`
- `docs/handoff-adsb.md` (this file)
- `tasks.md`

## Validation

### Unit/integration

- Add a synthetic ADS-B test using `sdroxide_adsb::modulate` / `Demod`.
- Test `window_covers` failure and degraded-rate paths.
- Test snapshot JSON shape and SQLite entity upsert.
- Test foreground and background worker lifecycle.
- `cargo test --all-features`
- `cargo check --no-default-features`
- `npm run typecheck`
- `npm run build:client`

### Runtime

- Local RTL-SDR profile centered at 1090 MHz, sample rate 2.4 MSPS.
- Add a background decoder:
  `mode: adsb`, `frequencyHz: 1090000000`.
- Enable foreground ADS-B from the client.
- Confirm:
  - aircraft table fills
  - markers appear on OSM
  - selecting a row highlights/pans the map
  - no aircraft shows a useful empty state
  - unsupported rate/center shows `unavailable`/`degraded`
  - FT8 mode still works unchanged
  - no decoder slot stalls the dongle loop

### Acceptance criteria

- [ ] ADS-B is selectable as foreground and configurable as background.
- [ ] Aircraft list is on the left.
- [ ] OpenStreetMap is on the right with attribution.
- [ ] Markers update without rebuilding the map.
- [ ] Row selection highlights the aircraft and pans the map.
- [ ] Track history and leader vector render where available.
- [ ] Unsupported receiver configurations explain why.
- [ ] ADS-B snapshots are persisted as entities, not spammed into message
      history.
- [ ] FT8/FT4/FT2 continue to pass and render correctly.
- [ ] Typecheck, client build and Rust tests pass.

## Constraints

- Do not use a third-party web map API key. Leaflet + OSM tiles only.
- Keep OSM attribution visible.
- Do not commit/push/release unless explicitly asked.
- Keep ADS-B off the 12 kHz audio path.
- Keep the existing decoder table/waterfall for FT8-family modes intact.
