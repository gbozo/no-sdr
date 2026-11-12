# Background decoders

The server runs digital-mode decoders as **background tasks**, independent of
connected clients. This is the OpenWebRX model: a decoder is configured once
for a dongle and a frequency, and runs continuously while that dongle is
streaming. Results are pushed to every client subscribed to the dongle as
`MSG_DECODER` (`0x06`) JSON.

Two execution modes share the same decoder implementations:

- **Background** — configured per dongle and frequency, runs regardless of
  clients, broadcasts results to dongle subscribers.
- **Foreground** — starts for one client when it sends
  `{"cmd":"decoder","mode":"ft8"}` (empty mode disables it). It decodes the
  client's current tune offset and sends results only to that client. The
  client still receives its normal IQ/audio stream.

The first implementation is the WSJT slotted family: **FT8**, **FT4** and
**FT2**. FT8/FT4 use `mfsk-core` (GPL-3.0-only, compatible with this project's
GPL-3.0-or-later licensing); FT2 uses the FT4 stages from `mfsk-core` with the
FT2 protocol constants adapted from `sdroxide-digi`. The channelizer and worker are mode-generic, so FT2, WSPR, JT65/JT9,
FST4/Q65, MSK144/FSK441 and JS8 can be added without changing the transport.

## Configuration

Add a top-level `decoders:` list to `config/config.yaml`:

```yaml
decoders:
  - id: ft8-20m
    enabled: true
    dongleId: dongle-mooroo30
    mode: ft8
    frequencyHz: 14074000
    bandwidthHz: 3000

  - id: ft4-20m
    enabled: false
    dongleId: dongle-mooroo30
    mode: ft4
    frequencyHz: 14080000
    bandwidthHz: 3000
```

`frequencyHz` is absolute RF, not an offset from the current profile. The
decoder worker checks it against the dongle's current span; a frequency outside
the span is logged and the channel stays idle until the profile moves over it.

The admin panel does not edit decoder definitions yet. The config is preserved
verbatim by the server's YAML round-trip.

## Pipeline

```
Dongle raw Cu8 IQ
  └─ DecoderManager (one worker per dongle)
       └─ per-decoder IqExtractor (NCO + Butterworth + decimate)
            └─ USB demodulator → 12 kHz audio → UTC slot buffer
                 └─ mfsk-core AnyDecoder (FT8/FT4) or FT2 decoder
                      └─ MSG_DECODER → all clients subscribed to that dongle
```

- `serverrs/src/decoders/mod.rs` owns the workers, channel extractors, slot
  buffers and result transport.
- `serverrs/src/decoders/ft2/` carries the FT2 protocol/decode stages adapted
  from `sdroxide-digi`.
- `serverrs/src/dongle/manager.rs` feeds each raw chunk to the decoder manager
  after the profile IQ swap and before the FFT/client pipelines.
- `mfsk-core` supplies the FT8/FT4 decoders and message unpacking; the channel
  extractor is the server's existing `IqExtractor`. Both are pure Rust.
- The decoder thread is separate from the dongle read loop; a deep decode
  cannot stall WebSocket/FFT delivery.
- Slots are cut on the wall-clock 3.75/7.5/15 s boundaries; the resampler
  brings the extractor's rounded output rate back to exactly 12 kHz.

## Database

Both foreground and background results are written to SQLite:

```yaml
database:
  # Empty = decoders.sqlite beside config.yaml
  decoderPath: ''
  # 0 = no automatic retention
  retentionDays: 7
```

Schema:

- `decoder_messages` — one row per decode, with decoder id, dongle, mode,
  receive time, text, RF/audio frequency, SNR, DT, period and the original
  JSON payload.
- Indexes on `(mode, received_ms)` and `received_ms`.
- `decoder_entities` is reserved for keyed data (aircraft, vessels, stations).

Read API:

```text
GET /api/decoder/messages?mode=ft8&since=<unix_ms>&limit=200
GET /api/decoder/stats
```

The client panel currently shows the foreground decoder table; map/entity
panels can use the same stored data later.

## Decoder message shape

```json
{
  "decoderType": "ft8",
  "data": {
    "id": "ft8-20m",
    "mode": "ft8",
    "text": "CQ N0CALL",
    "audioHz": 1500.0,
    "rfHz": 14074195.0,
    "snrDb": -12.3,
    "dtSec": 0.2,
    "period": 123456,
    "utcNs": 1760000000000000000,
    "dialHz": 14074000
  }
}
```

The client already dispatches `MSG_DECODER` to
`SdrEngine.onDecoderData(type, data)`. A later UI pass can bind that callback
to per-mode panels: a decode table for FT8, a map/table for ADS-B, an image
view for SSTV/weather fax, and so on.

## Roadmap

1. FT8/FT4 background decoders and result transport. *(implemented)*
2. FT2 on top of mfsk-core's FT4 stages. *(implemented)*
3. VDL2, ACARS, HFDL, AIS, APRS, ISM, AX.25 packet and NAVTEX: continuous or
   burst receivers, each with its own channel kind.
4. Weather fax, SSTV, Hellschreiber: image/audio decoders with dedicated panels.
5. Olivia/THOR/FSQ, PSK31/RTTY, MSK144/FSK441, FST4/Q65, JT65/JT9, WSPR/PI4,
   FreeDV RADE, JS8.

The UI should be data-driven by decoder type; ADSB and AIS want maps, FT8 and
APRS want tables/logs, SSTV/WEFAX want image views.
