# serverng — Task Tracker

*Current version: v2.3.1*

---

## Active

None — all known issues resolved.

---

## Backlog

### T51 — Docker Multi-Arch Verification
- [ ] Verify `docker buildx build --platform linux/amd64,linux/arm64` produces working images
- [ ] Add `docker-compose.yml` healthcheck using `/api/status`
- **Files:** `docker/Dockerfile`, `docker/docker-compose.yml`

---

## Done

### T50 — Dongle Pipeline Benchmarks ✓
- [x] `BenchmarkEndToEndPipeline` — raw uint8 IQ → IqExtractor → FmStereoDemod (WFM, 240kHz sub-band)
- [x] `BenchmarkEndToEndPipelineNFM` — same for NFM (48kHz, mono)
- [x] `BenchmarkMultiClientContention/{1,2,5,10}_clients` — N parallel goroutines all processing the same IQ chunk concurrently (fan-out model)
- [x] `BenchmarkAdpcmEncodeIQ` — ADPCM encode throughput on a 20ms chunk
- **File:** `serverng/internal/dongle/bench_test.go`
- **Note:** Opus encode not benchmarked here (requires `-tags opus`); covered by `serverng/internal/codec/` benchmarks

### T53 — Integration Tests ✓
- [x] `TestIntegration_FullPipeline` — health, dongles API, WS subscribe, FFT + IQ frames verified
- [x] `TestIntegration_NoiseBlankerControl` — IQ received with NB enabled
- [x] `BenchmarkLoad5Clients` — 5 concurrent WS clients, frames/sec/client measured
- **File:** `serverng/test/integration_test.go` (build tag: `integration`)
- **Run:** `go test -tags integration ./test/...`

### Active issues fixed (previously listed)
- [x] `protocol_test.go` broken by IQ wire-format update — tests updated for new 6/10-byte headers
- [x] `go vet` warnings — cquam self-assignment removed, IPv6 dial fixed with `net.JoinHostPort`

### T54–T57 (all complete)
See [WORK.md](../WORK.md) for full history.
