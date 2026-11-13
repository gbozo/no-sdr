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
FST4/Q65, MSK144/FSK441 and JS8 use the same transport; FST4/Q65 and
MSK144/FSK441 are already wired.

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

  # Marine AIS: both 25 kHz channels, dial between them at 162.000 MHz.
  - id: ais-162
    enabled: false
    dongleId: dongle-mooroo30
    mode: ais
    frequencyHz: 162000000
    bandwidthHz: 25000

  # VHF VDL Mode 2: fourteen 25 kHz channels, dial 136.8125 MHz.
  - id: vdl2-136
    enabled: false
    dongleId: dongle-mooroo30
    mode: vdl2
    frequencyHz: 136812500
    bandwidthHz: 25000

  # HFDL: 24 kHz lane on an assigned HF channel.
  - id: hfdl-21931
    enabled: false
    dongleId: dongle-mooroo30
    mode: hfdl
    frequencyHz: 21931000
    bandwidthHz: 24000

  # APRS: 1200 baud Bell 202 on the regional VHF channel.
  - id: aprs-144390
    enabled: false
    dongleId: dongle-mooroo30
    mode: aprs
    frequencyHz: 144390000
    bandwidthHz: 12500

  # NAVTEX: 518 kHz international, 490 kHz national, 4209.5 kHz tropical.
  - id: navtex-518
    enabled: false
    dongleId: dongle-mooroo30
    mode: navtex
    frequencyHz: 518000
    bandwidthHz: 3000

  # ISM: 868 MHz sensors, meters and home automation. Needs a wide window.
  - id: ism-868
    enabled: false
    dongleId: dongle-mooroo30
    mode: ism
    frequencyHz: 868950000
    bandwidthHz: 1500000
    settings:
      thresholdDb: 12
      maxDevices: 200

  # AX.25 packet: 1200 baud Bell 202 on a VHF packet channel.
  - id: packet-145010
    enabled: false
    dongleId: dongle-mooroo30
    mode: packet
    frequencyHz: 145010000
    bandwidthHz: 12500
    settings:
      baud: 1200          # or 9600 for G3RUH

  # Weather fax: HF radiofax chart, USB audio with 1900 Hz subcarrier.
  - id: wefax-7880
    enabled: false
    dongleId: dongle-mooroo30
    mode: wefax
    frequencyHz: 7880000
    bandwidthHz: 3000
    settings:
      ioc: i576           # i576 (1809 px/line) or i288 (904 px/line)
      lpm: 120
      autoStart: true

  # SSTV: slow-scan television, auto-detects the VIS mode.
  - id: sstv-14230
    enabled: false
    dongleId: dongle-mooroo30
    mode: sstv
    frequencyHz: 14230000
    bandwidthHz: 3000
    settings:
      mode: auto          # or a specific SstvMode label, e.g. Martin 1
      autoStop: true
      slantPpm: 0
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
  ├─ Raw-IQ channels (modes: adsb, ais, vdl2)
  │    └─ Cu8 → Complex32 → sdroxide controller
  │         └─ table/log/status snapshot → MSG_DECODER
  ├─ HFDL lane (mode: hfdl)
  │    └─ Cu8 → IqExtractor → 24 kHz complex lane → sdroxide-hfdl
  │         └─ event log + level/burst status → MSG_DECODER
  ├─ APRS audio channel (mode: aprs)
  │    └─ Cu8 → IqExtractor → NBFM discriminator → 48 kHz
  │         └─ Bell 202 AFSK → HDLC/AX.25 → sdroxide-aprs
  │              └─ packet event → MSG_DECODER
  ├─ NAVTEX audio channel (mode: navtex)
  │    └─ Cu8 → IqExtractor → USB demodulator → 12 kHz
  │         └─ SITOR-B / CCIR 476 receiver → ZCZC/NNNN framing
  │              └─ message + status events → MSG_DECODER
  ├─ WEFAX audio channel (mode: wefax)
  │    └─ Cu8 → IqExtractor → USB demodulator → 12 kHz
  │         └─ WefaxRx → start/phased/line/complete events
  │              └─ base64 grayscale rows + status → MSG_DECODER
  └─ SSTV audio channel (mode: sstv)
       └─ Cu8 → IqExtractor → USB demodulator → 12 kHz
            └─ SstvRx → VIS auto-detect → progressive RGB lines
                 └─ base64 RGB rows + status → MSG_DECODER
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

## AIS / Marine VHF

AIS is two 25 kHz GMSK channels at **161.975** (AIS 1) and **162.025** MHz
(AIS 2), 9600 baud. The dial belongs at **162.000 MHz** — neither channel
transmits there, so on a zero-IF front end neither lands in the DC spike. The
decoder is a raw-IQ lane like ADS-B (`sdroxide-ais`); it splits the window into
whichever channels it reaches itself.

Needs at least **48 kHz** of stream for one channel and **100 kHz** for both.
Between those it runs on one channel and reports `degraded`: ships alternate,
so every vessel is still seen at half its reporting rate. The controller emits
a whole vessel table twice a second.

The snapshot carries the table plus per-channel diagnostics:

```json
{
  "decoderType": "ais",
  "data": {
    "vessels": [ { "mmsi": 237123456, "name": "AGIOS NIKOLAOS",
                    "lat": 37.95, "lon": 23.64, "sog_kt": 8.4,
                    "cog_deg": 214, "heading_deg": 210, "destination": "PIRAEUS",
                    "kind": "ClassA", "nmea": "!AIVDM,...", "...": "..." } ],
    "channels": [
      { "freq_hz": 161975000, "label": "A", "live": true, "reason": null,
        "bursts": 201, "messages": 88, "floor_dbfs": -71.2 },
      { "freq_hz": 162025000, "label": "B", "live": true, "reason": null,
        "bursts": 190, "messages": 81, "floor_dbfs": -70.8 }
    ],
    "unavailable": null,
    "degraded": null,
    "suggestCenterHz": null,
    "windowCenterHz": 162000000,
    "windowRateHz": 2400000,
    "bursts": 391,
    "messages": 169,
    "badFcs": 3,
    "unsupported": 1,
    "samplesPerBit": 12.5,
    "offsetHz": -120.0
  }
}
```

`mmsi` is the stable key. Snapshots upsert into `decoder_entities` with
`kind = 'vessel'`; `GET /api/decoder/vessels` returns the persisted table.
The client shows a vessel table plus a Leaflet map with name, type, speed,
course/heading, destination/ETA, trail and a six-minute leader vector.

## VDL Mode 2

VDL2 is fourteen 25 kHz channels between **136.650 and 136.975 MHz**, carrying
ACARS over 10500-symbol/s D8PSK. The dial belongs at **136.8125 MHz**, the
centre of the plan. Like ADS-B/AIS this is a raw-IQ lane (`sdroxide-vdl2`); it
opens one down-converter per channel the window reaches.

Needs at least **34 kHz** for one channel and about **350 kHz** for the whole
plan; a 2.4 MSPS profile comfortably covers all fourteen. With a narrower
window it runs on the channels it can see and reports `degraded`.

The snapshot is a message log plus a station table, twice a second:

```json
{
  "decoderType": "vdl2",
  "data": {
    "channels": [ { "freq_hz": 136675000, "live": true, "reason": null,
                    "bursts": 40, "frames": 31, "floor_dbfs": -72.1 } ],
    "stations": [ { "addr": 4627761, "kind": "Aircraft", "registration": "OE-LWA",
                    "flight": "AUA123", "messages": 12, "last_snr_db": 18.4,
                    "last_label": "H1", "...": "..." } ],
    "messages": [ { "at": 1760000000, "freq_hz": 136675000,
                    "src": 4627761, "srcHex": "469C71",
                    "dst": 1141234, "dstHex": "1169F2",
                    "frameLabel": "I 3/2", "summary": "[H1] AUA123 ...",
                    "snr_db": 18.4, "rssi_dbfs": -31.2, "evm_deg": 6.1,
                    "raw_hex": "..." } ],
    "unavailable": null, "degraded": null, "suggestCenterHz": null,
    "windowCenterHz": 136812500, "windowRateHz": 2400000,
    "bursts": 40, "syncs": 38, "headers": 35, "headerBad": 3,
    "frames": 31, "fcsBad": 1, "samplesPerSymbol": 9.1
  }
}
```

The client shows the message log with a station table; clicking a station
filters the log, clicking a message opens the frame details and raw AVLC hex.
VDL2's rolling log lives in the snapshot rather than `decoder_messages`: it is
a live message service, and re-persisting a whole re-sent log every 500 ms
would duplicate it.

## HFDL / ARINC 635

HFDL is the HF aircraft/ground data link. It is not an audio mode either: the
dongle's raw IQ is downconverted to a **24 kHz complex lane** centred on the
assigned HF channel, then fed to `sdroxide-hfdl` / `xng-mode-hfdl`.

Start with **21.931 MHz** (Riverhead's primary), or any assigned channel from
the current HFDL frequency table. A 2.4 MSPS profile is more than enough; the
lane itself is only 24 kHz inside the current span.

The decoder emits a rolling event log and level/burst counters about once per
second. Events include squitters, logons/logoffs, performance data, frequency
data, ACARS and position fixes. The client shows a table with time, event kind,
ground station, channel, SNR, skew, FEC corrections and the payload details.

```json
{
  "decoderType": "hfdl",
  "data": {
    "running": true,
    "levelDbfs": -62.4,
    "bursts": 14,
    "decodes": 9,
    "log": [
      {
        "unix": 1760000000,
        "kind": "performance-data",
        "gs": "Riverhead (GS 1)",
        "freqKhz": 21931,
        "snrDb": 12.3,
        "freqSkewHz": 4.1,
        "fecCorrected": 0,
        "details": "{\"icao\":\"...\",\"position\":{...}}",
        "position": {
          "lat": 51.47, "lon": -0.45,
          "aircraftId": 42, "icao": "4CA1FA", "flight": "RYR123"
        }
      }
    ],
    "unavailable": null,
    "degraded": null,
    "suggestCenterHz": null,
    "windowCenterHz": 21931000,
    "windowRateHz": 2400000
  }
}
```

HFDL works in foreground and background modes. The log is a rolling snapshot,
so it is not appended to `decoder_messages` on every status; typed flight/position
entity persistence is a later refinement.

## APRS

APRS on VHF is an FM channel carrying 1200 baud Bell 202 AX.25 UI frames.
The decoder takes the raw dongle stream through `IqExtractor`, an NBFM
discriminator, and a 48 kHz Bell 202 receiver (`serverrs/src/decoders/afsk.rs`,
adapted from `sdroxide-dsp`). `sdroxide-ax25` handles HDLC framing and FCS;
`sdroxide-aprs` parses the information field, including Mic-E, compressed and
uncompressed positions, objects, items, messages, status, weather, telemetry
and grids.

Use the regional APRS channel (144.390 MHz in North America; check the local
band plan) with a 12.5 kHz NFM profile. A 2.4 MSPS dongle span is fine.

Each decoded frame produces a packet event with the source/destination/path,
the parsed kind, position and the original information field. The client
shows a packet table with a Leaflet/OSM map; the map keeps one latest marker
per station and draws a short track from the packet history.

```json
{
  "kind": "packet",
  "id": "aprs-144390",
  "mode": "aprs",
  "text": "N0CALL  37.98380, 23.72750  Test position",
  "rfHz": 144390000,
  "aprs": {
    "at": 1760000000,
    "from": "N0CALL",
    "to": "APRS",
    "via": ["WIDE1-1", "WIDE2-1"],
    "kind": "position",
    "lat": 37.9838,
    "lon": 23.7275,
    "ambiguity": 0,
    "symbol": "/-",
    "courseDeg": null,
    "speedKn": null,
    "altitudeM": null,
    "comment": "Test position",
    "raw": "!3759.03N/02343.65E-Test position"
  }
}
```

APRS snapshots are not persisted as whole entities yet; individual packet text
goes through the generic `decoder_messages` store, and typed APRS station
persistence is a later refinement.

## AX.25 PACKET

Packet radio uses ordinary AX.25 framing over an FM channel. Unlike APRS, the
monitor does not assume a UI/APRS information field: it shows every frame type,
its source/destination/digipeater path, PID, payload and raw bytes.

- **1200 baud**: Bell 202 AFSK, the same receiver as APRS.
- **9600 baud**: G3RUH scrambled NRZ baseband, selected with
  `settings.baud: 9600`.

The server extracts an NBFM channel, demodulates discriminator audio, runs the
selected modem and feeds `sdroxide_ax25::Deframer` and `Packet::parse`. Each
frame produces:

```json
{
  "kind": "packet",
  "id": "packet-145010",
  "mode": "packet",
  "rfHz": 145010000,
  "packet": {
    "at": 1760000000,
    "from": "N0CALL-1",
    "to": "APRS",
    "via": ["WIDE1-1"],
    "type": "UI",
    "pid": 240,
    "payload": "hello",
    "raw": "82a0...",
    "length": 42
  }
}
```

A 1 Hz status event reports frames, bad FCS, non-AX.25 frames, level and the
configured baud. The panel is a packet monitor with a raw-frame inspector.

## NAVTEX

NAVTEX is the maritime safety broadcast on **518 kHz** (English
international), **490 kHz** (national language) and **4209.5 kHz** (tropical).
It is SITOR-B: 100 baud, 170 Hz shift, CCIR 476 constant-ratio characters with
time-diversity FEC. Tune USB with the audio tones around 1700 Hz and a 3 kHz
profile.

The server runs `NavtexRx` (adapted from `sdroxide-dsp`) over the USB audio,
then frames `ZCZC B1B2B3B4` … `NNNN`. A repeat of the same station/subject/
serial replaces the held copy when it has fewer lost characters or is the
first complete copy. Each new or improved message produces an event:

```json
{
  "kind": "message",
  "id": "navtex-518",
  "mode": "navtex",
  "rfHz": 518000,
  "navtex": {
    "at": 1760000000,
    "station": "A",
    "subject": "B",
    "serial": 12,
    "text": "TEST WARNING\r\n",
    "complete": true,
    "lost": 0
  }
}
```

A 1 Hz status event reports `inSync`, `level`, `reverse`, `direct`, `repaired`,
`lost`, message count and the live partial message. The client shows a message
table and the full selected text; NAVTEX bypasses the zoomed waterfall.

Messages go through the generic `decoder_messages` store; typed NAVTEX message
entities are a later refinement.

## ISM

The **868 MHz** licence-free band carries weather/soil sensors, wireless M-Bus
utility meters, Z-Wave and Homematic. Unlike the narrowband decoders this one
needs a wide raw-IQ window: the native channel plan spans roughly 868.18–869.59
MHz, so a 2.4 MSPS front end is the practical minimum. Tune near **868.95 MHz**
or **868.30 MHz** and leave the profile wide.

The server feeds the raw Cu8 window to `sdroxide-ism`'s `IsmController`. The
native decoders are pure Rust; the embedded rtl_433 lane is not compiled in
this build. Reports are a device table, not a chronological burst log:

```json
{
  "kind": "reports",
  "id": "ism-868",
  "mode": "ism",
  "devices": [
    {
      "id": 1234,
      "protocol": "Fine Offset",
      "kind": "Fine Offset WH51",
      "model": "WH51",
      "device": "A1B2",
      "freqHz": 868300000,
      "snrDb": 18,
      "firstAt": 1760000000,
      "lastAt": 1760000300,
      "count": 7,
      "readings": [
        { "quantity": "soil", "value": 42, "unit": "%", "decimals": 0 }
      ],
      "readingsText": "soil 42 %",
      "extra": [["battery", "OK"]],
      "encrypted": false,
      "rawHex": "…"
    }
  ]
}
```

A 500 ms status event reports the channel plan (`live`, `reason`), window
centre/rate, burst and decode counters, and a `suggestCenterHz` when the
receiver is tuned away from the band. The client shows a device table with the
latest readings, count, SNR and raw frame; ISM bypasses the zoom waterfall.

Reports go through the generic `decoder_messages` store as summaries; typed
sensor entities are a later refinement.

## Weather fax (WEFAX)

HF weather facsimile is an SSB channel whose audio subcarrier swings between
**1500 Hz (black)** and **2300 Hz (white)** around 1900 Hz. A transmission
starts with a start tone, sends a phasing pulse at the start of each line, then
draws the chart at 60/90/120/180/240 lines per minute. IOC 576 gives 1809
pixels per line; IOC 288 gives 904.

The server runs a local adaptation of `sdroxide-dsp`'s `WefaxRx` over the USB
audio channel. It emits one server event per line:

```json
{
  "kind": "line",
  "id": "wefax-7880",
  "mode": "wefax",
  "imageId": 3,
  "width": 1809,
  "y": 412,
  "height": 413,
  "gray": "…base64…",
  "at": 1760000000
}
```

The picture starts with `kind: "start"` (IOC, LPM, image id, width), grows with
`line` events, and ends with `kind: "complete"` (`byTone` says whether the stop
tone was heard). A 500 ms `status` event reports receiving/phasing, lines, IOC,
LPM, signal, subcarrier and slant. The client draws the grayscale rows into a
canvas, so a chart appears while it is being received; the image viewer keeps
the finished picture until the next start. WEFAX bypasses the zoom waterfall
like the other data decoders.

## SSTV

Slow-scan television is an SSB channel carrying a VIS header and RGB scan
lines at 1500–2300 Hz. The receiver is a local adaptation of `sdroxide-dsp`'s
`SstvRx`; it auto-detects the mode from the VIS header (Scottie, Martin, Robot,
Wraase and PD families) and emits each decoded row as it arrives.

Message shapes:

```json
{"kind":"start","imageId":3,"sstvMode":"Martin 1","width":320,"height":256}
{"kind":"line","imageId":3,"y":42,"rgb":"<base64 RGB row>"}
{"kind":"id","imageId":3,"callsign":"N0CALL"}
{"kind":"complete","imageId":3,"sstvMode":"Martin 1","width":320,"height":256}
{"kind":"status","receiving":true,"progress":0.42,"signal":0.3,"sstvMode":"Martin 1"}
```

The client canvas paints rows progressively. Completed pictures are kept in a
12-image history ring; selecting an older picture does not stop the live
receiver. An FSTV/FSK ID is attached to the picture when heard. A valid VIS
header for a mode this build cannot draw is reported rather than silently
ignored. SSTV bypasses the zoom waterfall like WEFAX.

## Hellschreiber

Hellschreiber is a facsimile mode: a 7×14 dot cell is sent column by column and
read by eye. There is no character decoder. The receiver is a local adaptation
of `sdroxide-dsp`'s `HellRx`, fed from the standard USB audio path at 12 kHz.

```yaml
- id: hell-40m
  enabled: true
  dongleId: d1
  mode: hell
  frequencyHz: 7040000
  bandwidthHz: 3000
  settings:
    variant: feld    # feld, slow, x5, x9, fsk245, fsk105, hell80
    agc: 0.6
```

The server sends whole 14-pixel columns:

```json
{"kind":"columns","seq":0,"rows":14,"variant":"FELD","cols":"<base64 grayscale column bytes>"}
{"kind":"status","receiving":true,"variant":"FELD","columns":184,"seq":184,"level":0.42}
```

The client paints the columns as a scrolling raster. Print sync, slant and dot
timing are handled inside the receiver; the operator reads spacing and glyph
shape. Hell bypasses the zoom waterfall.

## Olivia / THOR / FSQ / PSK31 / RTTY

Continuous keyboard modes over USB audio. There is no slot timer: text is
decoded as it arrives and streamed to the client in chunks.

```yaml
decoders:
  - id: olivia-20m
    enabled: true
    dongleId: d1
    mode: olivia
    frequencyHz: 14070000
    bandwidthHz: 1000
    settings:
      tones: 8
      bandwidthHz: 500

  - id: thor-20m
    enabled: false
    dongleId: d1
    mode: thor
    frequencyHz: 14070000
    bandwidthHz: 2500
    settings:
      baud: 18.5

  - id: fsq-40m
    enabled: false
    dongleId: d1
    mode: fsq
    frequencyHz: 7104000
    bandwidthHz: 2500
    settings:
      baud: 3

  - id: psk31-20m
    enabled: false
    dongleId: d1
    mode: psk31
    frequencyHz: 14070000
    bandwidthHz: 500
    settings:
      baud: 31.25
      audioHz: 1500

  - id: rtty-20m
    enabled: false
    dongleId: d1
    mode: rtty
    frequencyHz: 14080000
    bandwidthHz: 500
    settings:
      baud: 45.45
      shiftHz: 170
      audioHz: 1500
      reverse: false
      afc: true
```

Pipeline:

```text
raw IQ → IqExtractor → USB SSB audio → 8 kHz modem rate
  ├─ OliviaRx(tones, bandwidth)
  ├─ ThorRx(baud)
  ├─ FsqRx(baud)
  ├─ PskRx(baud) — Varicode
  └─ RttyRx(baud, shift, reverse, afc) — Baudot
       └─ text chunks + status → MSG_DECODER
```

Text event:

```json
{
  "decoderType": "olivia",
  "data": {
    "kind": "text",
    "id": "olivia-20m",
    "mode": "olivia",
    "text": "CQ CQ DE N0CALL",
    "rfHz": 14070000,
    "audioHz": 1500,
    "level": -42.1,
    "at": 1760000000
  }
}
```

The client shows a running text log (or a per-chunk table), with level, audio
frequency and clear/chunk controls. Olivia accepts `tones` and `bandwidthHz`;
THOR, FSQ and PSK31 accept `baud`; RTTY adds `shiftHz`, `reverse` and `afc`.
The status line shows RTTY AFC offset/reverse and the symbol/baud rate.

## FST4 / Q65 / JT65 / JT9 (weak-signal slots)

These are slotted mfsk-core modes with long T/R periods. They use the same
12 kHz USB channel as FT8 and run on the background/foreground worker.

```yaml
decoders:
  - id: fst4-60
    enabled: true
    dongleId: d1
    mode: fst4-60
    frequencyHz: 7078000
    bandwidthHz: 3000

  - id: q65-60d
    enabled: false
    dongleId: d1
    mode: q65-60d
    frequencyHz: 50275000
    bandwidthHz: 3000

  - id: jt65-20m
    enabled: false
    dongleId: d1
    mode: jt65
    frequencyHz: 14076000
    bandwidthHz: 3000

  - id: jt9-20m
    enabled: false
    dongleId: d1
    mode: jt9
    frequencyHz: 14078000
    bandwidthHz: 3000
```

- FST4 aliases: `fst4` (FST4-60A), `fst4-15`, `fst4-30`, `fst4-60`,
  `fst4-120`, `fst4-300`, `fst4-900`, `fst4-1800`.
- Q65 aliases: `q65` (Q65-30A), `q65-15a`, `q65-30a`, `q65-60a`,
  `q65-60b`, `q65-60c`, `q65-60d`, `q65-60e`, `q65-120d`, `q65-120e`,
  `q65-300a`.
- JT65 and JT9 use `mode: jt65` / `mode: jt9`, both with 60-second slots.
- The mode's registry slot length determines the period; there is no separate
  `period` setting.
- Decode rows carry text, RF/audio frequency, DT, SNR and slot period. The UI
  table is shared with MSK144/FSK441.

## WSPR / PI4

WSPR is a 120-second slotted mfsk-core mode. PI4 is the IARU Region 1
"Next Generation Beacon" 4-FSK mode: a 24.3-second message searched inside a
one-minute window. Both use the normal 12 kHz USB audio path and the shared
weak-signal table.

```yaml
decoders:
  - id: wspr-20m
    enabled: true
    dongleId: d1
    mode: wspr
    frequencyHz: 14095600
    bandwidthHz: 200

  - id: pi4-2m
    enabled: false
    dongleId: d1
    mode: pi4
    frequencyHz: 144471000
    bandwidthHz: 3000
```

- WSPR decode rows contain text, RF/audio frequency, DT, SNR and period.
  Optional WSPRnet/PSK Reporter upload is not implemented yet.
- PI4 rows additionally carry `variant` (`PI4`, `PI4-80`, `PI4-96`,
  `PI4-120`), `fit` and `hardErrors`. The table's CONF/FIT column shows the
  variant and fit.
- WSPR period is 120 seconds; PI4 uses a 60-second window and the beacon
  network's minute-boundary timing.

## MSK144 / FSK441 (meteor scatter)

Both modes search a whole T/R period for short meteor bursts rather than
decoding one frame at a fixed offset. MSK144 uses mfsk-core's sliding-window
receiver at 12 kHz; FSK441 uses a local adaptation of `sdroxide-dsp`'s ping
search at 11 025 Hz, where its 25-samples-per-dit constants line up.

```yaml
decoders:
  - id: msk144-6m
    enabled: true
    dongleId: d1
    mode: msk144
    frequencyHz: 50260000
    bandwidthHz: 2500

  - id: fsk441-6m
    enabled: false
    dongleId: d1
    mode: fsk441
    frequencyHz: 50260000
    bandwidthHz: 2500
    settings:
      period: 30       # 15 or 30 seconds
```

The server emits one row per burst:

```json
{
  "decoderType": "msk144",
  "data": {
    "kind": "decode",
    "id": "msk144-6m",
    "mode": "msk144",
    "text": "CQ W1ABC FN42",
    "rfHz": 50261500,
    "audioHz": 1500,
    "snrDb": -8,
    "dtSec": 4.23,
    "period": 123456,
    "dialHz": 50260000
  }
}
```

FSK441 also reports `durationSec` and `confidence`. Status snapshots carry
level, audio frequency, period and decode count. The client table shows time,
mode, text, RF, DT, SNR and confidence.

## Roadmap

1. FT8/FT4 background decoders and result transport. *(implemented)*
2. FT2 on top of mfsk-core's FT4 stages. *(implemented)*
3. ADS-B raw-IQ decoder, foreground/background, aircraft table + OSM map.
   *(implemented)*
4. ACARS / ARINC 618 VHF datalink, foreground/background, message table.
   *(implemented)*
5. AIS marine VHF receiver, both channels, vessel table + map. *(implemented)*
6. VDL2 VHF datalink, foreground/background, message log + stations.
   *(implemented)*
7. HFDL ARINC 635 lane, foreground/background event log. *(implemented)*
8. APRS 1200 baud AX.25, packet table + map. *(implemented)*
9. NAVTEX SITOR-B, message table and full-text panel. *(implemented)*
10. ISM 868 MHz device table. *(implemented)*
11. AX.25 packet: 1200/9600 baud TNC receive path and packet log.
    *(implemented)*
12. Weather fax image decoder + canvas viewer. *(implemented)*
13. SSTV image decoder, progressive canvas and picture history. *(implemented)*
14. Hellschreiber raster receiver and scrolling panel. *(implemented)*
15. Olivia/THOR/FSQ. *(implemented)*
16. PSK31/RTTY text modes. *(implemented)*
17. MSK144/FSK441 meteor scatter. *(implemented)*
18. FST4/Q65 weak-signal slots. *(implemented)*
19. JT65/JT9. *(implemented)*
20. WSPR/PI4. *(implemented)*
21. JS8. *(implemented)*
22. DCF77/ALS162 time signals. *(implemented)*

## JS8

JS8 uses an FT8-like 8-FSK waveform with four speed submodes. The protocol and
varicode/frame layers are adapted from `sdroxide-digi`/JS8Call (GPL-compatible).
The server receives USB audio, cuts slots at the selected speed and assembles
multi-frame messages.

```yaml
decoders:
  - id: js8-40m
    enabled: true
    dongleId: d1
    mode: js8
    frequencyHz: 7078000
    bandwidthHz: 3000
    settings:
      speed: normal       # normal | fast | turbo | slow
      depth: bp-osd       # bp | bp-osd
      myCall: N0CALL      # optional, for directed/group highlighting
      myGroups: ["@EMCOMM"]
```

Messages are sent as `kind:"message"` with the sender/recipient, command, text,
RF/audio frequency, SNR, first/last slot, frame count, completeness, directed
flag and speed. `kind:"status"` snapshots carry the speed, slot period, level,
decode count and the heard-station list. The client shows a message table and
station list; JS8 has no zoom waterfall.

## DCF77 / ALS162 time signals

Both longwave time services carry the same 59-bit minute fields. DCF77 keys
the carrier amplitude for 100 ms (0) or 200 ms (1); ALS162 keys the carrier
phase with one triangular pulse (0) or two pulses (1), with second 59 silent.

```yaml
decoders:
  - id: dcf77
    enabled: true
    dongleId: d1
    mode: dcf77
    frequencyHz: 77500
    bandwidthHz: 200

  - id: als162
    enabled: true
    dongleId: d1
    mode: als162
    frequencyHz: 162000
    bandwidthHz: 200
```

DCF77 uses an adaptive envelope slicer; ALS162 unwraps and detrends the phase,
resamples to 1 kHz and correlates against the 25/50/25 ms pulse template. Both
emit `kind:"time"` with the decoded year/month/day/hour/minute, weekday, UTC
offset, Unix time and DST/leap/holiday/clock-change flags. `kind:"status"`
reports sync, bits, level and the last clock. The client panel shows the
decoded local time, date, UTC offset and announcement flags.

The UI should be data-driven by decoder type; ADSB and AIS want maps, FT8 and
APRS want tables/logs, SSTV/WEFAX want image views.
