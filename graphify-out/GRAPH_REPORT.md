# Graph Report - .  (2026-04-30)

## Corpus Check
- 78 files · ~257,587 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 869 nodes · 1221 edges · 34 communities detected
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 51 edges (avg confidence: 0.81)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Client Demodulators (AMFMSSB)|Client Demodulators (AM/FM/SSB)]]
- [[_COMMUNITY_Server Core Modules|Server Core Modules]]
- [[_COMMUNITY_SDR Engine & Client Orchestration|SDR Engine & Client Orchestration]]
- [[_COMMUNITY_UI Components & App Shell|UI Components & App Shell]]
- [[_COMMUNITY_Binary Protocol & Codec Pack|Binary Protocol & Codec Pack]]
- [[_COMMUNITY_Hardware Integration & Docs|Hardware Integration & Docs]]
- [[_COMMUNITY_Dongle Manager & Signal Sim|Dongle Manager & Signal Sim]]
- [[_COMMUNITY_Server RDS Decoder|Server RDS Decoder]]
- [[_COMMUNITY_Client RDS Decoder|Client RDS Decoder]]
- [[_COMMUNITY_Waterfall & Palette Rendering|Waterfall & Palette Rendering]]
- [[_COMMUNITY_Audio Filters (Auto-NotchLMS)|Audio Filters (Auto-Notch/LMS)]]
- [[_COMMUNITY_FFTIQ Compression Benchmarks|FFT/IQ Compression Benchmarks]]
- [[_COMMUNITY_Control Panel UI|Control Panel UI]]
- [[_COMMUNITY_Noise Reduction (Spectral NRNB)|Noise Reduction (Spectral NR/NB)]]
- [[_COMMUNITY_Waterfall Display Component|Waterfall Display Component]]
- [[_COMMUNITY_Spectrum Renderer|Spectrum Renderer]]
- [[_COMMUNITY_UI Screenshots & Diagrams|UI Screenshots & Diagrams]]
- [[_COMMUNITY_Decoder Manager (Digital Modes)|Decoder Manager (Digital Modes)]]
- [[_COMMUNITY_IQ Extractor (NCOButterworth)|IQ Extractor (NCO/Butterworth)]]
- [[_COMMUNITY_FFT History Buffer|FFT History Buffer]]
- [[_COMMUNITY_SAM Demodulator (PLL)|SAM Demodulator (PLL)]]
- [[_COMMUNITY_LMS Adaptive NR|LMS Adaptive NR]]
- [[_COMMUNITY_FFT Processor|FFT Processor]]
- [[_COMMUNITY_App Branding & Icons|App Branding & Icons]]
- [[_COMMUNITY_Architecture Diagrams|Architecture Diagrams]]
- [[_COMMUNITY_IQ Capture Script|IQ Capture Script]]
- [[_COMMUNITY_Protocol Flow Diagrams|Protocol Flow Diagrams]]
- [[_COMMUNITY_SpyServer & Multi-User|SpyServer & Multi-User]]
- [[_COMMUNITY_Design & Theming|Design & Theming]]
- [[_COMMUNITY_Reference Implementations|Reference Implementations]]
- [[_COMMUNITY_Data Flow Diagrams|Data Flow Diagrams]]
- [[_COMMUNITY_SolidJS Store|SolidJS Store]]
- [[_COMMUNITY_Airspy CLI Source|Airspy CLI Source]]
- [[_COMMUNITY_Active TODOs|Active TODOs]]

## God Nodes (most connected - your core abstractions)
1. `SdrEngine` - 87 edges
2. `DongleManager` - 32 edges
3. `WebSocketManager` - 28 edges
4. `AudioEngine` - 21 edges
5. `SpectrumRenderer` - 19 edges
6. `WaterfallRenderer` - 17 edges
7. `FmDemodulator` - 15 edges
8. `OpusAudioPipeline` - 12 edges
9. `CQuamDemodulator` - 12 edges
10. `DecoderManager` - 11 edges

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

### Community 0 - "Client Demodulators (AM/FM/SSB)"
Cohesion: 0.04
Nodes (15): Agc, AmDemodulator, BiquadFilter, CQuamDemodulator, CwDemodulator, DcBlocker, Decimator, DeemphasisFilter (+7 more)

### Community 1 - "Server Core Modules"
Cohesion: 0.03
Nodes (20): getDefaultConfig(), loadConfig(), writeDefaultConfig(), adminAuth(), generateSessionToken(), isValidSessionToken(), AmMonoDemod, Biquad (+12 more)

### Community 2 - "SDR Engine & Client Orchestration"
Cohesion: 0.04
Nodes (3): getDemodulator(), SdrEngine, unpackBinaryMessage()

### Community 3 - "UI Components & App Shell"
Cohesion: 0.03
Nodes (9): HangAgc, AudioEngine, FftFrameBuffer, cpu(), cpuColor(), history(), isLast(), createStore() (+1 more)

### Community 4 - "Binary Protocol & Codec Pack"
Cohesion: 0.09
Nodes (17): getOutputSampleRate(), compressFft(), packAudioMessage(), packAudioOpusMessage(), packBinaryMessage(), packCompressedFftMessage(), packFftAdpcmMessage(), packFftDeflateMessage() (+9 more)

### Community 5 - "Hardware Integration & Docs"
Cohesion: 0.06
Nodes (44): Client index.html Entry Point, FFT Compression Evaluation, airspy_tcp Source, HackRF One (CLI), hfp_tcp Source, Hardware Integration Roadmap, LimeSDR (SoapySDR), PlutoSDR (ADALM-PLUTO) (+36 more)

### Community 6 - "Dongle Manager & Signal Sim"
Cohesion: 0.07
Nodes (6): DongleManager, createAviationSimulation(), createFmBroadcastSimulation(), createTwoMeterSimulation(), getSimulationForProfile(), SignalSimulator

### Community 7 - "Server RDS Decoder"
Cohesion: 0.07
Nodes (13): BiphaseDecoder, Biquad, BlockSync, calculateSyndrome(), DeltaDecoder, emptyRdsData(), getOffsetForSyndrome(), GroupParser (+5 more)

### Community 8 - "Client RDS Decoder"
Cohesion: 0.07
Nodes (13): BiphaseDecoder, Biquad, BlockSync, calculateSyndrome(), DeltaDecoder, emptyRdsData(), getOffsetForSyndrome(), GroupParser (+5 more)

### Community 9 - "Waterfall & Palette Rendering"
Cohesion: 0.08
Nodes (5): buildPalette(), getPalette(), WaterfallRenderer, buildPalette(), getPalette()

### Community 10 - "Audio Filters (Auto-Notch/LMS)"
Cohesion: 0.09
Nodes (4): AutoNotch, biquadProcess(), HiBlendFilter, RumbleFilter

### Community 11 - "FFT/IQ Compression Benchmarks"
Cohesion: 0.08
Nodes (6): bench(), bench(), decodeFftAdpcm(), encodeFftAdpcm(), ImaAdpcmDecoder, ImaAdpcmEncoder

### Community 12 - "Control Panel UI"
Cohesion: 0.08
Nodes (5): barColor(), buildBgCache(), buildStaticCache(), drawNeedleMeter(), pct()

### Community 13 - "Noise Reduction (Spectral NR/NB)"
Cohesion: 0.1
Nodes (4): fftInPlace(), NoiseBlanker, NoiseReductionEngine, SpectralNoiseReducer

### Community 14 - "Waterfall Display Component"
Cohesion: 0.14
Nodes (11): freqFromEvent(), handleSpectrumMouseDown(), handleSpectrumMouseMove(), handleSpectrumMouseUp(), handleSpectrumWheel(), handleWaterfallClick(), handleWaterfallMouseMove(), handleWaterfallWheel() (+3 more)

### Community 15 - "Spectrum Renderer"
Cohesion: 0.13
Nodes (1): SpectrumRenderer

### Community 16 - "UI Screenshots & Diagrams"
Cohesion: 0.12
Nodes (17): FFT Compression Workflow Diagram, FFT Domain Lossless Diagram, No-SDR UI Layout Diagram, Node-SDR Compression Panel Screenshot, Node-SDR Main UI Screenshot, 5-Band Parametric Equalizer (Knobs), Audio Controls Panel (Volume/Balance/EQ), Compression Codec Selector Panel (+9 more)

### Community 18 - "Decoder Manager (Digital Modes)"
Cohesion: 0.25
Nodes (1): DecoderManager

### Community 19 - "IQ Extractor (NCO/Butterworth)"
Cohesion: 0.29
Nodes (3): biquadProcess(), designButterworth4(), IqExtractor

### Community 20 - "FFT History Buffer"
Cohesion: 0.28
Nodes (1): FftHistoryBuffer

### Community 21 - "SAM Demodulator (PLL)"
Cohesion: 0.36
Nodes (1): SamDemodulator

### Community 22 - "LMS Adaptive NR"
Cohesion: 0.25
Nodes (1): LmsAnr

### Community 23 - "FFT Processor"
Cohesion: 0.43
Nodes (1): FftProcessor

### Community 25 - "App Branding & Icons"
Cohesion: 0.33
Nodes (6): Apple Touch Icon, Node-SDR Favicon (Radio Wave Logo), PWA Maskable Icon 192px, PWA Icon 192px, PWA Maskable Icon 512px, PWA Icon 512px

### Community 26 - "Architecture Diagrams"
Cohesion: 0.6
Nodes (6): Client (SolidJS Browser App), DongleManager, FFT / IQ Extractor, Hardware Layer (RTL-SDR), Server Process (Node.js/Hono), Architecture Diagram

### Community 27 - "IQ Capture Script"
Cohesion: 0.83
Nodes (3): capturePass(), getDongles(), main()

### Community 29 - "Protocol Flow Diagrams"
Cohesion: 0.67
Nodes (3): REST API Flow Diagram, Session Flow Diagram, WebSocket Protocol Diagram

### Community 30 - "SpyServer & Multi-User"
Cohesion: 1.0
Nodes (2): SpyServer Protocol, Multi-User Scaling Model

### Community 31 - "Design & Theming"
Cohesion: 1.0
Nodes (2): Spotify-Inspired Design System, Theming System

### Community 32 - "Reference Implementations"
Cohesion: 1.0
Nodes (2): gqrx AGC Implementation, Hang-Timer AGC

### Community 33 - "Data Flow Diagrams"
Cohesion: 1.0
Nodes (2): Data Flow Diagram, No-SDR Data Flow Diagram

### Community 38 - "SolidJS Store"
Cohesion: 1.0
Nodes (1): SolidJS Store

### Community 39 - "Airspy CLI Source"
Cohesion: 1.0
Nodes (1): AirSpy CLI Source

### Community 40 - "Active TODOs"
Cohesion: 1.0
Nodes (1): Active Tasks (TODO)

## Knowledge Gaps
- **51 isolated node(s):** `WebSocket Binary Protocol`, `DecoderManager`, `WaterfallRenderer`, `SpectrumRenderer`, `SolidJS Store` (+46 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Spectrum Renderer`** (18 nodes): `SpectrumRenderer`, `.constructor()`, `.draw()`, `.drawTuningIndicator()`, `.getZoom()`, `.isZoomed()`, `.lastPixelDb()`, `.peakDbValues()`, `.resetZoom()`, `.resize()`, `.setAccentColor()`, `.setNoiseFloor()`, `.setPause()`, `.setRange()`, `.setSignalFill()`, `.setSmoothing()`, `.setZoom()`, `.tooltipPeakDb()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Decoder Manager (Digital Modes)`** (11 nodes): `DecoderManager`, `.checkAllBinaries()`, `.checkBinaryAvailable()`, `.feedIqData()`, `.getRunningDecoders()`, `.handleDecoderExit()`, `.spawnDecoder()`, `.startDecoder()`, `.stopAll()`, `.stopDecoder()`, `.stopDongleDecoders()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `FFT History Buffer`** (9 nodes): `fft-history.ts`, `FftHistoryBuffer`, `.computeSrcRanges()`, `.constructor()`, `.count()`, `.getFrames()`, `.push()`, `.reset()`, `.setLiveBinCount()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `SAM Demodulator (PLL)`** (9 nodes): `SamDemodulator`, `.computeLoopCoeffs()`, `.computeLpf()`, `.constructor()`, `.isLocked()`, `.process()`, `.reset()`, `.setBandwidth()`, `.setInputSampleRate()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `LMS Adaptive NR`** (9 nodes): `lms-anr.ts`, `LmsAnr`, `.constructor()`, `.isEnabled()`, `.process()`, `.reset()`, `.setEnabled()`, `.setOptions()`, `.setPreset()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `FFT Processor`** (8 nodes): `FftProcessor`, `.computeNormalization()`, `.constructor()`, `.createWindow()`, `.processIqData()`, `.processOneFrame()`, `.reset()`, `.resize()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `SpyServer & Multi-User`** (2 nodes): `SpyServer Protocol`, `Multi-User Scaling Model`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Design & Theming`** (2 nodes): `Spotify-Inspired Design System`, `Theming System`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Reference Implementations`** (2 nodes): `gqrx AGC Implementation`, `Hang-Timer AGC`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Data Flow Diagrams`** (2 nodes): `Data Flow Diagram`, `No-SDR Data Flow Diagram`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `SolidJS Store`** (1 nodes): `SolidJS Store`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Airspy CLI Source`** (1 nodes): `AirSpy CLI Source`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Active TODOs`** (1 nodes): `Active Tasks (TODO)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `SdrEngine` connect `SDR Engine & Client Orchestration` to `UI Components & App Shell`?**
  _High betweenness centrality (0.382) - this node is a cross-community bridge._
- **Why does `WebSocketManager` connect `Binary Protocol & Codec Pack` to `Server Core Modules`?**
  _High betweenness centrality (0.317) - this node is a cross-community bridge._
- **Why does `unpackBinaryMessage()` connect `SDR Engine & Client Orchestration` to `Binary Protocol & Codec Pack`?**
  _High betweenness centrality (0.276) - this node is a cross-community bridge._
- **What connects `WebSocket Binary Protocol`, `DecoderManager`, `WaterfallRenderer` to the rest of the system?**
  _51 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Client Demodulators (AM/FM/SSB)` be split into smaller, more focused modules?**
  _Cohesion score 0.04 - nodes in this community are weakly interconnected._
- **Should `Server Core Modules` be split into smaller, more focused modules?**
  _Cohesion score 0.03 - nodes in this community are weakly interconnected._
- **Should `SDR Engine & Client Orchestration` be split into smaller, more focused modules?**
  _Cohesion score 0.04 - nodes in this community are weakly interconnected._