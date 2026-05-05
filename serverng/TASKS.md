# serverng — Task Tracker

*Current version: v2.3.1*

---

## Active

### Fix: protocol_test.go broken by wire-format update
- [ ] `TestPackIQAdpcmMessage` calls old 2-arg `PackIQAdpcmMessage(data, sampleCount)` — now requires 3 args (add `sampleRate uint32`)
- [ ] `TestPackIQMessage` calls old 1-arg `PackIQMessage(samples)` — now requires 2 args (add `sampleRate uint32`)
- **File:** `serverng/internal/ws/protocol_test.go`

### Fix: `go vet` warnings
- [ ] `internal/demod/cquam.go:177` — self-assignment of `c.cosGamma` (vet: self-assignment)
- [ ] `internal/dongle/manager.go:719` — `net.Dial` with `"%s:%d"` format string doesn't handle IPv6 addresses (use `net.JoinHostPort` instead)

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

### T54 — RDS Extended Group Types (client-side decoder)
- [ ] Group 1A: ECC (Enhanced Country Code)
- [ ] Group 10A: PTYN (Programme Type Name, 8 chars)
- [ ] Group 14A: EON (Enhanced Other Networks — alternative frequencies)
- **File:** `client/src/engine/rds-decoder.ts:291` (existing TODO comment)
- **Note:** Server-side Go decoder (`serverng/internal/demod/rds.go`) also only handles 0A/0B and 2A/2B

### T55 — Server-Side RDS Extended Groups
- [ ] Match client-side additions once T54 is done
- [ ] Add PTY, PI to `RdsData` wire JSON (already present) — verify CT (group 4A clock time) parsing
- **File:** `serverng/internal/demod/rds.go`

### T56 — IQ Recording (SigMF)
- [ ] REST endpoint `POST /api/admin/record` → start IQ capture to file
- [ ] `DELETE /api/admin/record` → stop + return file path
- [ ] SigMF metadata sidecar (`.sigmf-meta` JSON)
- [ ] File naming: `{dongleID}_{centerFreq}_{timestamp}.sigmf-data`
- **Files:** `serverng/internal/api/admin.go`, new `serverng/internal/dongle/recorder.go`

### T57 — Graceful Shutdown Hardening
- [ ] Verify Opus encoder `Close()` is called on all client pipelines during shutdown
- [ ] Confirm `dongleMgr.Stop()` waits for all `runDongle` goroutines to exit (currently uses `cancel()` only)
- [ ] Add shutdown timeout log entry if drain exceeds 5s
- **File:** `serverng/cmd/serverng/main.go` (shutdown already wired, needs verification)

---

## Done (Phase 1–4, v2.0.0–v2.3.1)

All Phase 1–4 tasks complete. See [WORK.md](../WORK.md) for full history.

Notable post-v2.0.0 server work:
- [x] Wire-driven IQ protocol headers (MSG_IQ 6-byte, MSG_IQ_ADPCM 10-byte)
- [x] RDS decoder rewritten to IEC 62106 standard, wired into OpusPipeline
- [x] Opus chipmunk fix: `SetMode()` recalculates `decimFactor` after updating `p.mode`
- [x] Admin FFT hot-apply: `SwitchProfile` unconditionally rebuilds `FftProcessor`
- [x] `stereoEnabled` propagated to `OpusPipeline` at construction; `ws.Client.StereoEnabled` defaults to `true`
- [x] Resilient dongle boot (5-retry exponential backoff)
- [x] Config versioning + optimistic concurrency (ETag/If-Match)
- [x] DC offset removal DSP block, sqrt/fast-atan optimisations
