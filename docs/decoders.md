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

**ADS-B / Mode S** is the first raw-IQ decoder. It runs off the dongle's raw
Cu8 stream at 1090 MHz and bypasses the 12 kHz audio channeliser entirely; see
[ADS-B](#ads-b--mode-s) below.

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

  # Raw IQ at 1090 MHz: the profile must be 2.4 MSPS for full sensitivity.
  - id: adsb-local
    enabled: false
    dongleId: dongle-mooroo30
    mode: adsb
    frequencyHz: 1090000000
    bandwidthHz: 2400000
    settings:
      dropMapS: 10        # position age before a target leaves the map
      dropListS: 60       # silence before a target leaves the table
      historyPoints: 40   # track points kept per aircraft
      maxAircraft: 300

  # VHF aircraft datalink: AM, 2400 baud, a ~6 kHz channel.
  - id: acars-131
    enabled: false
    dongleId: dongle-mooroo30
    mode: acars
    frequencyHz: 131550000
    bandwidthHz: 6000
```

`frequencyHz` is absolute RF, not an offset from the current profile. The
decoder worker checks it against the dongle's current span; a frequency outside
the span is logged and the channel stays idle until the profile moves over it.
ADS-B additionally requires the whole window to cover 1090 MHz and be at least
2 MSPS wide; otherwise it sends an `unavailable` snapshot explaining the fix
rather than an empty aircraft table. Between 2.0 and 2.4 MSPS it runs with a
`degraded` warning.

The admin panel does not edit decoder definitions yet. The config is preserved
verbatim by the server's YAML round-trip.

## Pipeline

```
Dongle raw Cu8 IQ
  ├─ DecoderManager (one worker per dongle)
  │    └─ per-decoder IqExtractor (NCO + Butterworth + decimate)
  │         └─ USB demodulator → 12 kHz audio → UTC slot buffer
  │              └─ mfsk-core AnyDecoder (FT8/FT4) or FT2 decoder
  │                   └─ MSG_DECODER → all clients subscribed to that dongle
  └─ ADS-B channel (mode: adsb)
       └─ Cu8 → Complex32 → sdroxide-adsb AdsbController
            └─ aircraft table snapshot → MSG_DECODER every ~500 ms
```

- `serverrs/src/decoders/mod.rs` owns the workers, channel extractors, slot
  buffers and result transport.
- `serverrs/src/decoders/adsb.rs` owns the raw-IQ ADS-B channel. It converts
  cu8 to `Complex32`, feeds the controller, and turns each status snapshot into
  the `MSG_DECODER` payload.
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
- `decoder_entities` — keyed state for tables that re-send the same object.
  ADS-B uses `kind = 'aircraft'`, `entity_key = <ICAO hex>`, with the full
  aircraft row in `payload` and first/last seen timestamps. Snapshots upsert
  here; they are never appended to `decoder_messages`.

Read API:

```text
GET /api/decoder/messages?mode=ft8&since=<unix_ms>&limit=200
GET /api/decoder/stats
GET /api/decoder/aircraft?limit=500
```

The client decoder workspace switches on decoder type: FT8/FT4/FT2 keep the
decode table plus zoomed waterfall, ADS-B shows an aircraft table plus a
Leaflet OpenStreetMap view.

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

## ADS-B / Mode S

ADS-B is a pure-Rust decoder (`sdroxide-adsb`, Cargo feature `adsb`, on by
default). It does **not** use `IqExtractor`/`SsbDemod`: Mode S is a 1 Mbit/s
pulse-position waveform and needs samples, not an audio passband.

Requirements:

- The dongle window must contain 1090 MHz (`window_covers`).
- At least 2.0 MSPS, or nothing can be sliced.
- 2.4 MSPS or more for full sensitivity. At 2.0 MSPS a Mode S chip and a sample
  are the same width, so only strong aircraft decode. The server reports this
  as `degraded`.

Foreground and background both work. Foreground:
`{"cmd":"decoder","mode":"adsb"}` uses the raw dongle chunk and sends snapshots
only to that client. Background uses `mode: adsb` in `decoders:`.

Snapshot shape (one message every ~500 ms; the whole table every time):

```json
{
  "decoderType": "adsb",
  "data": {
    "aircraft": [
      {
        "icao": 4221421,
        "callsign": "BAW123",
        "category": "heavy",
        "lat": 51.47, "lon": -0.45,
        "track": [[51.46, -0.44], [51.47, -0.45]],
        "altitude_ft": 38000,
        "gnss_altitude_ft": 38200,
        "ground_speed_kt": 462.0,
        "track_deg": 271.4,
        "vertical_rate_fpm": 0,
        "turn_rate_deg_s": 0.0,
        "on_ground": false,
        "squawk": 7042,
        "emergency": null,
        "rssi_dbfs": -18.2,
        "frames": 214,
        "source": "Squitter",
        "first_at": 1760000000,
        "last_at": 1760000345,
        "last_pos_at": 1760000344,
        "raw_hex": "8D40621D58C382D690C8AC2863A7"
      }
    ],
    "unavailable": null,
    "degraded": null,
    "suggestCenterHz": null,
    "windowCenterHz": 1090000000,
    "windowRateHz": 2400000,
    "preambles": 1520,
    "frames": 344,
    "repaired": 12,
    "badCrc": 18,
    "unmatched": 4
  }
}
```

`repaired` counts frames recovered by the one-bit CRC repair pass. DF17/18
frames that are exactly one bit away from a valid 24-bit CRC are accepted, for
new addresses as well as known ones; two-bit errors are refused. This is the
same weak-frame recovery dump1090/readsb perform, but it can manufacture a
one-message phantom track in a very noisy band — watch `REP` against `FRM` if
the aircraft list looks suspicious.
`unavailable` is a sentence the operator can act on (wrong band or too narrow);
`degraded` says the decoder runs but misses weak aircraft. `suggestCenterHz` is
1090 MHz when the dial is wrong. The UI shows these above the table instead of
an unexplained empty list.

Client:

- `client/src/store/index.ts` holds `adsbAircraft` / `adsbStatus` and applies
  one snapshot at a time.
- `client/src/components/AdsbDisplay.tsx` is the table, sorting, selection and
  diagnostics.
- `client/src/components/AdsbMap.tsx` creates one Leaflet map (OSM tiles) and
  updates markers/tracks in place. Marker glyphs rotate with `track_deg`;
  selection pans and draws the leader vector; “Fit” frames all positions.
- No map API key is used. Attribution stays visible.

## ACARS / ARINC 618

ACARS is a VHF airband datalink: an amplitude-modulated 2400-baud MSK signal
(1200/2400 Hz tones) carrying 7-bit ASCII blocks with odd parity. It is not a
raw-IQ mode and does not need the ADS-B window. The channel path is:

```
Dongle IQ → IqExtractor (tune + decimate to ~12 kHz, 6 kHz bandwidth)
          → AmDemod (envelope)
          → LinearResampler to exactly 12 kHz
          → SDROXIDE ACARS receiver (bit clock + frame parse/BSC)
          → MSG_DECODER events
```

The receiver is adapted from `sdroxide-dsp`'s ACARS implementation (itself
ported from acarsdec, GPL-compatible). `serverrs/src/decoders/acars.rs` holds
the protocol; `acars_channel.rs` holds the IQ/audio plumbing.

Typical channels: **131.550 MHz**, **131.725 MHz**, some regions also 131.825.
Tune the dongle in AM at least 2 MSPS wide and place the decoder dial on the
channel.

Both execution modes work: foreground `{"cmd":"decoder","mode":"acars"}`, or
background `mode: acars` in `decoders:`. The foreground decoder follows the
client's tune offset; the background decoder uses `frequencyHz`.

Events are sent as `decoderType: "acars"`:

```json
{"kind":"message","text":"...","rfHz":131550000,"acars":{
  "mode":"2","address":"G-EUUU","ack":"\u0015","label":"H1",
  "blockId":"1","text":"...","crcOk":true,"at":1760000000}}
{"kind":"status","frames":42,"bad":3,"level":0.07}
```

`status` is sent twice a second (receiver meter and counters); `message` is
sent once per accepted block. Message events carry the usual `text`/`rfHz`
fields so they persist in `decoder_messages` like FT8 results. The client
shows a rolling table with mode, address, label, block, text and CRC state.

## Roadmap

1. FT8/FT4 background decoders and result transport. *(implemented)*
2. FT2 on top of mfsk-core's FT4 stages. *(implemented)*
3. ADS-B raw-IQ decoder, foreground/background, aircraft table + OSM map.
   *(implemented)*
4. ACARS / ARINC 618 VHF datalink, foreground/background, message table.
   *(implemented)*
5. VDL2, HFDL, AIS, APRS, ISM, AX.25 packet and NAVTEX: continuous or burst
   receivers, each with its own channel kind.
6. Weather fax, SSTV, Hellschreiber: image/audio decoders with dedicated panels.
7. Olivia/THOR/FSQ, PSK31/RTTY, MSK144/FSK441, FST4/Q65, JT65/JT9, WSPR/PI4,
   FreeDV RADE, JS8.

The UI should be data-driven by decoder type; ADSB and AIS want maps, FT8 and
APRS want tables/logs, SSTV/WEFAX want image views.
