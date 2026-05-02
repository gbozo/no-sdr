# Graph Report - node-sdr  (2026-05-02)

## Corpus Check
- 119 files · ~308,282 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1602 nodes · 2465 edges · 51 communities detected
- Extraction: 82% EXTRACTED · 18% INFERRED · 0% AMBIGUOUS · INFERRED: 433 edges (avg confidence: 0.8)
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
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]

## God Nodes (most connected - your core abstractions)
1. `SdrEngine` - 87 edges
2. `DongleManager` - 32 edges
3. `Manager` - 32 edges
4. `abs()` - 32 edges
5. `WebSocketManager` - 28 edges
6. `NewRouterWithPath()` - 25 edges
7. `writeJSON()` - 24 edges
8. `NewIqExtractor()` - 23 edges
9. `Manager` - 22 edges
10. `AudioEngine` - 21 edges

## Surprising Connections (you probably didn't know these)
- `Node-SDR Main UI Screenshot` --semantically_similar_to--> `No-SDR UI Layout Diagram`  [INFERRED] [semantically similar]
  screenshots/no-sdr.jpeg → docs/images/no-sdr-ui-diagram.svg
- `Noise Reduction Engine` --semantically_similar_to--> `LMS Adaptive NR (WDSP ANR)`  [INFERRED] [semantically similar]
  SPEC.md → signal-improvements.md
- `C-QUAM AM Stereo Demodulator` --semantically_similar_to--> `Synchronous AM Detection (SAM)`  [INFERRED] [semantically similar]
  SPEC.md → signal-improvements.md
- `FftProcessor` --conceptually_related_to--> `Kaiser Window + Slow-Scan Integration`  [INFERRED]
  SPEC.md → signal-improvements.md
- `FftProcessor` --references--> `FFT Compression Evaluation`  [INFERRED]
  SPEC.md → docs/FFT-compression-evaluation.md

## Communities

### Community 0 - "Community 0"
Cohesion: 0.02
Nodes (29): getDefaultConfig(), loadConfig(), writeDefaultConfig(), DecoderManager, adminAuth(), generateSessionToken(), isValidSessionToken(), biquadProcess() (+21 more)

### Community 1 - "Community 1"
Cohesion: 0.04
Nodes (15): Agc, AmDemodulator, BiquadFilter, CQuamDemodulator, CwDemodulator, DcBlocker, Decimator, DeemphasisFilter (+7 more)

### Community 2 - "Community 2"
Cohesion: 0.04
Nodes (3): getDemodulator(), SdrEngine, unpackBinaryMessage()

### Community 3 - "Community 3"
Cohesion: 0.03
Nodes (10): HangAgc, AudioEngine, FftFrameBuffer, LmsAnr, cpu(), cpuColor(), history(), isLast() (+2 more)

### Community 4 - "Community 4"
Cohesion: 0.05
Nodes (55): fastAtan2(), TestFastAtan2(), FFT, bitReversalPermute(), computeBitReversal(), computeTwiddles(), NewFFT(), NewFftProcessor() (+47 more)

### Community 5 - "Community 5"
Cohesion: 0.05
Nodes (40): getOutputSampleRate(), compressFft(), packAudioMessage(), packAudioOpusMessage(), packBinaryMessage(), packCompressedFftMessage(), packFftAdpcmMessage(), packFftDeflateMessage() (+32 more)

### Community 6 - "Community 6"
Cohesion: 0.04
Nodes (39): BenchmarkFullFFTPipeline(), BenchmarkFullFFTPipeline4096(), BenchmarkIqExtractorNFM(), BenchmarkIqExtractorSSB(), BenchmarkIqExtractorWFM(), biquadCoeffs, biquadState, ButterworthBlock (+31 more)

### Community 7 - "Community 7"
Cohesion: 0.05
Nodes (31): BenchmarkAmPipeline(), BenchmarkDemodPipeline(), BenchmarkFmMonoPipeline(), BenchmarkFmStereoPipeline(), BenchmarkSsbPipeline(), generateTestIQ(), NewCwDemod(), CwDemod (+23 more)

### Community 8 - "Community 8"
Cohesion: 0.05
Nodes (25): activeDongle, NewAirspyTcpSource(), AirspyTcpSource, clientPipeline, NewDemoSource(), TestDemoSource_Run_CancelStops(), TestDemoSource_Run_ProducesData(), TestNewDemoSource_CustomSignals() (+17 more)

### Community 9 - "Community 9"
Cohesion: 0.05
Nodes (21): NewAmDemod(), BenchmarkAmDemod(), TestAmDemod(), TestAmDemodName(), TestCquamDemod(), TestCquamDemodName(), TestSamDemod(), TestSamDemodReset() (+13 more)

### Community 10 - "Community 10"
Cohesion: 0.05
Nodes (6): barColor(), buildBgCache(), buildStaticCache(), drawNeedleMeter(), pct(), SpectrumRenderer

### Community 11 - "Community 11"
Cohesion: 0.08
Nodes (36): CompressFft(), compressFftInto(), DeltaDecode(), DeltaEncode(), BenchmarkCompressFft65536(), BenchmarkDeflateFft65536(), BenchmarkFftDeflateEncoder65536(), inflateRaw() (+28 more)

### Community 12 - "Community 12"
Cohesion: 0.05
Nodes (12): NewOpusEncoder(), OpusAvailable(), TestNewOpusEncoder_StubReturnsError(), OpusEncoder, OpusEncoderConfig, OpusPacket, bench(), bench() (+4 more)

### Community 13 - "Community 13"
Cohesion: 0.06
Nodes (44): Client index.html Entry Point, FFT Compression Evaluation, airspy_tcp Source, HackRF One (CLI), hfp_tcp Source, Hardware Integration Roadmap, LimeSDR (SoapySDR), PlutoSDR (ADALM-PLUTO) (+36 more)

### Community 14 - "Community 14"
Cohesion: 0.07
Nodes (13): BiphaseDecoder, Biquad, BlockSync, calculateSyndrome(), DeltaDecoder, emptyRdsData(), getOffsetForSyndrome(), GroupParser (+5 more)

### Community 15 - "Community 15"
Cohesion: 0.07
Nodes (13): BiphaseDecoder, Biquad, BlockSync, calculateSyndrome(), DeltaDecoder, emptyRdsData(), getOffsetForSyndrome(), GroupParser (+5 more)

### Community 16 - "Community 16"
Cohesion: 0.12
Nodes (27): adminDonglesHandler(), createDongleHandler(), createProfileHandler(), deleteDongleHandler(), deleteProfileHandler(), dongleStartHandler(), dongleStopHandler(), localDevicesHandler() (+19 more)

### Community 17 - "Community 17"
Cohesion: 0.12
Nodes (26): NewRouter(), TestCORSHeaders(), TestDonglesEndpoint(), TestHealthEndpoint(), TestStatusEndpoint(), SPAHandler(), TestManagerNoDongles(), TestManagerSkipsDisabledDongle() (+18 more)

### Community 18 - "Community 18"
Cohesion: 0.08
Nodes (5): AllowedCodecs, Client, newClient(), CodecStatus, Manager

### Community 19 - "Community 19"
Cohesion: 0.09
Nodes (1): DongleManager

### Community 20 - "Community 20"
Cohesion: 0.12
Nodes (17): biquadCoeffsF64, biquadProcess(), NewRdsDecoder(), rdsComputeSyndrome(), sanitizeChar(), encodeRdsBlock(), TestRdsCheckSyndrome(), TestRdsCheckSyndromeBlockB() (+9 more)

### Community 21 - "Community 21"
Cohesion: 0.09
Nodes (4): AutoNotch, biquadProcess(), HiBlendFilter, RumbleFilter

### Community 22 - "Community 22"
Cohesion: 0.08
Nodes (5): buildPalette(), getPalette(), WaterfallRenderer, buildPalette(), getPalette()

### Community 23 - "Community 23"
Cohesion: 0.1
Nodes (4): fftInPlace(), NoiseBlanker, NoiseReductionEngine, SpectralNoiseReducer

### Community 24 - "Community 24"
Cohesion: 0.16
Nodes (17): clampIndex(), clampInt16(), EncodeFftAdpcm(), NewImaAdpcmDecoder(), NewImaAdpcmEncoder(), BenchmarkDecode(), BenchmarkEncode(), BenchmarkEncodeFftAdpcm() (+9 more)

### Community 25 - "Community 25"
Cohesion: 0.11
Nodes (10): decimator, passthrough, Pipeline, NewPipeline(), testLogger(), TestPipeline_ChainedDecimation(), TestPipeline_EmptyBlocksError(), TestPipeline_InvalidRateError() (+2 more)

### Community 26 - "Community 26"
Cohesion: 0.14
Nodes (11): freqFromEvent(), handleSpectrumMouseDown(), handleSpectrumMouseMove(), handleSpectrumMouseUp(), handleSpectrumWheel(), handleWaterfallClick(), handleWaterfallMouseMove(), handleWaterfallWheel() (+3 more)

### Community 27 - "Community 27"
Cohesion: 0.12
Nodes (5): LocalDeviceInfo, EnumerateLocalDevices(), NewRtlSdrSource(), RtlSdrConfig, RtlSdrSource

### Community 28 - "Community 28"
Cohesion: 0.19
Nodes (16): Config, applyDefaults(), applyProfileDefaults(), isPowerOf2(), Load(), TestDefaultValues(), TestInvalidFftSize(), TestInvalidMode() (+8 more)

### Community 29 - "Community 29"
Cohesion: 0.12
Nodes (17): FFT Compression Workflow Diagram, FFT Domain Lossless Diagram, No-SDR UI Layout Diagram, Node-SDR Compression Panel Screenshot, Node-SDR Main UI Screenshot, 5-Band Parametric Equalizer (Knobs), Audio Controls Panel (Volume/Balance/EQ), Compression Codec Selector Panel (+9 more)

### Community 30 - "Community 30"
Cohesion: 0.17
Nodes (9): NewFftBuffer(), TestConcurrentPushAndRead(), TestGetFramesInvalidRange(), TestGetFramesSubset(), TestGetFramesWithWrapAround(), TestGetRangeEmpty(), TestPushAndCount(), TestPushOverCapacity() (+1 more)

### Community 31 - "Community 31"
Cohesion: 0.23
Nodes (1): RtlTcpSource

### Community 32 - "Community 32"
Cohesion: 0.18
Nodes (8): NewNoiseBlanker(), BenchmarkNoiseBlanker(), TestNoiseBlanker_DisabledPassesThrough(), TestNoiseBlanker_GuardWindow(), TestNoiseBlanker_ImpulseBlanked(), TestNoiseBlanker_NormalSignalPasses(), TestNoiseBlanker_Reset(), NoiseBlanker

### Community 33 - "Community 33"
Cohesion: 0.2
Nodes (9): NewRateLimiter(), TestAllowUpToMax(), TestDifferentIPsIndependent(), TestMiddlewareAllowsDifferentIPs(), TestMiddlewareRejects429(), TestRejectOverMax(), TestReleaseFreesSlot(), TestReleaseToZeroRemovesEntry() (+1 more)

### Community 35 - "Community 35"
Cohesion: 0.24
Nodes (5): clamp(), DemoConfig, DemoSource, SignalConfig, simulatedSignal

### Community 36 - "Community 36"
Cohesion: 0.28
Nodes (1): FftHistoryBuffer

### Community 37 - "Community 37"
Cohesion: 0.36
Nodes (1): SamDemodulator

### Community 38 - "Community 38"
Cohesion: 0.43
Nodes (1): FftProcessor

### Community 40 - "Community 40"
Cohesion: 0.33
Nodes (6): Apple Touch Icon, Node-SDR Favicon (Radio Wave Logo), PWA Maskable Icon 192px, PWA Icon 192px, PWA Maskable Icon 512px, PWA Icon 512px

### Community 41 - "Community 41"
Cohesion: 0.6
Nodes (6): Client (SolidJS Browser App), DongleManager, FFT / IQ Extractor, Hardware Layer (RTL-SDR), Server Process (Node.js/Hono), Architecture Diagram

### Community 42 - "Community 42"
Cohesion: 0.4
Nodes (4): Block, BlockContext, ComplexToRealBlock, ProcessorBlock

### Community 43 - "Community 43"
Cohesion: 0.83
Nodes (3): capturePass(), getDongles(), main()

### Community 45 - "Community 45"
Cohesion: 0.67
Nodes (2): CommandableSource, Source

### Community 46 - "Community 46"
Cohesion: 0.67
Nodes (3): REST API Flow Diagram, Session Flow Diagram, WebSocket Protocol Diagram

### Community 47 - "Community 47"
Cohesion: 1.0
Nodes (2): gqrx AGC Implementation, Hang-Timer AGC

### Community 48 - "Community 48"
Cohesion: 1.0
Nodes (2): Spotify-Inspired Design System, Theming System

### Community 49 - "Community 49"
Cohesion: 1.0
Nodes (2): SpyServer Protocol, Multi-User Scaling Model

### Community 50 - "Community 50"
Cohesion: 1.0
Nodes (2): Data Flow Diagram, No-SDR Data Flow Diagram

### Community 56 - "Community 56"
Cohesion: 1.0
Nodes (1): SolidJS Store

### Community 57 - "Community 57"
Cohesion: 1.0
Nodes (1): AirSpy CLI Source

### Community 58 - "Community 58"
Cohesion: 1.0
Nodes (1): Active Tasks (TODO)

## Knowledge Gaps
- **88 isolated node(s):** `Config`, `ServerConfig`, `DongleConfig`, `SourceConfig`, `DongleProfile` (+83 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 19`** (31 nodes): `DongleManager`, `.addProfile()`, `.autoStartAll()`, `.connectAirspyTcp()`, `.connectHfpTcp()`, `.connectRspTcp()`, `.connectRtlTcp()`, `.constructor()`, `.deleteProfile()`, `.getActiveProfile()`, `.getConfig()`, `.getDongle()`, `.getDongles()`, `.getEffectiveSource()`, `.getProfiles()`, `.initDongles()`, `.reorderProfiles()`, `.rspSendExtended()`, `.rtlTcpSendCommand()`, `.scheduleRestart()`, `.setRtlTcpFrequency()`, `.setRtlTcpGain()`, `.setRtlTcpSampleRate()`, `.spawnRtlProcess()`, `.startDongle()`, `.stopAll()`, `.stopDongle()`, `.switchProfile()`, `.updateClientCount()`, `.updateDongleConfig()`, `.updateProfile()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 31`** (15 nodes): `RtlTcpSource`, `.Close()`, `.Command()`, `.Connect()`, `.DongleInfo()`, `.Run()`, `.SetAgcMode()`, `.SetBiasT()`, `.SetDirectSampling()`, `.SetFrequency()`, `.SetFrequencyCorrection()`, `.SetGain()`, `.SetGainMode()`, `.SetOffsetTuning()`, `.SetSampleRate()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 36`** (9 nodes): `fft-history.ts`, `FftHistoryBuffer`, `.computeSrcRanges()`, `.constructor()`, `.count()`, `.getFrames()`, `.push()`, `.reset()`, `.setLiveBinCount()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 37`** (9 nodes): `SamDemodulator`, `.computeLoopCoeffs()`, `.computeLpf()`, `.constructor()`, `.isLocked()`, `.process()`, `.reset()`, `.setBandwidth()`, `.setInputSampleRate()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 38`** (8 nodes): `FftProcessor`, `.computeNormalization()`, `.constructor()`, `.createWindow()`, `.processIqData()`, `.processOneFrame()`, `.reset()`, `.resize()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 45`** (3 nodes): `CommandableSource`, `Source`, `source.go`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 47`** (2 nodes): `gqrx AGC Implementation`, `Hang-Timer AGC`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 48`** (2 nodes): `Spotify-Inspired Design System`, `Theming System`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 49`** (2 nodes): `SpyServer Protocol`, `Multi-User Scaling Model`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 50`** (2 nodes): `Data Flow Diagram`, `No-SDR Data Flow Diagram`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 56`** (1 nodes): `SolidJS Store`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 57`** (1 nodes): `AirSpy CLI Source`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 58`** (1 nodes): `Active Tasks (TODO)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `main()` connect `Community 17` to `Community 8`, `Community 12`, `Community 15`, `Community 16`, `Community 27`, `Community 28`?**
  _High betweenness centrality (0.288) - this node is a cross-community bridge._
- **Why does `Manager` connect `Community 8` to `Community 9`, `Community 5`?**
  _High betweenness centrality (0.263) - this node is a cross-community bridge._
- **Why does `WebSocketManager` connect `Community 5` to `Community 0`?**
  _High betweenness centrality (0.240) - this node is a cross-community bridge._
- **Are the 27 inferred relationships involving `abs()` (e.g. with `TestAmDemod()` and `TestSamDemod()`) actually correct?**
  _`abs()` has 27 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Config`, `ServerConfig`, `DongleConfig` to the rest of the system?**
  _88 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.02 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.04 - nodes in this community are weakly interconnected._