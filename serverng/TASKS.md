# serverng — Task Tracker

All Phase 1–4 tasks are complete as of v2.0.0.

See [WORK.md](../WORK.md) for the active backlog.

## Remaining (Phase 5)

- [ ] **T50** — Benchmarks: `go test -bench .` FFT (N=2048→65536), IqExtractor throughput, ADPCM encode, full pipeline latency
- [ ] **T52** — Graceful shutdown: SIGINT/SIGTERM → drain connections → close dongles → exit
- [ ] **T53** — Integration test: start in demo mode, verify FFT + IQ frames over WS (no browser)

T51 (Docker cross-compile) is partially done — Dockerfile exists but multi-arch builds need verification.
