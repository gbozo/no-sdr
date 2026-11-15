# TODO — no-sdr

See [WORK.md](./WORK.md) for the active task backlog and completed history.

## Future Features

### Audio & DSP
- [ ] Audio time-shift / seek-back
- [ ] Kaiser window + slow-scan FFT
- [ ] FM-IF spectral NR (pre-demod)
- [ ] Adaptive L-R LPF for WFM stereo blend

### Display & UI
- [ ] WebGL waterfall (GPU, large FFT, smooth zoom)

### Infrastructure
- [ ] IQ recording (SigMF)
- [ ] User sessions (per-user persistent settings)
- [ ] Multi-server aggregation
- [ ] Docker cross-compile (amd64, arm64, darwin)

### Decoders
- [ ] DMR/D-Star/YSF (digiham WASM)
- [ ] DAB/DAB+ (welle.io WASM)
- [ ] NOAA APT
- [ ] Meteor M2 LRPT

## Recently Completed

### Background decoder history
- [x] Admin **Decoders** section with a curated background-mode catalog (FT8-family, WSPR, JS8, ADS-B, AIS, VDL2, HFDL, APRS, NAVTEX, PACKET, ISM and time signals; RTTY/text/image modes stay foreground-only)
- [x] Decoder add/edit/delete/enable, quick-add presets, immediate worker reload and Save Config persistence
- [x] Per-decoder `retentionDays` override plus global retention, max-message cap and 30-minute maintenance purges
- [x] SQLite history API (`/api/decoder/history`, `/summary`, `/modes`) with configured-decoder and retention filtering, plus raw `includeUnconfigured=1` audit mode
- [x] Deduplicated rolling snapshots for VDL2/HFDL/ISM; ADS-B/AIS retain keyed entity tables
- [x] Client decoder **History** panel, merged live/persisted FT8-family table and aircraft/vessel history
- [x] Manual purges by mode, age or all rows; admin storage summary and recent-decode preview

### Receiver location map
- [x] Admin **General → Receiver Location (Map)** with OpenStreetMap tiles, Nominatim address search, click-to-pin and draggable marker
- [x] `server.receiverLatitude` / `server.receiverLongitude`, stored separately from the display-only `server.location` text
- [x] Coordinates exposed in public server metadata for future contact/decoder map overlays

### Weather overlay credentials
- [x] Admin **General → Weather Overlay** setting for the OpenWeatherMap API key
- [x] `server.openWeatherMapApiKey` persisted through Save Config and kept out of public server metadata for future server-side cloud/weather map tiles
