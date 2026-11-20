# cf-do-fan-out — Cloudflare Durable Object FFT fan-out

**Status:** implemented (P0–P4); deployment/load validation pending
**Scope:** one dongle, stable 12 fps, 32,768-bin FFT, one canonical edge codec, DO-side history ring, automatic fallback to the origin WebSocket.
**Repo targets:** `cloudflare/src/` (Worker + DO), `serverrs/src/edge/` (publisher), `client/src/engine/edge-spectrum.ts` (transport), admin UI.

## Implementation status (2026-11-20)

| Area | State |
|---|---|
| Worker routes/auth/health/stats | implemented |
| DO fan-out, viewer cap, one-ingest rule | implemented |
| DO history ring (range decode + max-hold + 0x0D) | implemented |
| Unit tests (`cloudflare/test`) | passing (17) |
| History wire format | `0x0D` codec 4 (per-frame range), encoded on ingest |
| Rust `EdgeConfig`, publisher, manager hook | implemented |
| `fft_transport` suppression/resume | implemented |
| Admin API (`/api/admin/edge`, test, status) | implemented |
| Admin UI section | implemented |
| Client edge transport + fallback + badge | implemented |
| End-to-end local smoke (origin → DO → viewer) | passing |
| Cloudflare deployment + free-tier quota measurement | **pending** |
| `origin-snapshot` history fallback | deferred; v1 validation accepts only `do-ring`/`off` |
| Viewer auth, regional DOs, demand gating | deferred |


---

## 0. Decisions locked for this phase

| Decision | Value | Reason |
|---|---|---|
| Fan-out layer | Cloudflare Worker + one Durable Object per dongle | Egress-free fan-out, TLS/DDoS termination, no broker |
| Upstream direction | **Push**: origin dials `wss://<edge>/ingest/<instance>/<dongle>` | Works behind NAT/CGNAT; no inbound port on the SDR host |
| Edge codec | **`range` (0x10)** | Smallest live frames; DO has a TS range decoder for history |
| `0x10` | **FFT_RANGE** | Live range-coded frame; decoded by the DO for history, forwarded verbatim to viewers |
| History | **DO-side ring** built by decoding live 0x10 frames, served as `0x0D` codec 4 (per-frame range) | Fresh to the last frame, ~0.7–0.9 MB instead of 2–3 MB, no KV/R2 |
| Fallback | Client-managed `auto -> edge -> origin` | Edge can die, hit quota, or be disabled without breaking audio/control |
| Control/audio | Stay on the existing origin WebSocket | Per-client state, not fan-out traffic |
| Default state | `edge.enabled: false`; desktop/offline stays zero-service | No external dependency until the operator opts in |
| Viewer auth | Public read in v1; ingest token only | Scope control; add signed viewer tokens later |
| Region sharding | One DO in v1; `topic:{id}:{region}` naming reserved | Avoid speculative complexity; measure first |

Non-goals for this phase: MQTT/NATS federation, multi-dongle DO multiplexing, control commands over the edge, per-viewer auth, regional fan-out trees.

---

## 1. Architecture

```
┌──────────────────────────────┐
│ serverrs (origin)            │
│  FFT 32K @ 12 fps            │
│  encode range 0x10            │
│  ├─ local WS clients         │
│  └─ EdgePublisher ───────────┼── 1× WSS, bearer token ──┐
└──────────────────────────────┘                          │
                                                          ▼
                                        ┌──────────────────────────────┐
                                        │ Cloudflare Worker            │
                                        │  /ingest/:instance/:dongle   │
                                        │  /v1/:instance/:dongle/fft   │
                                        │  auth + route + CORS         │
                                        └──────────────┬───────────────┘
                                                       │ stub.fetch
                                                       ▼
                                        ┌──────────────────────────────┐
                                        │ Durable Object (per dongle)  │
                                        │  ingest socket (tag: ingest) │
                                        │  viewers (tag: viewer)       │
                                        │  history ring (2048×512)     │
                                        │  broadcast + stats           │
                                        └──────────────┬───────────────┘
                                                       │ WSS
                                                       ▼
                                        ┌──────────────────────────────┐
                                        │ Browser                      │
                                        │  main WS: control/audio/IQ   │
                                        │  edge WS: FFT + history      │
                                        │  fallback controller         │
                                        └──────────────────────────────┘
```

The origin keeps one outbound socket per dongle. The DO broadcasts each frame to all viewers and maintains a low-resolution history ring. Browser clients receive FFT from the edge and everything else from the origin.

### Why not KV or R2

KV is a poor fit for live history: 1,000 writes/day free, 1 write/sec/key, and up to 60 s propagation. A 12 fps stream cannot use it as a live store. R2 + Cache API is acceptable for a durability fallback, but the DO already sees every frame and can serve a fresher ring with zero extra services. KV/R2 are explicitly out of the v1 path.

---

## 2. Wire protocol

### 2.1 Browser ↔ origin (unchanged)

The existing binary protocol and JSON commands remain. Add one client command:

```json
{ "cmd": "fft_transport", "mode": "off" | "origin" | "edge" }
```

- `edge`: origin stops sending `0x0B`/`0x10` FFT frames to that client (`broadcast_fft_frame` skips it).
- `origin`: origin resumes and the client requests history as today.
- `off`: no FFT at all (radio-only client). This is the default for a new connection; the bundled client explicitly requests `origin` or `edge`.

The flag is per connection and resets on disconnect.

### 2.2 Browser ↔ DO (new)

Same binary frames the client already decodes:

| Type | Use |
|---|---|
| `0x10` | Live range-coded FFT frame, forwarded verbatim |
| `0x0D` | History burst, codec `4` (per-frame range), only when the viewer connects with `?history=1` |
| text | `{"cmd":"ping"}`, `{"cmd":"status"}` |

No new public message type. The DO forwards `0x10` live frames and never sends `0x10` as history.

History body (existing format):

```
0x0D
u16 frameCount
u32 binCount
i16 minDb
i16 maxDb
u8  codec = 4   // per-frame range-coded history
for each frame (oldest first):
  u32 payloadLen
  u8  payload[payloadLen]   // decodeRangeHistory(payload, 1, binCount)
```

The client handles codec 4 in `handleBinaryMessage` with a length-prefixed
`decodeRangeHistory` loop. Codec 3 (whole-burst range) remains supported for
the origin's optional snapshot path.

### 2.3 Ingest ↔ DO (new)

One WebSocket per dongle, authenticated by `Authorization: Bearer <INGEST_TOKEN>`.

| Direction | Payload |
|---|---|
| Origin → DO | `0x10` live frames, verbatim |
| Origin → DO | optional `0x0D` snapshot (only when `history.mode = origin-snapshot`) |
| Origin → DO | `{"cmd":"hello","instance":"...","dongle":"...","codec":"range","maxViewers":200,"history":{"mode":"do-ring","bins":2048,"frames":512}}` |
| Origin → DO | `{"cmd":"ping"}` every 10 s (optional; frames already prove liveness) |
| DO → Origin | `{"cmd":"status","viewers":N,"ringFrames":M}` every 10 s |

`0x10 FFT_RANGE` is the canonical edge codec: the DO decodes it into u8 codes
for history and forwards the original compressed frame to viewers. `0x0B` is
also supported as a fallback codec.

---

## 3. History ring

### 3.1 Parameters

| Setting | Default | Notes |
|---|---:|---|
| `history.mode` | `do-ring` | `do-ring`, `off` (origin-snapshot deferred) |
| `history.bins` | `2048` | Power of two, 256–8192; max-hold decimation from the live 32K frame |
| `history.frames` | `512` | 32–2048; 512 = 42.7 s at 12 fps |
| Memory | ~0.7–0.9 MB | Encoded payloads for `bins × frames`, plus one live frame |
| First-connect burst | ~0.7–0.9 MB per-frame range | Versus 2–3 MB for the current origin history at 4096 × 1024 |

### 3.2 Build path

On every ingest `0x10` range frame:

1. Strip the type byte; read `minDb`, `maxDb`, `binCount` (little-endian).
2. Decode the range-coded body with the TS port of `range.rs`
   (`cloudflare/src/range.ts`) into `Uint8Array(binCount)` of u8 codes.
3. Max-hold decimate to `history.bins`:
   `max(u8[start..end])` per output bin. Max-hold preserves carriers and peaks.
4. Range-encode the decimated frame with a fresh model
   (`encodeRangeFrame`; ~0.13 ms for 2048 bins).
5. Push the encoded payload into a fixed ring (head index, count).

For a `0x0B` fallback frame the path is the same after `inflateSync` and a
forward delta-decode.

On viewer connect:

1. Accept with tag `viewer`.
2. If ring count > 0, build the `0x0D` message with frames oldest-first and `send` it.
3. Live frames follow in order.

The DO does **not** decode or re-encode history per viewer. It concatenates
the already-encoded frames into one `0x0D` codec-4 message on connect.

### 3.3 CPU budget

At 32K bins / 12 fps the DO handles 393k bins/s:

- range decode 32K codes: **~0.56 ms/frame in Node, ~2.5 ms in local `wrangler dev`**; the DO reports a live `historyDecodeAvgMs` in `/stats`
- max-hold 32K → 2048: ~0.1 ms
- per-frame range encode (2048 bins): **~0.13 ms in Node**; included in `historyDecodeAvgMs`
- total: **~2.7 ms per frame in local Workers**, ~3% of a core at 12 fps

The free-plan 10 ms CPU per invocation is comfortable; the range decoder is
well inside it. Confirm on the real Workers runtime and watch
`historyDecodeAvgMs` in the DO stats.

### 3.4 Hibernation and restart

In-memory ring is lost on eviction. With continuous 12 fps the DO stays awake, so this only matters after idle or a code update. On wake the ring refills in 43 s; the first viewer sees a partial prefill. Optional phase 2: persist one low-res snapshot to DO SQLite every 10 s (8,640 row writes/day, within the free 100k/day) and restore on construction.

### 3.5 `origin-snapshot` fallback (deferred)

Not implemented in v1; config validation accepts only `do-ring`/`off`. The DO
still understands incoming `0x0D` snapshots, so this can be enabled later
without a protocol change.

If the DO cannot decode the edge codec or CPU is too high:

- The origin builds the existing `0x0D` message every 5 s.
- The publisher sends it on the ingest socket.
- The DO caches the latest `0x0D` `ArrayBuffer` and serves it to new viewers; it does not broadcast it.
- Freshness ≤5 s; no DO decode.

Locks the codec decision: `range` for `do-ring` (deflate-smooth fallback), anything for `origin-snapshot`.

---

## 4. Fallback state machine

Client states: `origin` → `edge_connecting` → `edge_live` → `edge_degraded` → `origin`.

```
main WS connected + subscribe
        │
        ├─ edge disabled / transport=origin ─────────────► origin
        │
        └─ transport=auto|edge
                │ open edge WS
                ▼
          edge_connecting
                │ first frame ≤ firstFrameTimeout
                ▼
            edge_live ── no frame for staleTimeout ──► fallback
                │                                   │
                │ edge close/error/1027/503         │
                └───────────────────────────────────┘
                                │
                                ▼
                       send fft_transport=origin
                       request_history (origin)
                       show "Origin" status
                       retry edge after retryMs (auto only)
```

Rules:

- **Connect timeout** 2.5 s; **first-frame timeout** 3 s; **stale timeout** 5 s.
- On `edge_connecting` (before the socket opens), send `{"cmd":"fft_transport","mode":"edge"}`. Origin calls `drop_queued_fft()` for that client, so no full-size FFT frames remain queued/in-flight while the DO sends history.
- The server defaults to **FFT off**; a radio-only client simply never sends `fft_transport`.
- On fallback, close the edge socket, send `origin`, request history, and mark `edge_degraded` with the reason.
- While `edge_connecting`, ignore origin FFT frames if the user selected `edge`; for `auto`, render origin until the first edge frame arrives, then switch without clearing the waterfall.
- Route incoming frames by source: `handleBinaryMessage(data, 'edge'|'origin')`; ignore frames from the inactive source. This is the duplicate-suppression boundary.
- On profile change or `subscribe` to a different dongle: close edge, reset state, re-evaluate.
- On main WS reconnect: re-evaluate from `origin`; auto mode may retry edge once.
- Surface status in the client: `Edge`, `Origin`, `Edge retry`, plus a tooltip with the failure reason. Add a manual "Retry network spectrum" action.
- Desktop: edge is off unless explicitly configured; no startup probe.

Quota/error handling:

- Worker returns `429`/`503` with JSON `{error, retryAfter}`.
- Client treats any non-101 upgrade, 1027 error page, or first-frame timeout as fallback.
- No automatic retry storm: jittered backoff, max one probe per 30 s.

---

## 5. Repository layout

```
cloudflare/
  package.json
  tsconfig.json
  wrangler.jsonc
  src/
    worker.ts          # routes, auth, CORS, health, stats proxy
    fanout.ts          # Durable Object: ingest, viewers, broadcast, ring
    history.ts         # ring buffer, delta decode, max-hold, 0x0D pack
    protocol.ts        # constants, frame parsing, type guards
    config.ts          # env parsing, clamps, defaults
  test/
    protocol.test.ts
    history.test.ts
    fanout.test.ts
  README.md            # deploy + local dev notes

serverrs/src/
  edge/
    mod.rs             # EdgeService, lifecycle, status
    publisher.rs       # one WSS publisher per dongle, reconnect, latest-frame
  config.rs            # EdgeConfig + validation + YAML wiring
  api/admin.rs         # GET/PUT /api/admin/edge, test, status
  api/router.rs        # public edge info
  ws/protocol.rs       # fft_transport command field
  ws/client.rs         # per-client fft transport flag
  dongle/manager.rs    # edge publish hook + command handling
  main.rs              # construct/start/reload EdgeService
  lib.rs               # pub mod edge

client/src/
  engine/edge-spectrum.ts     # edge WS client, heartbeat, reconnect
  engine/sdr-engine.ts        # transport selection, fallback controller, source gating
  store/index.ts              # edge status/settings signals
  admin/sections/EdgeSection.tsx
  admin/admin-store.ts        # EdgeConfig load/save/test/status
  admin/AdminPage.tsx         # nav + section switch
  components/ControlPanel.tsx # status badge / retry action (or ConnectionStatus)
```

---

## 6. Cloudflare implementation

### 6.1 `wrangler.jsonc`

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "nosdr-edge",
  "main": "src/worker.ts",
  "compatibility_date": "2026-11-20",
  "observability": { "enabled": true },
  "vars": {
    "EDGE_VERSION": "1",
    "MAX_VIEWERS": "200"
  },
  "durable_objects": {
    "bindings": [{ "name": "FANOUT", "class_name": "Fanout" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["Fanout"] }
  ],
  "routes": [
    { "pattern": "fft.example.com/*", "zone_name": "example.com" }
  ]
}
```

- `INGEST_TOKEN` is a secret: `wrangler secret put INGEST_TOKEN`.
- Free plan uses the default 10 ms CPU limit; do not set `limits.cpu_ms`.
- One `Fanout` class; SQLite-backed migration is mandatory on the free plan even without storage.

### 6.2 Worker (`worker.ts`)

Routes:

| Method | Path | Auth |
|---|---|---|
| GET/Upgrade | `/ingest/:instance/:dongle` | `Authorization: Bearer <INGEST_TOKEN>` |
| GET/Upgrade | `/v1/:instance/:dongle/fft` | public |
| GET | `/health` | public, no secrets |
| GET | `/stats/:instance/:dongle` | bearer (same token) |
| OPTIONS | `/health`, `/stats/*` | CORS preflight |

Behavior:

1. Reject non-`Upgrade: websocket` with 426.
2. Validate `instance`/`dongle` against `^[A-Za-z0-9_-]{1,64}$`.
3. Ingest: constant-time token compare; return 403 on mismatch.
4. Add trusted headers `x-nosdr-role`, `x-nosdr-instance`, `x-nosdr-dongle`.
5. `env.FANOUT.get(env.FANOUT.idFromName(`${instance}:${dongle}`)).fetch(request)`.
6. `/health` returns `{ ok, version, maxViewers }`; `/stats` forwards to the DO.
7. CORS only for `/health` and `/stats`, origin from `ALLOWED_ORIGIN` (default `*` for v1 health; tighten for stats).

Do not expose the token or internal headers to the browser.

### 6.3 Durable Object (`fanout.ts`)

Fields:

```ts
private ring: Uint8Array[] = [];     // decimated history frames
private ringHead = 0;
private ringCount = 0;
private historyBins = 2048;
private historyFrames = 512;
private lastFrameAt = 0;
private framesIn = 0;
private framesOut = 0;
private dropped = 0;
private maxViewers = 200;
private historyMode: 'do-ring' | 'origin-snapshot' | 'off' = 'do-ring';
private lastSnapshot: ArrayBuffer | null = null;
```

`fetch(request)`:

- Read role/instance/dongle from trusted headers.
- Viewer cap check: `getWebSockets('viewer').length >= maxViewers` → 503.
- `WebSocketPair`; `ctx.acceptWebSocket(server, [role])`; `serializeAttachment({ role })`.
- Ingest: close any existing `ingest` socket with 1012 ("replaced"); reset `lastFrameAt`; store hello config (clamped).
- Viewer: if `historyMode === 'origin-snapshot'` and `lastSnapshot`, send it; else if `do-ring` and ringCount > 0, build and send `0x0D`.
- Return 101 with the client socket.

`webSocketMessage(ws, msg)`:

- Viewer sockets: accept only text `ping`/`status`; ignore binary (receive-only).
- Ingest sockets:
  - text: `hello` → clamp `maxViewers` (1–1000), `history.bins` (256–8192, power of two), `history.frames` (32–2048), `history.mode`; `ping` → reply `pong`.
  - binary `0x0B`: `lastFrameAt = Date.now(); framesIn++`; if `do-ring`, decode/decimate/push; if `origin-snapshot`, ignore (snapshot comes separately); broadcast verbatim to `getWebSockets('viewer')` with try/catch and close-on-error.
  - binary `0x0D`: cache `msg` as `lastSnapshot`; do not broadcast.
  - binary `0x10`: decode with `decodeRangeFrame`, max-hold to ring, broadcast verbatim.

`webSocketClose`:

- Reply to close per hibernation rules.
- Ingest: clear state; log.
- Viewer: no action; runtime cleans up.

`alarm()` (optional v1.1): if `Date.now() - lastFrameAt > 15_000`, close viewers with 1011 or send a text `{"type":"edge_stale"}`. The client's stale timer already covers this; the alarm is a server-side guard.

`/stats` response:

```json
{
  "viewers": 12,
  "ringFrames": 512,
  "ringBins": 2048,
  "lastFrameAgeMs": 41,
  "framesIn": 12345,
  "framesOut": 148140,
  "dropped": 0,
  "historyMode": "do-ring"
}
```

### 6.4 `history.ts`

Pure functions, unit-testable:

```ts
export function decodeDeflateSmooth(frame: ArrayBuffer): Uint8Array;
export function decimateMaxHold(src: Uint8Array, outBins: number): Uint8Array;
export function packHistory(frames: Uint8Array[], bins: number,
                            minDb: number, maxDb: number): ArrayBuffer;
```

`decodeDeflateSmooth` handles the 0x0B body:

```
[i16 min][i16 max][u32 bins][deflate(delta(u8))]
```

Use `fflate.inflateSync`; forward cumulative sum. Reject `binCount` outside 256–131072 and payloads over 1 MiB to avoid memory abuse.

`packRangeFrameHistory` uses `frameCount <= 65535`, codec 4, oldest-first, with a `u32` length before each payload.

### 6.5 Limits and safety

- Max message size: 1 MiB ingest, 32 MiB runtime limit is far above our 13 kB frames.
- Max viewers per DO: from hello/env, default 200; test 50/100.
- Max ingest frames: one socket; replace on reconnect.
- No storage writes in v1 (free-tier rows stay at 0).
- `try/catch` every `send`; a failed viewer is closed.
- No backpressure API exists; viewer cap + close-on-error is the mitigation.

---

## 7. Rust origin implementation

### 7.1 Config (`serverrs/src/config.rs`)

Add to `Config`:

```rust
#[serde(default)]
pub edge: EdgeConfig,
```

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeConfig {
    #[serde(default)] pub enabled: bool,
    #[serde(default)] pub url: String,              // wss://fft.example.com
    #[serde(default)] pub instance_id: String,
    #[serde(default)] pub ingest_token: String,     // secret, masked in JSON
    #[serde(default)] pub codec: String,            // "range"
    #[serde(default)] pub dongles: Vec<String>,     // empty = all
    #[serde(default)] pub max_viewers: i32,
    #[serde(default)] pub client_default_transport: String, // auto|origin|edge
    #[serde(default)] pub fallback: EdgeFallbackConfig,
    #[serde(default)] pub history: EdgeHistoryConfig,
    #[serde(default)] pub reconnect: EdgeReconnectConfig,
}
```

Defaults: `codec = "range"`, `max_viewers = 200`, `client_default_transport = "auto"`, fallback `{2500, 3000, 5000, 30000}`, history `{mode:"do-ring", bins:2048, frames:512}`, reconnect `{500, 30000}`.

Validation (in `config::validate`):

- `url` must start `wss://` (allow `ws://` only for localhost/dev, with a warning).
- `instance_id` matches `^[A-Za-z0-9_-]{1,64}$`.
- `ingest_token` non-empty when `enabled`.
- `codec` in `["range", "deflate-smooth"]`; both are decoded by the DO.
- `history.bins` power of two 256–8192; `frames` 32–2048; `mode` enum.
- `client_default_transport` enum; timeouts 500–30000 ms.
- `dongles` entries must exist; warn on missing at load, skip at start.

### 7.2 `EdgeService` (`serverrs/src/edge/mod.rs`)

```rust
pub struct EdgeService {
    cfg: Arc<RwLock<EdgeConfig>>,
    publishers: Mutex<HashMap<String, PublisherHandle>>,
    metrics: EdgeMetrics,
}
```

- `start(manager: Weak<Manager>)` spawns one task per configured dongle.
- `reload(new_cfg)` diffs dongles, starts/stops publishers, updates codec/history.
- `publish(dongle: &str, frame: Arc<Vec<u8>>)` sends the latest frame to the publisher.
- `status() -> serde_json::Value` reads atomics: connected, frames_sent, dropped, reconnects, last_error, last_frame_at.

### 7.3 Publisher (`serverrs/src/edge/publisher.rs`)

- `tokio_tungstenite::connect_async` with `Authorization: Bearer`.
- Use `watch::channel<Option<Arc<Vec<u8>>>>` for latest-frame semantics. The publisher loop:
  - `changed().await`, take latest, `send(Binary)`.
  - If the socket is slow, only the newest frame is retained; no unbounded queue.
- Text `hello` immediately after connect; `ping` every 10 s.
- Read loop handles `status`/`pong`; logs unexpected text.
- Reconnect with jittered exponential backoff (`reconnect.min_ms` to `max_ms`).
- On close/error, mark disconnected; retry.
- Never block the dongle loop: `publish` is non-blocking.

### 7.4 Manager hook (`dongle/manager.rs`)

In `broadcast_fft_frame`:

1. Remove the early return when `clients.is_empty()` **only if** edge is enabled for this dongle.
2. Compute the local client codec cache as today.
3. Ensure the edge codec frame is encoded:
   - If a local client uses the same codec, reuse the cached `Vec<u8>`.
   - Else encode once with the edge codec and cache it.
4. Call `self.edge.publish(&ad.id, Arc::new(edge_bytes))` when enabled.
5. Send origin FFT only to clients whose `fft_transport == origin` (default is off).

This keeps one encode per codec per frame. With `range` enforced for the edge, worst case is one extra encode per frame at 12 fps.

### 7.5 Client transport flag

`ws/protocol.rs` `ClientCommand`:

```rust
#[serde(default, skip_serializing_if = "String::is_empty")]
pub fft_transport: String,
```

`ws/client.rs`:

- Add `fft_transport: u8` (`0=off`, `1=origin`, `2=edge`), default 0.
- `set_fft_transport`, `fft_transport`, `wants_origin_fft`.
- `drop_queued_fft` when switching either direction.

`handle_command` in `dongle/manager.rs`:

```rust
"fft_transport" => self.handle_fft_transport(client_id, cmd),
```

- `edge`: set flag, `drop_queued_fft`.
- `origin`: set flag, `drop_queued_fft`.

### 7.6 Main and lib

- `lib.rs`: `pub mod edge;`
- `main.rs`: after `Manager::new`, create `EdgeService::new(cfg.clone(), ws.clone())`, `mgr.set_edge(edge.clone())`, `edge.start()`, and register shutdown.
- `manager.notify_config_saved()` triggers `edge.reload()` via the existing config-save path (or admin handler calls it directly).

### 7.7 Public info and metrics

- `api/router.rs` public config: add
  ```json
  "edge": {
    "enabled": true,
    "url": "wss://fft.example.com",
    "instanceId": "home-berlin",
    "codec": "range",
    "defaultTransport": "auto",
    "historyBins": 2048
  }
  ```
  No token.
- Welcome META: add the same optional `edge` object so the client can enable without a second fetch. Keep it optional for wire compatibility.
- `server_stats` (2 s): add `edgeConnected`, `edgeFramesSent`, `edgeDropped` (optional; admin monitor can use `/api/admin/edge/status`).

---

## 8. Admin API and UI

### 8.1 API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/edge` | Config (token masked as `hasIngestToken`) + local status |
| PUT | `/api/admin/edge` | Update config, persist YAML, reload publishers |
| POST | `/api/admin/edge/test` | Probe `<url>/health` and optionally the ingest upgrade |
| GET | `/api/admin/edge/status` | Local metrics + DO `/stats` (proxied server-side) |

`GET` response fields:

```json
{
  "enabled": false,
  "url": "wss://fft.example.com",
  "instanceId": "home-berlin",
  "hasIngestToken": true,
  "codec": "range",
  "dongles": [],
  "maxViewers": 200,
  "clientDefaultTransport": "auto",
  "fallback": { "connectTimeoutMs": 2500, "firstFrameTimeoutMs": 3000,
                "staleTimeoutMs": 5000, "retryMs": 30000 },
  "history": { "mode": "do-ring", "bins": 2048, "frames": 512 },
  "status": { "connected": false, "lastError": "", "framesSent": 0,
              "framesDropped": 0, "reconnects": 0, "lastFrameAt": 0 },
  "version": 42
}
```

`PUT` semantics: partial update; omitted `ingestToken` keeps the existing token; empty string clears it. On success, bump `ConfigVersion`, write YAML, call `edge.reload()`, and broadcast `config_saved`.

`POST /test`: server-side, never exposes the token:

- `GET <https-url>/health` with 3 s timeout → `{ok, latencyMs, workerVersion}`.
- Optionally open the ingest WS with `hello` and wait for `welcome` for 5 s.
- Return a structured error on TLS/auth/route failures.

`GET /status`: merge local publisher atomics with a server-side fetch of `<https-url>/stats/<instance>/<dongle>` for each configured dongle; include `viewers`, `lastFrameAgeMs`, `ringFrames`, `historyMode`.

### 8.2 Admin store (`client/src/admin/admin-store.ts`)

- Extend `AdminSection` with `'edge'`.
- Add `EdgeConfig` interface matching the API, `DEFAULT_EDGE_CONFIG`.
- `loadEdgeConfig()` called from `loadServerConfig()` or `loadAll()`; `saveEdgeConfig(partial)` called from `saveConfig()`.
- `updateEdgeField(field, value)` marks dirty.
- `testEdge()` → POST; store `edgeTestResult` signal.
- `fetchEdgeStatus()` → GET; poll every 3 s while the section is active and authenticated.
- Token: keep `ingestToken` only in local component state; never round-trip the masked value. `hasIngestToken` drives the placeholder.

### 8.3 UI (`EdgeSection.tsx`)

Add nav item after **SDR Devices**:

```ts
{ id: 'edge', label: 'Cloudflare Edge', icon: '...' }
```

Sections and fields:

| Group | Field | Control | Notes |
|---|---|---|---|
| Status | State | Badge | Disabled / Connecting / Live / Degraded / Error |
| | Edge URL | text (read-only) | From config |
| | Viewers | read-only | From `/status` |
| | Last frame | read-only | `lastFrameAgeMs` |
| | Frames sent / dropped | read-only | Local metrics |
| | Error | read-only | Last publisher/Worker error |
| Connection | Enable edge fan-out | toggle | Off by default |
| | Edge URL | text | `wss://...`; validation |
| | Instance ID | text | `home-berlin` |
| | Ingest token | password | Write-only; placeholder when configured |
| | Test connection | button | Latency + worker version |
| Stream | Edge codec | select | `range` (default) or `deflate-smooth` |
| | Dongles | multi-select | Empty = all; list from `/api/admin/dongles` |
| | Max viewers per DO | number | 50–1000; default 200 |
| History | Mode | select | `do-ring` / `off` |
| | History bins | select | 1024/2048/4096 |
| | History frames | number | 32–2048 |
| | Estimated memory | read-only | `bins × frames` |
| | Estimated span | read-only | `frames / fps` seconds |
| Client fallback | Default transport | select | `auto` / `origin` / `edge` |
| | Connect timeout | number | ms |
| | First-frame timeout | number | ms |
| | Stale timeout | number | ms |
| | Retry interval | number | ms |
| Safety | Free-tier note | callout | 1 DO, 12 fps, 51.8k req/day, 10.8k GB-s/day |
| | Disable edge | action | Sets `enabled=false` and saves |

Validation mirrors the server: URL scheme, instance regex, token required when enabling, bins power of two, frames bounds, timeouts bounds. Save is disabled or shows inline errors when invalid.

Use the existing form primitives (`SettingsGroup`, `FieldRow`, `Toggle`, `TextInput`, `NumberInput`, `SelectInput`, `PasswordInput`) to match the design system.

### 8.4 Client-facing config

- The welcome META (and `/api/server`) includes `edge: { enabled, url, instanceId, codec, defaultTransport, historyBins }`.
- The client store adds `edgeInfo`, `edgeStatus`, `edgeLastError`, `fftSource`.
- A small badge in the control panel shows `Edge` / `Origin` / `Edge retry`; clicking opens a tooltip with the last error and a retry action.
- The client settings include a transport override (`auto` / `origin` / `edge`) persisted locally; the server default applies on first run.

---

## 9. YAML example

```yaml
edge:
  enabled: false
  url: wss://fft.example.com
  instanceId: home-berlin
  ingestToken: ''
  codec: range
  dongles: []
  maxViewers: 200
  clientDefaultTransport: auto
  fallback:
    connectTimeoutMs: 2500
    firstFrameTimeoutMs: 3000
    staleTimeoutMs: 5000
    retryMs: 30000
  history:
    mode: do-ring
    bins: 2048
    frames: 512
  reconnect:
    minMs: 500
    maxMs: 30000
```

`config/config.yaml` remains untouched until the operator enables it.

---

## 10. Testing and acceptance

### 10.1 Unit

- `protocol.test.ts`: parse 0x0B header; reject short/oversized frames; pack/unpack 0x0D.
- `history.test.ts`: delta decode, max-hold decimation, oldest-first ring, wrap-around, partial ring.
- `fanout.test.ts`: ingest auth (Worker), one-ingest replacement, viewer cap, binary broadcast, history on connect, no echo to ingest, send-failure cleanup.
- Rust: config validation, publisher latest-frame drop behavior, edge frame cache reuse, `fft_transport` skip/resume.

### 10.2 Integration

- `wrangler dev` + synthetic publisher sending real captured 0x10 range frames at 12 fps.
- 1, 10, 50, 100 viewer clients; assert byte-identical frames, p95 latency, DO CPU, memory, no drops at 50.
- Kill the Worker mid-stream: client falls back to origin within 3 s, audio/control uninterrupted, history repopulates.
- Kill the origin ingest: viewer stale timeout/fallback; origin reconnects with backoff.
- Quota/error: Worker returns 429/503; client falls back and does not hammer.
- History: 1 MB burst, frame count/bin count match, client decode time, no main-thread stall >50 ms.
- Admin: enable/test/save; publisher reloads without restart; token masked; invalid config rejected.

### 10.3 Acceptance criteria

- Edge live with 50 viewers: added p95 latency ≤50 ms; origin FFT bytes for edge clients = 0.
- Fallback ≤3 s; no duplicate FFT frames; waterfall recovers with history.
- Free-tier usage for 1 dongle @12 fps: ~51.8k req/day, ~10.8k GB-s/day, one DO.
- History burst ≤1.1 MB (2048×512), ≤2 MB even at 4096×512.
- No regression when `edge.enabled=false`: byte-identical origin behavior.
- Desktop/offline: no edge connections, no new startup errors.

### 10.4 Phase 0 measurements (gate)

1. Real range frame size p50/p95 at 32K/12fps.
2. Free-tier raw-vs-billed 20:1 behavior; check dashboard vs formula.
3. DO CPU per message at 0/50/100 viewers, with and without history decode.
4. DO egress/latency at 50/100 viewers; single-region RTT.
5. History decode CPU and connect-time client decode.

If any gate fails: lower `maxViewers`, set history to `off`, or move to the paid $5 plan.

---

## 11. Rollout and rollback

1. Deploy `cloudflare/` with `INGEST_TOKEN`; verify `/health`.
2. Configure a dev origin with `edge.enabled=true`, `clientDefaultTransport=origin`; confirm publisher connects and `/stats` shows frames.
3. Enable client `auto` for internal testers; verify edge live + fallback.
4. Set `clientDefaultTransport=auto` publicly only after the Phase 0 gate passes.
5. Monitor: Cloudflare DO requests/duration/errors, `wrangler tail`, origin `edge_*` metrics, client `Edge retry` rate.

Rollback: set `edge.enabled=false` in admin (or YAML) and save. Clients fall back on the next edge failure; for immediate effect, the client can send `fft_transport=origin` on reconnect. The Worker can stay deployed; no origin code change is required to disable.

---

## 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Free-tier quota counts raw messages, not 20:1 | Measure first; if raw, use paid $5 plan or batch frames |
| 10 ms CPU per message too tight at 100 viewers | Cap viewers, measure; batch frames (2–3 per message) as a lever |
| 40 TB/month egress at 100 viewers | Cap at ~30–50 viewers/DO; shard by region later; monitor fair use |
| DO single-region RTT | One region for v1; add `:region` DOs + per-region ingest later |
| Hibernation loses ring | Refill; optional SQLite snapshot every 10 s |
| Range decoder CPU too high in the DO | Fall back to `deflate-smooth`; both codecs share the same history path |
| 0x10 is FFT_RANGE | DO decodes it and re-encodes history as 0x0D codec 4 (per-frame range) |
| Duplicate FFT during switch | Source-gated `handleBinaryMessage`; `fft_transport` command |
| Token in YAML | Mask in API, omit from public info, file permissions, rotate |
| Admin save breaks live publisher | `reload()` diffs and restarts only affected publishers |
| Worker outage | Client falls back; origin unchanged |

---

## 13. Implementation phases

### P0 — Spike (1–2 days)
- `cloudflare/` skeleton: Worker routes, auth, DO broadcast, `/health`, `/stats`.
- Synthetic publisher (Node/Rust) replaying captured 32K/12fps frames.
- Measure the Phase 0 gates; record numbers in `cloudflare/README.md`.

### P1 — DO history + hardening
- `history.ts` decode/decimate/pack; ring; viewer cap; stale guards.
- Unit tests + `wrangler dev` integration; 50/100 viewer latency run.

### P2 — Rust origin
- `EdgeConfig` + validation; `serverrs/src/edge/{mod,publisher}.rs`; manager hook; `fft_transport` command; admin API; public info.
- `cargo test`; run against `wrangler dev`.

### P3 — Client transport + fallback
- `edge-spectrum.ts`; `sdr-engine` source gating; history handling; status badge; local override; tests for fallback/recovery.

### P4 — Admin UI
- `EdgeSection.tsx`; `admin-store` fields/load/save/test/status; nav; validation; token masking; docs.

### P5 — Rollout
- Load test, free-tier validation, docs, enable for one dongle, monitor.

---

## 14. Open questions

1. Viewer auth: public read forever, or signed short-lived tokens per site?
2. Regional DOs in v1.1, or only after measured RTT/egress pain?
3. Batch 2–3 frames per WS message to cut request billing, accepting +83–167 ms latency?
4. Does the JS range decoder stay inside the free-tier 10 ms budget at 32K/12fps?
5. Demand-gated push (pause/resume when viewers = 0) to cut idle DO duration?
6. Persist the history ring to SQLite for hibernation, or accept a cold prefill after idle?
