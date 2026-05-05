# Graph Report - .  (2026-05-05)

## Corpus Check
- 155 files · ~320,094 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1627 nodes · 2535 edges · 50 communities detected
- Extraction: 80% EXTRACTED · 20% INFERRED · 0% AMBIGUOUS · INFERRED: 502 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Dongle Lifecycle & Pipeline|Dongle Lifecycle & Pipeline]]
- [[_COMMUNITY_Client Demodulators|Client Demodulators]]
- [[_COMMUNITY_SDR Engine & Client Core|SDR Engine & Client Core]]
- [[_COMMUNITY_Docs & Design Specs|Docs & Design Specs]]
- [[_COMMUNITY_DSP FFT Core|DSP FFT Core]]
- [[_COMMUNITY_Dongle Benchmarks|Dongle Benchmarks]]
- [[_COMMUNITY_Demodulator Benchmarks|Demodulator Benchmarks]]
- [[_COMMUNITY_ACRAPI Metadata|ACR/API Metadata]]
- [[_COMMUNITY_AMCQUAM Demodulation|AM/CQUAM Demodulation]]
- [[_COMMUNITY_HTTP API Router|HTTP API Router]]
- [[_COMMUNITY_Client Audio & FFT Workers|Client Audio & FFT Workers]]
- [[_COMMUNITY_Admin API Endpoints|Admin API Endpoints]]
- [[_COMMUNITY_RDS Decoder & Biquad|RDS Decoder & Biquad]]
- [[_COMMUNITY_Admin UI & ControlPanel|Admin UI & ControlPanel]]
- [[_COMMUNITY_Config & Bookmarks|Config & Bookmarks]]
- [[_COMMUNITY_SolidJS App Components|SolidJS App Components]]
- [[_COMMUNITY_Client RDS Decoder|Client RDS Decoder]]
- [[_COMMUNITY_Opus Codec|Opus Codec]]
- [[_COMMUNITY_FFT Compression Codec|FFT Compression Codec]]
- [[_COMMUNITY_System Architecture Diagrams|System Architecture Diagrams]]
- [[_COMMUNITY_Waterfall Renderer|Waterfall Renderer]]
- [[_COMMUNITY_Audio Filters|Audio Filters]]
- [[_COMMUNITY_WebSocket Manager|WebSocket Manager]]
- [[_COMMUNITY_ADPCM Codec|ADPCM Codec]]
- [[_COMMUNITY_Noise Reduction|Noise Reduction]]
- [[_COMMUNITY_Demo Signal Source|Demo Signal Source]]
- [[_COMMUNITY_Decimator DSP|Decimator DSP]]
- [[_COMMUNITY_Butterworth Filter DSP|Butterworth Filter DSP]]
- [[_COMMUNITY_Spectrum Renderer|Spectrum Renderer]]
- [[_COMMUNITY_Shared Protocol Codec|Shared Protocol Codec]]
- [[_COMMUNITY_FFT History Buffer|FFT History Buffer]]
- [[_COMMUNITY_RTL-TCP Dongle Source|RTL-TCP Dongle Source]]
- [[_COMMUNITY_Noise Blanker DSP|Noise Blanker DSP]]
- [[_COMMUNITY_Tasks & Future Features|Tasks & Future Features]]
- [[_COMMUNITY_Shared ADPCM Codec|Shared ADPCM Codec]]
- [[_COMMUNITY_Admin Bookmarks Section|Admin Bookmarks Section]]
- [[_COMMUNITY_SAM Demodulator|SAM Demodulator]]
- [[_COMMUNITY_Admin Monitor Section|Admin Monitor Section]]
- [[_COMMUNITY_DSP Block Interfaces|DSP Block Interfaces]]
- [[_COMMUNITY_IQ Capture Scripts|IQ Capture Scripts]]
- [[_COMMUNITY_Dongle Source Interface|Dongle Source Interface]]
- [[_COMMUNITY_SolidJS HTML Entry|SolidJS HTML Entry]]
- [[_COMMUNITY_Spec Document|Spec Document]]
- [[_COMMUNITY_Design System Doc|Design System Doc]]
- [[_COMMUNITY_Apple Touch Icon|Apple Touch Icon]]
- [[_COMMUNITY_PWA Icon 192|PWA Icon 192]]
- [[_COMMUNITY_PWA Icon 512|PWA Icon 512]]
- [[_COMMUNITY_RDS VFO Work Notes|RDS VFO Work Notes]]
- [[_COMMUNITY_AGENTS Key Files|AGENTS Key Files]]
- [[_COMMUNITY_Noise Blanker Concept|Noise Blanker Concept]]

## God Nodes (most connected - your core abstractions)
1. `SdrEngine` - 90 edges
2. `Manager` - 59 edges
3. `NewRouterWithPath()` - 36 edges
4. `writeJSON()` - 35 edges
5. `abs()` - 32 edges
6. `NewIqExtractor()` - 29 edges
7. `Manager` - 28 edges
8. `AudioEngine` - 22 edges
9. `SpectrumRenderer` - 19 edges
10. `NewFftProcessor()` - 19 edges

## Surprising Connections (you probably didn't know these)
- `UI Screenshot: VFD Theme — Waterfall + Spectrum + EQ (no(sdr).jpeg)` --references--> `Design System Spec (AGENTS.md)`  [INFERRED]
  screenshots/no(sdr).jpeg → AGENTS.md
- `UI Screenshot: VFD Theme — Waterfall + Spectrum + EQ (no(sdr).jpeg)` --references--> `WaterfallDisplay (Canvas 2D, 5 color themes)`  [INFERRED]
  screenshots/no(sdr).jpeg → AGENTS.md
- `UI Screenshot: VFD Theme — Waterfall + Spectrum + EQ (no(sdr).jpeg)` --references--> `SpectrumRenderer (Canvas 2D, 30fps)`  [INFERRED]
  screenshots/no(sdr).jpeg → docs/no-sdr-spec-evaluation.md
- `UI Screenshot: VFD Theme — Waterfall + Spectrum + EQ (no(sdr).jpeg)` --references--> `AudioWorklet (5-band EQ, jitter buffer, low-latency playback)`  [INFERRED]
  screenshots/no(sdr).jpeg → AGENTS.md
- `UI Screenshot: LCD Theme — Waterfall + Demod Panel (no-sdr.jpeg)` --references--> `WaterfallDisplay (Canvas 2D, 5 color themes)`  [INFERRED]
  screenshots/no-sdr.jpeg → AGENTS.md

## Hyperedges (group relationships)
- **Per-Client IQ Processing Pipeline (NCO → Butterworth → Decimate → Codec → WS)** — concept_nco, concept_butterworth_filter, concept_iqextractor, concept_adpcm_codec, concept_ws_binary_protocol [EXTRACTED 0.95]
- **Shared FFT Broadcast Pipeline (FftProcessor → Codec → WebSocketManager → All Clients)** — concept_fftprocessor, concept_deflate_fft, concept_ws_manager, concept_waterfall_display [INFERRED 0.90]
- **Codec Evaluation Suite (IQ + FFT benchmarks → ADPCM retained, Deflate selected for FFT)** — doc_iq_compression_benchmark, doc_fft_compression_eval, concept_adpcm_codec, concept_deflate_fft [INFERRED 0.85]
- **FFT Processing Pipeline** — concept_dongle_source, concept_buffer_chunks, concept_fft_processor, concept_deflate_encoding, concept_websocket_msg_fft [EXTRACTED 0.95]
- **IQ Extraction Pipeline** — concept_dongle_source, concept_buffer_chunks, concept_iq_extractor, concept_client_demodulator [EXTRACTED 0.95]
- **System Architecture Layers** — concept_hardware_layer, concept_server_process, concept_dongle_manager, concept_fft_processor, concept_iq_extractor, concept_client [EXTRACTED 0.95]
- **WebSocket Protocol Messages** — concept_msg_meta, concept_msg_fft_deflate, concept_websocket_msg_fft [INFERRED 0.85]
- **PWA Application Icons** — favicon_svg, icon_192_maskable_png, icon_512_maskable_png [INFERRED 0.90]
- **UI Panel Components** — concept_ui_dashboard, concept_ui_controls, concept_ui_graph [EXTRACTED 0.90]

## Communities

### Community 0 - "Dongle Lifecycle & Pipeline"
Cohesion: 0.04
Nodes (36): activeDongle, clientPipeline, ConfigNotification, DongleInfo, DongleState, DongleStatus, Manager, NewManager() (+28 more)

### Community 1 - "Client Demodulators"
Cohesion: 0.04
Nodes (15): Agc, AmDemodulator, BiquadFilter, CQuamDemodulator, CwDemodulator, DcBlocker, Decimator, DeemphasisFilter (+7 more)

### Community 2 - "SDR Engine & Client Core"
Cohesion: 0.04
Nodes (3): getDemodulator(), SdrEngine, unpackBinaryMessage()

### Community 3 - "Docs & Design Specs"
Cohesion: 0.04
Nodes (75): Binary WebSocket Protocol Table (AGENTS.md), Design System Spec (AGENTS.md), Git Rules (AGENTS.md), Graphify Knowledge Graph Reference (AGENTS.md), AGENTS.md Onboarding Guide, Admin Panel (/admin route, CRUD for dongles and profiles), IMA-ADPCM Codec (4:1 lossy, both Go and TypeScript), AirSpy HF+ Source (implemented via hfp_tcp) (+67 more)

### Community 4 - "DSP FFT Core"
Cohesion: 0.05
Nodes (53): FFT, bitReversalPermute(), computeBitReversal(), computeTwiddles(), NewFFT(), NewFftProcessor(), abs(), clampByte() (+45 more)

### Community 5 - "Dongle Benchmarks"
Cohesion: 0.04
Nodes (43): BenchmarkNClientFanOutWFM(), BenchmarkPerClientIqExtractNFM(), BenchmarkPerClientIqExtractWFM(), BenchmarkSharedFftCost(), BenchmarkSingleClientFullNFM(), BenchmarkSingleClientFullWFM(), benchNClientFanOut(), int16SliceView() (+35 more)

### Community 6 - "Demodulator Benchmarks"
Cohesion: 0.05
Nodes (33): BenchmarkDemodPipeline(), BenchmarkFmMonoPipeline(), BenchmarkFmStereoPipeline(), BenchmarkFmStereoWithRds(), BenchmarkSsbPipeline(), generateTestIQ(), NewCwDemod(), CwDemod (+25 more)

### Community 7 - "ACR/API Metadata"
Cohesion: 0.04
Nodes (50): acrAlbum, acrArtist, acrExternalIDs, acrExtMeta, acrMeta, acrResponse, acrSong, acrStatus (+42 more)

### Community 8 - "AM/CQUAM Demodulation"
Cohesion: 0.05
Nodes (24): NewAmDemod(), BenchmarkAmDemod(), TestAmDemod(), TestAmDemodName(), TestCquamDemod(), TestCquamDemodName(), TestSamDemod(), TestSamDemodReset() (+16 more)

### Community 9 - "HTTP API Router"
Cohesion: 0.06
Nodes (40): NewRouter(), TestCORSHeaders(), TestDonglesEndpoint(), TestHealthEndpoint(), TestStatusEndpoint(), TestManagerNoDongles(), TestManagerSkipsDisabledDongle(), TestManagerStartStop() (+32 more)

### Community 10 - "Client Audio & FFT Workers"
Cohesion: 0.04
Nodes (4): HangAgc, AudioEngine, FftFrameBuffer, LmsAnr

### Community 11 - "Admin API Endpoints"
Cohesion: 0.1
Nodes (42): adminDonglesHandler(), bumpVersion(), createDongleHandler(), createProfileHandler(), deleteDongleHandler(), deleteProfileHandler(), dongleStartHandler(), dongleStopHandler() (+34 more)

### Community 12 - "RDS Decoder & Biquad"
Cohesion: 0.06
Nodes (34): BenchmarkRdsDecoder(), biphaseDecoder, biquadCoeffs, biquadState, blockSync, deltaDecoder, EonEntry, groupParser (+26 more)

### Community 13 - "Admin UI & ControlPanel"
Cohesion: 0.05
Nodes (14): barColor(), buildBgCache(), buildStaticCache(), busy(), dongle(), drawNeedleMeter(), handleAdd(), label() (+6 more)

### Community 14 - "Config & Bookmarks"
Cohesion: 0.06
Nodes (26): Bookmark, Config, applyDefaults(), applyProfileDefaults(), isPowerOf2(), Load(), NewConfigVersion(), TestDefaultValues() (+18 more)

### Community 15 - "SolidJS App Components"
Cohesion: 0.06
Nodes (19): state(), visible(), freqFromEvent(), handleSpectrumMouseDown(), handleSpectrumMouseMove(), handleSpectrumMouseUp(), handleSpectrumWheel(), handleWaterfallClick() (+11 more)

### Community 16 - "Client RDS Decoder"
Cohesion: 0.07
Nodes (13): BiphaseDecoder, Biquad, BlockSync, calculateSyndrome(), DeltaDecoder, emptyRdsData(), getOffsetForSyndrome(), GroupParser (+5 more)

### Community 17 - "Opus Codec"
Cohesion: 0.06
Nodes (8): NewOpusEncoder(), OpusAvailable(), TestNewOpusEncoder_StubReturnsError(), OpusEncoder, OpusEncoderConfig, OpusPacket, bench(), bench()

### Community 18 - "FFT Compression Codec"
Cohesion: 0.12
Nodes (27): CompressFft(), compressFftInto(), DeltaDecode(), DeltaEncode(), BenchmarkCompressFft65536(), BenchmarkDeflateFft65536(), BenchmarkFftDeflateEncoder65536(), inflateRaw() (+19 more)

### Community 19 - "System Architecture Diagrams"
Cohesion: 0.1
Nodes (33): Architecture Diagram (Simple), Buffer Chunks, Client (Browser), Client Demodulator, Deflate/Encoding Compression, Dongle Source, FFT Processor, Data Flow Sink Stage (+25 more)

### Community 20 - "Waterfall Renderer"
Cohesion: 0.08
Nodes (5): buildPalette(), getPalette(), WaterfallRenderer, buildPalette(), getPalette()

### Community 21 - "Audio Filters"
Cohesion: 0.09
Nodes (4): AutoNotch, biquadProcess(), HiBlendFilter, RumbleFilter

### Community 22 - "WebSocket Manager"
Cohesion: 0.09
Nodes (3): ClientInfo, Manager, PackCodecStatusMessage()

### Community 23 - "ADPCM Codec"
Cohesion: 0.14
Nodes (18): clampIndex(), clampInt16(), EncodeFftAdpcm(), NewImaAdpcmDecoder(), NewImaAdpcmEncoder(), BenchmarkDecode(), BenchmarkEncode(), BenchmarkEncodeFftAdpcm() (+10 more)

### Community 24 - "Noise Reduction"
Cohesion: 0.1
Nodes (4): fftInPlace(), NoiseBlanker, NoiseReductionEngine, SpectralNoiseReducer

### Community 25 - "Demo Signal Source"
Cohesion: 0.09
Nodes (14): clamp(), NewDemoSource(), TestDemoSource_Run_CancelStops(), TestDemoSource_Run_ProducesData(), TestNewDemoSource_CustomSignals(), TestNewDemoSource_Defaults(), DemoConfig, DemoSource (+6 more)

### Community 26 - "Decimator DSP"
Cohesion: 0.11
Nodes (10): decimator, passthrough, Pipeline, NewPipeline(), testLogger(), TestPipeline_ChainedDecimation(), TestPipeline_EmptyBlocksError(), TestPipeline_InvalidRateError() (+2 more)

### Community 27 - "Butterworth Filter DSP"
Cohesion: 0.14
Nodes (10): biquadCoeffs, biquadState, ButterworthBlock, computeBiquad(), NewButterworthBlock(), BenchmarkButterworth(), TestButterworth_DCPassthrough(), TestButterworth_HighFreqAttenuation() (+2 more)

### Community 28 - "Spectrum Renderer"
Cohesion: 0.13
Nodes (1): SpectrumRenderer

### Community 29 - "Shared Protocol Codec"
Cohesion: 0.17
Nodes (6): packAudioMessage(), packBinaryMessage(), packFftMessage(), packIqMessage(), packMetaMessage(), packRdsMessage()

### Community 30 - "FFT History Buffer"
Cohesion: 0.17
Nodes (9): NewFftBuffer(), TestConcurrentPushAndRead(), TestGetFramesInvalidRange(), TestGetFramesSubset(), TestGetFramesWithWrapAround(), TestGetRangeEmpty(), TestPushAndCount(), TestPushOverCapacity() (+1 more)

### Community 31 - "RTL-TCP Dongle Source"
Cohesion: 0.23
Nodes (1): RtlTcpSource

### Community 32 - "Noise Blanker DSP"
Cohesion: 0.18
Nodes (8): NewNoiseBlanker(), BenchmarkNoiseBlanker(), TestNoiseBlanker_DisabledPassesThrough(), TestNoiseBlanker_GuardWindow(), TestNoiseBlanker_ImpulseBlanked(), TestNoiseBlanker_NormalSignalPasses(), TestNoiseBlanker_Reset(), NoiseBlanker

### Community 33 - "Tasks & Future Features"
Cohesion: 0.15
Nodes (14): LMS ANR (recommended alternative to Wiener NR), SigMF IQ Recording Format (planned), Wiener Filter Spectral NR (robotic artifacts, candidate for replacement), Settings & Admin Panel Revamp Tasks (v2.2.0), TODO Future Features, Active Work Backlog (WORK.md), Audio Not Re-enabled After WS Reconnect Bug, Digital Decoder Future Features (DMR/DAB/NOAA/Meteor) (+6 more)

### Community 35 - "Shared ADPCM Codec"
Cohesion: 0.25
Nodes (4): decodeFftAdpcm(), encodeFftAdpcm(), ImaAdpcmDecoder, ImaAdpcmEncoder

### Community 36 - "Admin Bookmarks Section"
Cohesion: 0.25
Nodes (2): emptyBookmark(), generateId()

### Community 37 - "SAM Demodulator"
Cohesion: 0.36
Nodes (1): SamDemodulator

### Community 39 - "Admin Monitor Section"
Cohesion: 0.4
Nodes (2): ClientRow(), formatFrequency()

### Community 42 - "DSP Block Interfaces"
Cohesion: 0.4
Nodes (4): Block, BlockContext, ComplexToRealBlock, ProcessorBlock

### Community 43 - "IQ Capture Scripts"
Cohesion: 0.83
Nodes (3): capturePass(), getDongles(), main()

### Community 46 - "Dongle Source Interface"
Cohesion: 0.67
Nodes (2): CommandableSource, Source

### Community 48 - "SolidJS HTML Entry"
Cohesion: 1.0
Nodes (2): Client index.html (SolidJS Entry Point), SolidJS Frontend UI

### Community 57 - "Spec Document"
Cohesion: 1.0
Nodes (1): Project Specification

### Community 58 - "Design System Doc"
Cohesion: 1.0
Nodes (1): Project Design Document

### Community 59 - "Apple Touch Icon"
Cohesion: 1.0
Nodes (1): Apple Touch Icon (PWA)

### Community 60 - "PWA Icon 192"
Cohesion: 1.0
Nodes (1): 192x192 PWA Icon

### Community 61 - "PWA Icon 512"
Cohesion: 1.0
Nodes (1): 512x512 PWA Icon

### Community 62 - "RDS VFO Work Notes"
Cohesion: 1.0
Nodes (1): RDS Station Name in VFO Panel (v2.3.x)

### Community 63 - "AGENTS Key Files"
Cohesion: 1.0
Nodes (1): Key Files by Responsibility (AGENTS.md)

### Community 64 - "Noise Blanker Concept"
Cohesion: 1.0
Nodes (1): Noise Blanker (impulse noise reduction)

## Knowledge Gaps
- **119 isolated node(s):** `Config`, `Bookmark`, `ServerConfig`, `DongleConfig`, `SourceConfig` (+114 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Spectrum Renderer`** (18 nodes): `SpectrumRenderer`, `.constructor()`, `.draw()`, `.drawTuningIndicator()`, `.getZoom()`, `.isZoomed()`, `.lastPixelDb()`, `.peakDbValues()`, `.resetZoom()`, `.resize()`, `.setAccentColor()`, `.setNoiseFloor()`, `.setPause()`, `.setRange()`, `.setSignalFill()`, `.setSmoothing()`, `.setZoom()`, `.tooltipPeakDb()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RTL-TCP Dongle Source`** (15 nodes): `RtlTcpSource`, `.Close()`, `.Command()`, `.Connect()`, `.DongleInfo()`, `.Run()`, `.SetAgcMode()`, `.SetBiasT()`, `.SetDirectSampling()`, `.SetFrequency()`, `.SetFrequencyCorrection()`, `.SetGain()`, `.SetGainMode()`, `.SetOffsetTuning()`, `.SetSampleRate()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Admin Bookmarks Section`** (9 nodes): `BookmarksSection.tsx`, `emptyBookmark()`, `generateId()`, `handleAdd()`, `handleDelete()`, `handleSave()`, `handleUpdate()`, `modeInfo()`, `update()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `SAM Demodulator`** (9 nodes): `SamDemodulator`, `.computeLoopCoeffs()`, `.computeLpf()`, `.constructor()`, `.isLocked()`, `.process()`, `.reset()`, `.setBandwidth()`, `.setInputSampleRate()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Admin Monitor Section`** (6 nodes): `MonitorSection.tsx`, `ClientRow()`, `fetchData()`, `formatDuration()`, `formatFrequency()`, `StatCard()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Dongle Source Interface`** (3 nodes): `CommandableSource`, `Source`, `source.go`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `SolidJS HTML Entry`** (2 nodes): `Client index.html (SolidJS Entry Point)`, `SolidJS Frontend UI`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Spec Document`** (1 nodes): `Project Specification`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Design System Doc`** (1 nodes): `Project Design Document`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Apple Touch Icon`** (1 nodes): `Apple Touch Icon (PWA)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `PWA Icon 192`** (1 nodes): `192x192 PWA Icon`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `PWA Icon 512`** (1 nodes): `512x512 PWA Icon`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RDS VFO Work Notes`** (1 nodes): `RDS Station Name in VFO Panel (v2.3.x)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `AGENTS Key Files`** (1 nodes): `Key Files by Responsibility (AGENTS.md)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Noise Blanker Concept`** (1 nodes): `Noise Blanker (impulse noise reduction)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Manager` connect `Dongle Lifecycle & Pipeline` to `AM/CQUAM Demodulation`, `ADPCM Codec`?**
  _High betweenness centrality (0.104) - this node is a cross-community bridge._
- **Why does `main()` connect `Config & Bookmarks` to `Dongle Lifecycle & Pipeline`, `ACR/API Metadata`, `HTTP API Router`, `Admin API Endpoints`, `RDS Decoder & Biquad`, `Opus Codec`?**
  _High betweenness centrality (0.081) - this node is a cross-community bridge._
- **Why does `NewIqExtractor()` connect `Dongle Benchmarks` to `Dongle Lifecycle & Pipeline`, `Noise Blanker DSP`, `DSP FFT Core`, `Demodulator Benchmarks`, `Decimator DSP`, `Butterworth Filter DSP`?**
  _High betweenness centrality (0.078) - this node is a cross-community bridge._
- **Are the 30 inferred relationships involving `NewRouterWithPath()` (e.g. with `main()` and `NewRateLimiter()`) actually correct?**
  _`NewRouterWithPath()` has 30 INFERRED edges - model-reasoned connections that need verification._
- **Are the 30 inferred relationships involving `writeJSON()` (e.g. with `systemInfoHandler()` and `clientsHandler()`) actually correct?**
  _`writeJSON()` has 30 INFERRED edges - model-reasoned connections that need verification._
- **Are the 27 inferred relationships involving `abs()` (e.g. with `.push()` and `TestAmDemod()`) actually correct?**
  _`abs()` has 27 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Config`, `Bookmark`, `ServerConfig` to the rest of the system?**
  _119 weakly-connected nodes found - possible documentation gaps or missing edges._