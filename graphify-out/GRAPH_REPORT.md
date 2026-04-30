# Graph Report - .  (2026-04-30)

## Corpus Check
- 94 files · ~280,000 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1004 nodes · 1407 edges · 39 communities detected
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 73 edges (avg confidence: 0.81)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]

## God Nodes (most connected - your core abstractions)
1. `SdrEngine` - 87 edges
2. `DongleManager` - 32 edges
3. `WebSocketManager` - 28 edges
4. `AudioEngine` - 21 edges
5. `SpectrumRenderer` - 19 edges
6. `WaterfallRenderer` - 17 edges
7. `FmDemodulator` - 15 edges
8. `Manager` - 14 edges
9. `OpusAudioPipeline` - 12 edges
10. `CQuamDemodulator` - 12 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Communities

### Community 0 - "Community 0"
Cohesion: 0.03
Nodes (25): getDefaultConfig(), loadConfig(), writeDefaultConfig(), adminAuth(), generateSessionToken(), isValidSessionToken(), AmMonoDemod, Biquad (+17 more)

### Community 1 - "Community 1"
Cohesion: 0.04
Nodes (15): Agc, AmDemodulator, BiquadFilter, CQuamDemodulator, CwDemodulator, DcBlocker, Decimator, DeemphasisFilter (+7 more)

### Community 2 - "Community 2"
Cohesion: 0.04
Nodes (3): getDemodulator(), SdrEngine, unpackBinaryMessage()

### Community 3 - "Community 3"
Cohesion: 0.03
Nodes (9): HangAgc, AudioEngine, FftFrameBuffer, cpu(), cpuColor(), history(), isLast(), createStore() (+1 more)

### Community 4 - "Community 4"
Cohesion: 0.06
Nodes (20): CompressFft(), compressFftInto(), DeltaEncode(), DeflateFft(), NewFftDeflateEncoder(), PackFftDeflatePayload(), FftDeflateEncoder, activeDongle (+12 more)

### Community 5 - "Community 5"
Cohesion: 0.09
Nodes (17): getOutputSampleRate(), compressFft(), packAudioMessage(), packAudioOpusMessage(), packBinaryMessage(), packCompressedFftMessage(), packFftAdpcmMessage(), packFftDeflateMessage() (+9 more)

### Community 6 - "Community 6"
Cohesion: 0.06
Nodes (44): Client index.html Entry Point, FFT Compression Evaluation, airspy_tcp Source, HackRF One (CLI), hfp_tcp Source, Hardware Integration Roadmap, LimeSDR (SoapySDR), PlutoSDR (ADALM-PLUTO) (+36 more)

### Community 7 - "Community 7"
Cohesion: 0.07
Nodes (13): BiphaseDecoder, Biquad, BlockSync, calculateSyndrome(), DeltaDecoder, emptyRdsData(), getOffsetForSyndrome(), GroupParser (+5 more)

### Community 8 - "Community 8"
Cohesion: 0.07
Nodes (13): BiphaseDecoder, Biquad, BlockSync, calculateSyndrome(), DeltaDecoder, emptyRdsData(), getOffsetForSyndrome(), GroupParser (+5 more)

### Community 9 - "Community 9"
Cohesion: 0.09
Nodes (1): DongleManager

### Community 10 - "Community 10"
Cohesion: 0.08
Nodes (5): buildPalette(), getPalette(), WaterfallRenderer, buildPalette(), getPalette()

### Community 11 - "Community 11"
Cohesion: 0.09
Nodes (4): AutoNotch, biquadProcess(), HiBlendFilter, RumbleFilter

### Community 12 - "Community 12"
Cohesion: 0.08
Nodes (6): bench(), bench(), decodeFftAdpcm(), encodeFftAdpcm(), ImaAdpcmDecoder, ImaAdpcmEncoder

### Community 13 - "Community 13"
Cohesion: 0.08
Nodes (5): barColor(), buildBgCache(), buildStaticCache(), drawNeedleMeter(), pct()

### Community 14 - "Community 14"
Cohesion: 0.1
Nodes (4): fftInPlace(), NoiseBlanker, NoiseReductionEngine, SpectralNoiseReducer

### Community 15 - "Community 15"
Cohesion: 0.1
Nodes (19): dongleResponse, profileResponse, donglesHandler(), NewRouter(), statusHandler(), writeJSON(), SPAHandler(), Config (+11 more)

### Community 16 - "Community 16"
Cohesion: 0.13
Nodes (15): FFT, bitReversalPermute(), computeBitReversal(), computeTwiddles(), NewFFT(), NewFftProcessor(), reverseBits(), FftProcessor (+7 more)

### Community 17 - "Community 17"
Cohesion: 0.14
Nodes (11): freqFromEvent(), handleSpectrumMouseDown(), handleSpectrumMouseMove(), handleSpectrumMouseUp(), handleSpectrumWheel(), handleWaterfallClick(), handleWaterfallMouseMove(), handleWaterfallWheel() (+3 more)

### Community 18 - "Community 18"
Cohesion: 0.12
Nodes (4): Client, newClient(), Manager, ParseClientCommand()

### Community 19 - "Community 19"
Cohesion: 0.13
Nodes (1): SpectrumRenderer

### Community 20 - "Community 20"
Cohesion: 0.12
Nodes (17): FFT Compression Workflow Diagram, FFT Domain Lossless Diagram, No-SDR UI Layout Diagram, Node-SDR Compression Panel Screenshot, Node-SDR Main UI Screenshot, 5-Band Parametric Equalizer (Knobs), Audio Controls Panel (Volume/Balance/EQ), Compression Codec Selector Panel (+9 more)

### Community 21 - "Community 21"
Cohesion: 0.23
Nodes (6): clampIndex(), clampInt16(), EncodeFftAdpcm(), NewImaAdpcmEncoder(), ImaAdpcmDecoder, ImaAdpcmEncoder

### Community 23 - "Community 23"
Cohesion: 0.25
Nodes (1): DecoderManager

### Community 24 - "Community 24"
Cohesion: 0.29
Nodes (3): biquadProcess(), designButterworth4(), IqExtractor

### Community 25 - "Community 25"
Cohesion: 0.28
Nodes (1): FftHistoryBuffer

### Community 26 - "Community 26"
Cohesion: 0.25
Nodes (1): LmsAnr

### Community 27 - "Community 27"
Cohesion: 0.36
Nodes (1): SamDemodulator

### Community 28 - "Community 28"
Cohesion: 0.43
Nodes (1): FftProcessor

### Community 30 - "Community 30"
Cohesion: 0.33
Nodes (6): Apple Touch Icon, Node-SDR Favicon (Radio Wave Logo), PWA Maskable Icon 192px, PWA Icon 192px, PWA Maskable Icon 512px, PWA Icon 512px

### Community 31 - "Community 31"
Cohesion: 0.6
Nodes (6): Client (SolidJS Browser App), DongleManager, FFT / IQ Extractor, Hardware Layer (RTL-SDR), Server Process (Node.js/Hono), Architecture Diagram

### Community 32 - "Community 32"
Cohesion: 0.83
Nodes (3): capturePass(), getDongles(), main()

### Community 34 - "Community 34"
Cohesion: 0.67
Nodes (3): REST API Flow Diagram, Session Flow Diagram, WebSocket Protocol Diagram

### Community 35 - "Community 35"
Cohesion: 1.0
Nodes (2): Spotify-Inspired Design System, Theming System

### Community 36 - "Community 36"
Cohesion: 1.0
Nodes (2): gqrx AGC Implementation, Hang-Timer AGC

### Community 37 - "Community 37"
Cohesion: 1.0
Nodes (2): SpyServer Protocol, Multi-User Scaling Model

### Community 38 - "Community 38"
Cohesion: 1.0
Nodes (2): Data Flow Diagram, No-SDR Data Flow Diagram

### Community 43 - "Community 43"
Cohesion: 1.0
Nodes (1): SolidJS Store

### Community 44 - "Community 44"
Cohesion: 1.0
Nodes (1): AirSpy CLI Source

### Community 45 - "Community 45"
Cohesion: 1.0
Nodes (1): Active Tasks (TODO)

## Knowledge Gaps
- **65 isolated node(s):** `WebSocket Binary Protocol`, `DecoderManager`, `WaterfallRenderer`, `SpectrumRenderer`, `SolidJS Store` (+60 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 9`** (31 nodes): `DongleManager`, `.addProfile()`, `.autoStartAll()`, `.connectAirspyTcp()`, `.connectHfpTcp()`, `.connectRspTcp()`, `.connectRtlTcp()`, `.constructor()`, `.deleteProfile()`, `.getActiveProfile()`, `.getConfig()`, `.getDongle()`, `.getDongles()`, `.getEffectiveSource()`, `.getProfiles()`, `.initDongles()`, `.reorderProfiles()`, `.rspSendExtended()`, `.rtlTcpSendCommand()`, `.scheduleRestart()`, `.setRtlTcpFrequency()`, `.setRtlTcpGain()`, `.setRtlTcpSampleRate()`, `.spawnRtlProcess()`, `.startDongle()`, `.stopAll()`, `.stopDongle()`, `.switchProfile()`, `.updateClientCount()`, `.updateDongleConfig()`, `.updateProfile()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 19`** (18 nodes): `SpectrumRenderer`, `.constructor()`, `.draw()`, `.drawTuningIndicator()`, `.getZoom()`, `.isZoomed()`, `.lastPixelDb()`, `.peakDbValues()`, `.resetZoom()`, `.resize()`, `.setAccentColor()`, `.setNoiseFloor()`, `.setPause()`, `.setRange()`, `.setSignalFill()`, `.setSmoothing()`, `.setZoom()`, `.tooltipPeakDb()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 23`** (11 nodes): `DecoderManager`, `.checkAllBinaries()`, `.checkBinaryAvailable()`, `.feedIqData()`, `.getRunningDecoders()`, `.handleDecoderExit()`, `.spawnDecoder()`, `.startDecoder()`, `.stopAll()`, `.stopDecoder()`, `.stopDongleDecoders()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 25`** (9 nodes): `fft-history.ts`, `FftHistoryBuffer`, `.computeSrcRanges()`, `.constructor()`, `.count()`, `.getFrames()`, `.push()`, `.reset()`, `.setLiveBinCount()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 26`** (9 nodes): `lms-anr.ts`, `LmsAnr`, `.constructor()`, `.isEnabled()`, `.process()`, `.reset()`, `.setEnabled()`, `.setOptions()`, `.setPreset()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 27`** (9 nodes): `SamDemodulator`, `.computeLoopCoeffs()`, `.computeLpf()`, `.constructor()`, `.isLocked()`, `.process()`, `.reset()`, `.setBandwidth()`, `.setInputSampleRate()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 28`** (8 nodes): `FftProcessor`, `.computeNormalization()`, `.constructor()`, `.createWindow()`, `.processIqData()`, `.processOneFrame()`, `.reset()`, `.resize()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 35`** (2 nodes): `Spotify-Inspired Design System`, `Theming System`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 36`** (2 nodes): `gqrx AGC Implementation`, `Hang-Timer AGC`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 37`** (2 nodes): `SpyServer Protocol`, `Multi-User Scaling Model`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 38`** (2 nodes): `Data Flow Diagram`, `No-SDR Data Flow Diagram`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 43`** (1 nodes): `SolidJS Store`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 44`** (1 nodes): `AirSpy CLI Source`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 45`** (1 nodes): `Active Tasks (TODO)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `SdrEngine` connect `Community 2` to `Community 3`?**
  _High betweenness centrality (0.301) - this node is a cross-community bridge._
- **Why does `WebSocketManager` connect `Community 5` to `Community 0`?**
  _High betweenness centrality (0.255) - this node is a cross-community bridge._
- **Why does `unpackBinaryMessage()` connect `Community 2` to `Community 5`?**
  _High betweenness centrality (0.224) - this node is a cross-community bridge._
- **What connects `WebSocket Binary Protocol`, `DecoderManager`, `WaterfallRenderer` to the rest of the system?**
  _65 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.03 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.04 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.04 - nodes in this community are weakly interconnected._