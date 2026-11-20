# nosdr-edge — Cloudflare Durable Object fan-out

One Worker + one Durable Object per dongle. The origin (`serverrs`) pushes
already-encoded FFT frames over a single authenticated WebSocket; the DO fans
them out to browsers and keeps a small history ring.

This is the P0 implementation of [`../cf-do-fan-out.md`](../cf-do-fan-out.md).

## Routes

| Route | Auth | Purpose |
|---|---|---|
| `wss://<edge>/ingest/<instance>/<dongle>` | `Authorization: Bearer <INGEST_TOKEN>` | origin ingest |
| `wss://<edge>/v1/<instance>/<dongle>/fft?history=1` | public | browser FFT; `history=1` requests the DO history burst |
| `https://<edge>/health` | public | liveness/version |
| `https://<edge>/stats/<instance>/<dongle>` | bearer | DO stats for the origin admin API |

## Wire contract

- Live frames are the existing `0x10` (range) messages, byte-for-byte.
- `0x0B` (deflate-smooth) is accepted as a fallback codec.
- History is only sent when the viewer connects with `?history=1`; live-only
  edge clients can omit it. It is the existing `0x0D` message with codec `4`
  (per-frame range-coded), built by the DO from a 2048-bin × 512-frame ring.
- The DO range-encodes each decimated history frame as it arrives
  (`encodeRangeFrame`); on connect it concatenates them with a `u32` length
  prefix. The client decodes each frame with `decodeRangeHistory(payload, 1,
  bins)`.
- The DO decodes `0x10` with a TypeScript port of `serverrs/src/codec/range.rs`
  (`src/range.ts`); the browser already decodes it in `fft-decode.worker.ts`.
- No new public message types.

## Local development

Requires Node.js 22.12+ for Wrangler (the Worker itself has no Node runtime
dependency).

```sh
cd cloudflare
npm install
npx wrangler dev --local --port 8787
```

Set a local token in `.dev.vars`:

```sh
INGEST_TOKEN=dev-token
```

Then point `serverrs` at `ws://127.0.0.1:8787` with that token.

With the local server running, a full ingest → history → live smoke test is:

```sh
npm run smoke
```

`test/smoke.mjs` connects an ingest socket with `EDGE_TOKEN` (default
`dev-token`), sends a 256-bin range-coded frame, connects a viewer, and
asserts that history (`0x0D`) and live (`0x10`) frames arrive. Override
`EDGE_BASE`/`EDGE_TOKEN` for another host.

## Deploy

```sh
cd cloudflare
npm install
npx wrangler login
npx wrangler secret put INGEST_TOKEN
npx wrangler deploy
```

Add a custom domain/route (`fft.example.com/*`) in `wrangler.jsonc` or the
dashboard. The free plan is sufficient for one dongle at 12 fps; see the plan
for the quota math and the `range` codec caveat.

## Tests

```sh
npm test
npm run typecheck
```

The unit tests cover the range decoder (against a Rust-generated fixture),
max-hold decimation, ring wrap-around, history packing, and malformed frames.
Load/latency tests are in the plan (`cf-do-fan-out.md`) and need a real
deployment plus a synthetic publisher.
