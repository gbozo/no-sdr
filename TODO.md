# TODO — no-sdr

See [WORK.md](./WORK.md) for the active task backlog and completed history.

## Known Issues

- [ ] **Audio not re-enabled after WS reconnect** — AudioWorklet state not restored; audio silent until page reload
- [ ] **Spectral NR (Wiener) artifacts** — robotic artefacts on tonal signals; LMS ANR is the recommended path, Wiener should be removed

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
