# serverng — Task Tracker

*Current version: v2.3.1*

---

## Active

None — all known issues resolved.

---

## Backlog

### T50 — Extend Benchmarks
- [ ] Add full-pipeline benchmark: IQ source → IqExtractor → OpusPipeline → Encode (end-to-end latency per client)
- [ ] Add multi-client contention benchmark (5 clients, measure per-client throughput degradation)
- **Files:** `serverng/internal/dongle/bench_test.go` (new)

### T51 — Docker Multi-Arch Verification
- [ ] Verify `docker buildx build --platform linux/amd64,linux/arm64` produces working images
- [ ] Add `docker-compose.yml` healthcheck using `/api/status`
- **Files:** `docker/Dockerfile`, `docker/docker-compose.yml`

---

## Done

### Active issues fixed (previously listed)
- [x] `protocol_test.go` broken by IQ wire-format update — tests updated for new 6/10-byte headers
- [x] `go vet` warnings — cquam self-assignment removed, IPv6 dial fixed with `net.JoinHostPort`

### T54 — RDS Extended Group Types (client-side)
- [x] Group 1A: ECC (Extended Country Code) — `data.ecc`
- [x] Group 10A: PTYN (Programme Type Name, 8 chars) — `data.ptyn`
- [x] Group 14A: EON (Enhanced Other Networks) — `data.eon[]` with PI, PS, AF
- **File:** `client/src/engine/rds-decoder.ts`

### T55 — RDS Extended Group Types (server-side Go)
- [x] `RdsData` extended: `ECC *uint8`, `PTYN string`, `EON []EonEntry`
- [x] `EonEntry` struct: PI, PS, AF
- [x] Group 1A, 10A, 14A parsing in `groupParser.parse()`
- [x] `groupParser` extended: `ptynChars`, `eonMap`
- [x] Change-detection switched from struct `!=` to JSON comparison (supports pointer/slice fields)
- **Files:** `serverng/internal/demod/rds.go`, `serverng/internal/dongle/opus_pipeline.go`

### T56 — IQ Recording (SigMF)
- [x] `serverng/internal/dongle/recorder.go` — `Recorder` with `Start`, `Stop`, `WriteIQ`, `Status`
- [x] SigMF sidecar (`.sigmf-meta`) with `cu8` datatype, center freq, sample rate, datetime
- [x] `Manager.Recorder` wired into `runDongle` hot path
- [x] Admin REST endpoints: `POST /api/admin/dongles/{id}/record`, `DELETE /api/admin/dongles/{id}/record`, `GET /api/admin/recordings`
- [x] `RecordStartFunc`, `RecordStopFunc`, `RecordStatusFunc` wired in `main.go`

### T57 — Graceful Shutdown Hardening
- [x] `Manager.Stop()` now closes all `clientPipeline.opusPipeline` (was leaking libopus encoder memory)
- [x] Active IQ recordings are stopped cleanly on shutdown with SigMF metadata written
- [x] Drain timeout logged as `Warn` when WebSocket drain exceeds 5s
- [x] Shutdown elapsed time logged on clean exit

### Phase 1–4, v2.0.0–v2.3.1 (all complete)
See [WORK.md](../WORK.md) for full history.
