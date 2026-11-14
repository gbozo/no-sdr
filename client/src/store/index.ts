// ============================================================
// node-sdr — SolidJS State Store
// ============================================================
// UI-only reactive state using SolidJS signals.
// FFT/audio data bypasses this entirely (imperative canvas/audio).
// ============================================================

import { createSignal, createRoot } from 'solid-js';
import type {
  CodecType,
  FftCodecType,
  IqCodecType,
  DemodMode,
  WaterfallColorTheme,
  UITheme,
  DongleInfo,
  DongleProfile,
  PushDongleInfo,
  PushServerConfig,
  AdsbAircraft,
  AdsbSnapshot,
  AcarsMessage,
  AcarsStatus,
  AisVessel,
  AisSnapshot,
  Vdl2Message,
  Vdl2Station,
  Vdl2Snapshot,
  HfdlDecode,
  HfdlSnapshot,
  AprsPacket,
  AprsStatus,
  NavtexMessage,
  NavtexStatus,
  IsmDevice,
  IsmStatus,
  PacketFrame,
  PacketStatus,
  WefaxImage,
  WefaxStatus,
  TimeSignalClock,
  TimeSignalStatus,
  SstvImage,
  SstvStatus,
  HellStatus,
  TextModeMessage,
  TextModeStatus,
  MeteorMessage,
  MeteorStatus,
  Js8Message,
  Js8Status,
} from '~/shared';

// All codecs supported by the client (used as fallback when server doesn't send allowedCodecs)
const ALL_FFT_CODECS: FftCodecType[] = ['none', 'adpcm', 'deflate', 'deflate-floor'];
const ALL_IQ_CODECS: IqCodecType[] = ['none', 'adpcm', 'opus-lo', 'opus', 'opus-hq'];

// ---- Bookmark type (client localStorage) ----
export interface Bookmark {
  id: string;
  label: string;
  hz: number;
  mode: DemodMode;
  bandwidth: number;
  /** Foreground decoder to restore ('' / undefined = audio only). */
  decoder?: string;
}

// ---- Admin bookmark type (server config, fetched from /api/bookmarks) ----
export interface AdminBookmark {
  id: string;
  name: string;
  frequency: number; // Hz
  mode: string;
  bandwidth?: number;
  description?: string;
  /** "config" = from config.yaml, "file" = from bookmarks directory */
  source?: 'config' | 'file';
  /** Whether the client can actually demodulate this mode */
  implemented?: boolean;
}

// ---- localStorage persistence helper ----
const NS = 'node-sdr:';

function persist<T>(key: string, defaultValue: T): [() => T, (v: T) => void] {
  let stored: T = defaultValue;
  try {
    const raw = localStorage.getItem(NS + key);
    if (raw !== null) stored = JSON.parse(raw) as T;
  } catch { /* ignore parse errors, use default */ }
  const [get, setRaw] = createSignal<T>(stored);
  const set = (v: T) => {
    setRaw(() => v);
    try { localStorage.setItem(NS + key, JSON.stringify(v)); } catch { /* quota exceeded etc */ }
  };
  return [get, set];
}

function createStore() {
  // ---- Connection State ----
  const [connected, setConnected] = createSignal(false);
  const [clientId, setClientId] = createSignal('');

  // ---- Persistent client ID (server-assigned UUID, survives page refresh) ----
  // Empty string means "no ID yet" — server will generate one on first connect.
  const [localClientId, setLocalClientId] = persist<string>('clientId', '');
  // Connection index — identifies this tab among multiple connections for same UUID
  const [connIndex, setConnIndex] = createSignal(0);

  // ---- Dongle / Profile ----
  const [dongles, setDongles] = createSignal<DongleInfo[]>([]);
  const [activeDongleId, setActiveDongleId] = createSignal('');
  const [activeProfile, setActiveProfile] = createSignal<DongleProfile | null>(null);
  const [activeProfileId, setActiveProfileId] = createSignal('');
  const [profiles, setProfiles] = createSignal<DongleProfile[]>([]);

  // ---- Push-based dongle state (from WS notifications) ----
  const [pushDongles, setPushDongles] = createSignal<PushDongleInfo[]>([]);
  const [pushServerConfig, setPushServerConfig] = createSignal<PushServerConfig | null>(null);
  const [configVersion, setConfigVersion] = createSignal(0);
  // Connection state: 'connecting' | 'connected' | 'disconnected' | 'unconfigured'
  const [connectionState, setConnectionState] = createSignal<'connecting' | 'connected' | 'disconnected' | 'unconfigured'>('disconnected');
  // Server version reported in the WELCOME META message.
  const [serverVersion, setServerVersion] = createSignal('');
  // Reconnect attempt counter (0 = not reconnecting, >0 = attempt N of max)
  const [reconnectAttempt, setReconnectAttempt] = createSignal(0);

  // ---- Tuning ----
  const [centerFrequency, setCenterFrequency] = createSignal(100_000_000);
  const [sampleRate, setSampleRate] = createSignal(2_400_000);
  const [iqSampleRate, setIqSampleRate] = createSignal(240_000); // IQ sub-band rate from server
  const [tuneOffset, setTuneOffset] = createSignal(0);
  const [mode, setMode] = createSignal<DemodMode>('nfm');
  const [bandwidth, setBandwidth] = createSignal(12_500);
  /** Foreground digital decoder: '' = audio, otherwise a decoder mode id. */
  const [decoderMode, setDecoderMode] = createSignal('');
  const [decoderMessages, setDecoderMessages] = createSignal<
    { decoderType: string; data: Record<string, unknown>; receivedAt: number }[]
  >([]);
  /** Latest ADS-B aircraft table (replaced whole on each snapshot). */
  const [adsbAircraft, setAdsbAircraft] = createSignal<AdsbAircraft[]>([]);
  /** ADS-B receiver diagnostics; null until the first snapshot. */
  const [adsbStatus, setAdsbStatus] = createSignal<Omit<AdsbSnapshot, 'aircraft'> | null>(null);
  /** Latest ACARS messages (newest first) and receiver diagnostics. */
  const [acarsMessages, setAcarsMessages] = createSignal<AcarsMessage[]>([]);
  const [acarsStatus, setAcarsStatus] = createSignal<AcarsStatus>({
    frames: 0,
    bad: 0,
    level: 0,
  });
  /** Latest AIS vessel table and receiver diagnostics. */
  const [aisVessels, setAisVessels] = createSignal<AisVessel[]>([]);
  const [aisStatus, setAisStatus] = createSignal<Omit<AisSnapshot, 'vessels'> | null>(null);
  /** Latest VDL2 message log, station table and diagnostics. */
  const [vdl2Messages, setVdl2Messages] = createSignal<Vdl2Message[]>([]);
  const [vdl2Stations, setVdl2Stations] = createSignal<Vdl2Station[]>([]);
  const [vdl2Status, setVdl2Status] = createSignal<Omit<Vdl2Snapshot, 'messages' | 'stations'> | null>(null);
  /** Latest HFDL decode log and receiver diagnostics. */
  const [hfdlLog, setHfdlLog] = createSignal<HfdlDecode[]>([]);
  const [hfdlStatus, setHfdlStatus] = createSignal<Omit<HfdlSnapshot, 'log'> | null>(null);
  /** Latest APRS packets and receiver diagnostics. */
  const [aprsPackets, setAprsPackets] = createSignal<AprsPacket[]>([]);
  const [aprsStatus, setAprsStatus] = createSignal<AprsStatus>({
    frames: 0,
    badFcs: 0,
    nonAprs: 0,
    level: 0,
  });
  /** Latest NAVTEX messages and SITOR-B receiver diagnostics. */
  const [navtexMessages, setNavtexMessages] = createSignal<NavtexMessage[]>([]);
  const [navtexStatus, setNavtexStatus] = createSignal<NavtexStatus>({
    inSync: false,
    level: 0,
    reverse: false,
    direct: 0,
    repaired: 0,
    lost: 0,
    messages: 0,
    live: null,
  });
  /** Latest ISM device table and channel diagnostics. */
  const [ismDevices, setIsmDevices] = createSignal<IsmDevice[]>([]);
  const [ismStatus, setIsmStatus] = createSignal<IsmStatus | null>(null);
  /** Latest AX.25 packet monitor frames and modem diagnostics. */
  const [packetFrames, setPacketFrames] = createSignal<PacketFrame[]>([]);
  const [packetStatus, setPacketStatus] = createSignal<PacketStatus>({
    frames: 0,
    badFcs: 0,
    nonAx25: 0,
    level: 0,
    baud: 1200,
  });
  /** Current WEFAX image, grown line by line, and receiver diagnostics. */
  const [wefaxImage, setWefaxImage] = createSignal<WefaxImage | null>(null);
  const [wefaxStatus, setWefaxStatus] = createSignal<WefaxStatus>({
    receiving: false,
    phasing: false,
    lines: 0,
    ioc: 'IOC 576',
    lpm: 120,
    signal: 0,
    subcarrierHz: 0,
    slantPpm: 0,
    imageId: 0,
    width: 0,
    height: 0,
  });
  /** SSTV received images, newest first; the first is the live/current picture. */
  const [sstvImages, setSstvImages] = createSignal<SstvImage[]>([]);
  const [sstvStatus, setSstvStatus] = createSignal<SstvStatus>({
    receiving: false,
    progress: 0,
    signal: 0,
    imageId: 0,
    mode: null,
    width: 0,
    height: 0,
    callsign: null,
    unsupported: null,
  });
  /** Hellschreiber scrolling dot columns, oldest first, and receiver status. */
  const [hellColumns, setHellColumns] = createSignal<Uint8Array[]>([]);
  const [hellStatus, setHellStatus] = createSignal<HellStatus>({
    receiving: false,
    variant: 'FELD',
    columns: 0,
    seq: 0,
    level: 0,
    audioHz: 1500,
  });
  /** Continuous keyboard-mode text (Olivia / THOR / FSQ), oldest first. */
  const [textMessages, setTextMessages] = createSignal<TextModeMessage[]>([]);
  const [textStatus, setTextStatus] = createSignal<TextModeStatus>({
    mode: '',
    level: 0,
    audioHz: 1500,
    listening: false,
  });
  /** Meteor-scatter decodes (MSK144 / FSK441), newest first. */
  const [meteorMessages, setMeteorMessages] = createSignal<MeteorMessage[]>([]);
  const [meteorStatus, setMeteorStatus] = createSignal<MeteorStatus>({
    mode: '',
    level: 0,
    audioHz: 1500,
    period: 15,
    decodes: 0,
    listening: false,
  });
  /** JS8 messages, newest first, and the last station/status snapshot. */
  const [js8Messages, setJs8Messages] = createSignal<Js8Message[]>([]);
  const [js8Status, setJs8Status] = createSignal<Js8Status>({
    speed: 'normal',
    period: 15,
    level: 0,
    decodes: 0,
    listening: false,
    heard: [],
  });
  /** DCF77 / ALS162 decoded clock and receiver status. */
  const [timeSignalClock, setTimeSignalClock] = createSignal<TimeSignalClock | null>(null);
  const [timeSignalStatus, setTimeSignalStatus] = createSignal<TimeSignalStatus>({
    mode: '',
    sync: false,
    bits: 0,
    level: 0,
    listening: false,
    time: null,
  });
  /** Tuning step in Hz. 0 = auto (use bandwidth). User can override. */
  const [tuningStep, setTuningStep] = createSignal(0);

  // Computed: actual tuned frequency
  const tunedFrequency = () => centerFrequency() + tuneOffset();

  // ---- Audio ----
  const [volume, setVolume] = persist<number>('audio.volume', 0.8);
  const [muted, setMuted] = createSignal(false);
  const [squelch, setSquelch] = persist<number | null>('audio.squelch', null);
  const [signalLevel, setSignalLevel] = createSignal(-120); // dB
  const [snr, setSnr] = createSignal(0); // dB, FFT-derived
  const [stereoDetected, setStereoDetected] = createSignal(false);
  const [stereoEnabled, setStereoEnabled] = persist<boolean>('audio.stereoEnabled', true);
  const [stereoThreshold, setStereoThreshold] = persist<number>('audio.stereoThreshold', -60);
  const [balance, setBalance] = persist<number>('audio.balance', 0);
  const [eqLow, setEqLow] = persist<number>('audio.eqLow', 0);
  const [eqLowMid, setEqLowMid] = persist<number>('audio.eqLowMid', 0);
  const [eqMid, setEqMid] = persist<number>('audio.eqMid', 0);
  const [eqHighMid, setEqHighMid] = persist<number>('audio.eqHighMid', 0);
  const [eqHigh, setEqHigh] = persist<number>('audio.eqHigh', 0);
  const [loudness, setLoudness] = persist<boolean>('audio.loudness', false);

  // ---- Noise Reduction ----
  const [nrEnabled, setNrEnabled] = persist<boolean>('audio.nrEnabled', false);
  const [nrStrength, setNrStrength] = persist<number>('audio.nrStrength', 0.5);
  const [nbEnabled, setNbEnabled] = persist<boolean>('audio.nbEnabled', false);
  const [nbLevel, setNbLevel] = persist<number>('audio.nbLevel', 0.5);

  // ---- AGC ----
  const [agcEnabled, setAgcEnabled] = persist<boolean>('audio.agcEnabled', true);
  const [agcDecayMs, setAgcDecayMs] = persist<number>('audio.agcDecayMs', 250);

  // ---- Audio Filters ----
  const [rumbleFilterEnabled, setRumbleFilterEnabled] = persist<boolean>('audio.rumbleFilter', false);
  const [rumbleFilterCutoff, setRumbleFilterCutoff] = persist<number>('audio.rumbleCutoff', 65);
  const [autoNotchEnabled, setAutoNotchEnabled] = persist<boolean>('audio.autoNotch', false);
  const [hiBlendEnabled, setHiBlendEnabled] = persist<boolean>('audio.hiBlend', false);
  const [hiBlendCutoff, setHiBlendCutoff] = persist<number>('audio.hiBlendCutoff', 2500);
  /** Track signal level: strong signals keep stereo, weak ones fade to mono. */
  const [hiBlendAuto, setHiBlendAuto] = persist<boolean>('audio.hiBlendAuto', false);
  /** Live cutoff when auto hi-blend is on (not persisted: updated per level tick). */
  const [hiBlendAutoCutoff, setHiBlendAutoCutoff] = createSignal(2500);
  const [softMuteEnabled, setSoftMuteEnabled] = persist<boolean>('audio.softMute', false);
  /** Soft mute threshold in dB — below this level, volume is progressively reduced */
  const [softMuteThreshold, setSoftMuteThreshold] = persist<number>('audio.softMuteThreshold', -40);
  /** FM de-emphasis time constant: 75 µs (Americas) or 50 µs (Europe/Asia). */
  const [deemphasisUs, setDeemphasisUs] = persist<number>('audio.deemphasisUs', 75);

  // ---- Display ----
  const [waterfallTheme, setWaterfallTheme] = persist<WaterfallColorTheme>('waterfallTheme', 'classic');
  const [uiTheme, setUITheme] = persist<UITheme>('uiTheme', 'vfd');
  const [waterfallMin, setWaterfallMin] = createSignal(-60);
  const [waterfallMax, setWaterfallMax] = createSignal(-10);
  const [waterfallAutoRange, setWaterfallAutoRange] = createSignal(true);
  const [waterfallGamma, setWaterfallGamma] = persist<number>('waterfallGamma', 1.0);
  const [waterfallSpeed, setWaterfallSpeed] = createSignal(30); // fps
  const [fftSize, setFftSize] = createSignal(2048);

  // ---- Audio Start State ----
  // Persisted so HMR/reconnect can restore audio without another user gesture.
  const [audioStarted, setAudioStarted] = persist<boolean>('audio.started', false);
  // Non-persisted: true only once AudioContext is actually running this session.
  const [audioRunning, setAudioRunning] = createSignal(false);

  // ---- UI State ----
  const [sidebarOpen, setSidebarOpen] = createSignal(true);
  const [decoderPanelOpen, setDecoderPanelOpen] = createSignal(false);
  const [analysisPanelOpen, setAnalysisPanelOpen] = createSignal(false);
  const [isAdmin, setIsAdmin] = createSignal(false);
  const [adminSection, setAdminSection] = createSignal<'dongles' | 'profiles' | 'server'>('dongles');
  const [meterStyle, setMeterStyle] = persist<'bar' | 'needle'>('meterStyle', 'needle');
  const [audioSpectrumVisible, setAudioSpectrumVisible] = persist<boolean>('audioSpectrumVisible', true);
  const [spectrumPeakHold, setSpectrumPeakHold] = persist<boolean>('spectrumPeakHold', false);
  const [spectrumSignalFill, setSpectrumSignalFill] = persist<boolean>('spectrumSignalFill', false);
  const [spectrumPaused, setSpectrumPaused] = createSignal(false);
  const [spectrumAveraging, setSpectrumAveraging] = persist<'fast' | 'med' | 'slow'>('spectrumAveraging', 'fast');
  const [spectrumNoiseFloor, setSpectrumNoiseFloor] = persist<boolean>('spectrumNoiseFloor', false);
  // Zoom viewport [start, end] as fractions of full bandwidth 0..1
  const [spectrumZoom, setSpectrumZoom] = createSignal<[number, number]>([0, 1]);
  const [spectrumRangeSelect, setSpectrumRangeSelect] = createSignal(false);
  // Signal markers: array of absolute Hz frequencies
  const [signalMarkers, setSignalMarkers] = createSignal<number[]>([]);

  // ---- Frequency Bookmarks (localStorage-persisted) ----
  const [bookmarksRaw, setBookmarksRaw] = persist<Bookmark[]>('bookmarks', []);
  const setBookmarks = (bm: Bookmark[]) => {
    setBookmarksRaw(bm);
    // Keep signal markers in sync with bookmark frequencies
    setSignalMarkers(bm.map(b => b.hz));
  };
  const bookmarks = bookmarksRaw;
  // Init markers from stored bookmarks on load
  setSignalMarkers(bookmarksRaw().map(b => b.hz));

  // ---- Admin Bookmarks (fetched from /api/bookmarks after connect) ----
  const [adminBookmarks, setAdminBookmarks] = createSignal<AdminBookmark[]>([]);

  // ---- Codec Preferences (localStorage-persisted) ----
  const [fftCodec, setFftCodec] = persist<FftCodecType>('codec.fft', 'deflate-floor');
  const [iqCodec, setIqCodec] = persist<IqCodecType>('codec.iq', 'opus');

  // ---- Available Codecs (from server 'welcome' message) ----
  // Initialized to all codecs; restricted by server on connect.
  const [availableFftCodecs, setAvailableFftCodecs] = createSignal<FftCodecType[]>(ALL_FFT_CODECS);
  const [availableIqCodecs, setAvailableIqCodecs] = createSignal<IqCodecType[]>(ALL_IQ_CODECS);

  // ---- Bandwidth / Throughput Metrics ----
  const [fftRate, setFftRate] = createSignal(0);         // FFT frames/sec
  const [iqRate, setIqRate] = createSignal(0);           // IQ samples/sec
  const [wsBytes, setWsBytes] = createSignal(0);         // WebSocket bytes/sec (total inbound)
  const [wsBytesHistory, setWsBytesHistory] = createSignal<number[]>([]); // last 30 seconds
  // Server-reported total outbound bandwidth (all clients); -1 = unknown.
  const [serverWsBytes, setServerWsBytes] = createSignal(-1);
  const [serverWsBytesHistory, setServerWsBytesHistory] = createSignal<number[]>([]);

  // ---- Server Stats (broadcast every 2s) ----
  const [serverCpu, setServerCpu] = createSignal(0);     // server process CPU %
  const [serverMem, setServerMem] = createSignal(0);     // server process RSS MB
  const [serverClients, setServerClients] = createSignal(0); // total connected clients

  // ---- Codec Performance Stats (bytes/sec) ----
  const [fftWireBytes, setFftWireBytes] = createSignal(0);   // FFT wire bytes/sec (compressed)
  const [fftRawBytes, setFftRawBytes] = createSignal(0);     // FFT equivalent raw bytes/sec
  const [iqWireBytes, setIqWireBytes] = createSignal(0);     // IQ wire bytes/sec (compressed)
  const [iqRawBytes, setIqRawBytes] = createSignal(0);       // IQ equivalent raw bytes/sec

  // ---- RDS Data (WFM only) ----
  const [rdsPs, setRdsPs] = createSignal('');                 // Programme Service name (8 chars)
  const [rdsRt, setRdsRt] = createSignal('');                 // RadioText (up to 64 chars)
  const [rdsPty, setRdsPty] = createSignal('');               // Programme Type name
  const [rdsPi, setRdsPi] = createSignal('');                 // PI code (hex string)
  const [rdsSynced, setRdsSynced] = createSignal(false);      // RDS sync acquired
  const [rdsClock, setRdsClock] = createSignal('');            // Station clock from group 4A

  // ---- Music identification ----
  const [identifyState, setIdentifyState] = createSignal<'idle' | 'capturing' | 'querying' | 'done' | 'error'>('idle');
  const [identifyResult, setIdentifyResult] = createSignal<null | {
    match: boolean;
    title?: string;
    artist?: string;
    album?: string;
    spotify?: string;
    youtube?: string;
    apple?: string;
    service?: string;
    error?: string; // set on failure so the UI can show what went wrong
  }>(null);

  // Timestamp (ms) until which the Identify button should be disabled after a
  // frequency change on ADPCM/none codecs (ring buffer needs to refill).
  // 0 = not waiting. Opus is exempt — the server ring is independent of client tuning.
  const [identifyReadyAt, setIdentifyReadyAt] = createSignal(0);

  // ---- Toast notifications (server-pushed or client-generated) ----
  const [toasts, setToasts] = createSignal<Array<{ id: number; message: string; code?: string }>>([]);
  let toastSeq = 0;

  return {
    // Connection
    connected, setConnected,
    clientId, setClientId,
    localClientId, setLocalClientId,
    connIndex, setConnIndex,

    // Dongle / Profile
    dongles, setDongles,
    activeDongleId, setActiveDongleId,
    activeProfile, setActiveProfile,
    activeProfileId, setActiveProfileId,
    profiles, setProfiles,

    // Push-based state
    pushDongles, setPushDongles,
    pushServerConfig, setPushServerConfig,
    configVersion, setConfigVersion,
    connectionState, setConnectionState,
    serverVersion, setServerVersion,
    reconnectAttempt, setReconnectAttempt,

    // Tuning
    centerFrequency, setCenterFrequency,
    sampleRate, setSampleRate,
    iqSampleRate, setIqSampleRate,
    tuneOffset, setTuneOffset,
    mode, setMode,
    bandwidth, setBandwidth,
    decoderMode, setDecoderMode,
    decoderMessages,
    addDecoderMessage: (decoderType: string, data: Record<string, unknown>) => {
      setDecoderMessages((prev) => [
        { decoderType, data, receivedAt: Date.now() },
        ...prev,
      ].slice(0, 200));
    },
    clearDecoderMessages: () => setDecoderMessages([]),
    adsbAircraft,
    adsbStatus,
    /** Fold one `decoderType: "adsb"` snapshot into reactive state. */
    applyAdsbSnapshot: (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const snapshot = data as Partial<AdsbSnapshot>;
      setAdsbAircraft(Array.isArray(snapshot.aircraft) ? snapshot.aircraft : []);
      setAdsbStatus({
        unavailable: snapshot.unavailable ?? null,
        degraded: snapshot.degraded ?? null,
        suggestCenterHz: snapshot.suggestCenterHz ?? null,
        windowCenterHz: snapshot.windowCenterHz ?? 0,
        windowRateHz: snapshot.windowRateHz ?? 0,
        preambles: snapshot.preambles ?? 0,
        frames: snapshot.frames ?? 0,
        repaired: snapshot.repaired ?? 0,
        badCrc: snapshot.badCrc ?? 0,
        unmatched: snapshot.unmatched ?? 0,
      });
    },
    clearAdsb: () => {
      setAdsbAircraft([]);
      setAdsbStatus(null);
    },
    acarsMessages,
    acarsStatus,
    /** Fold one `decoderType: "acars"` event (message or status) into state. */
    applyAcarsEvent: (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const event = data as {
        kind?: string;
        frames?: number;
        bad?: number;
        level?: number;
        acars?: AcarsMessage;
      };
      if (event.kind === 'status') {
        setAcarsStatus({
          frames: event.frames ?? 0,
          bad: event.bad ?? 0,
          level: event.level ?? 0,
        });
        return;
      }
      if (event.kind === 'message' && event.acars) {
        const message = { ...event.acars, receivedAt: Date.now() };
        setAcarsMessages((prev) => [message, ...prev].slice(0, 300));
      }
    },
    clearAcars: () => {
      setAcarsMessages([]);
      setAcarsStatus({ frames: 0, bad: 0, level: 0 });
    },
    aisVessels,
    aisStatus,
    /** Fold one `decoderType: "ais"` snapshot into reactive state. */
    applyAisSnapshot: (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const snapshot = data as Partial<AisSnapshot>;
      setAisVessels(Array.isArray(snapshot.vessels) ? snapshot.vessels : []);
      setAisStatus({
        channels: Array.isArray(snapshot.channels) ? snapshot.channels : [],
        unavailable: snapshot.unavailable ?? null,
        degraded: snapshot.degraded ?? null,
        suggestCenterHz: snapshot.suggestCenterHz ?? null,
        windowCenterHz: snapshot.windowCenterHz ?? 0,
        windowRateHz: snapshot.windowRateHz ?? 0,
        bursts: snapshot.bursts ?? 0,
        messages: snapshot.messages ?? 0,
        badFcs: snapshot.badFcs ?? 0,
        unsupported: snapshot.unsupported ?? 0,
        samplesPerBit: snapshot.samplesPerBit ?? 0,
        offsetHz: snapshot.offsetHz ?? null,
      });
    },
    clearAis: () => {
      setAisVessels([]);
      setAisStatus(null);
    },
    vdl2Messages,
    vdl2Stations,
    vdl2Status,
    hfdlLog,
    hfdlStatus,
    /** Fold one `decoderType: "hfdl"` snapshot into reactive state. */
    applyHfdlSnapshot: (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const snapshot = data as Partial<HfdlSnapshot>;
      setHfdlLog(Array.isArray(snapshot.log) ? snapshot.log : []);
      setHfdlStatus({
        running: snapshot.running ?? false,
        levelDbfs: snapshot.levelDbfs ?? 0,
        bursts: snapshot.bursts ?? 0,
        decodes: snapshot.decodes ?? 0,
        unavailable: snapshot.unavailable ?? null,
        degraded: snapshot.degraded ?? null,
        suggestCenterHz: snapshot.suggestCenterHz ?? null,
        windowCenterHz: snapshot.windowCenterHz ?? 0,
        windowRateHz: snapshot.windowRateHz ?? 0,
      });
    },
    clearHfdl: () => {
      setHfdlLog([]);
      setHfdlStatus(null);
    },
    aprsPackets,
    aprsStatus,
    /** Fold one `decoderType: "aprs"` packet or status event into state. */
    applyAprsEvent: (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const event = data as {
        kind?: string;
        frames?: number;
        badFcs?: number;
        nonAprs?: number;
        level?: number;
        text?: string;
        aprs?: AprsPacket;
      };
      if (event.kind === 'status') {
        setAprsStatus({
          frames: event.frames ?? 0,
          badFcs: event.badFcs ?? 0,
          nonAprs: event.nonAprs ?? 0,
          level: event.level ?? 0,
        });
        return;
      }
      if (event.kind === 'packet' && event.aprs) {
        const packet = { ...event.aprs, text: event.text ?? event.aprs.raw };
        setAprsPackets((prev) => [packet, ...prev].slice(0, 500));
      }
    },
    clearAprs: () => {
      setAprsPackets([]);
      setAprsStatus({ frames: 0, badFcs: 0, nonAprs: 0, level: 0 });
    },
    navtexMessages,
    navtexStatus,
    /** Fold one `decoderType: "navtex"` message or status event into state. */
    applyNavtexEvent: (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const event = data as Partial<NavtexStatus> & {
        kind?: string;
        navtex?: NavtexMessage;
      };
      if (event.kind === 'status') {
        setNavtexStatus({
          inSync: event.inSync ?? false,
          level: event.level ?? 0,
          reverse: event.reverse ?? false,
          direct: event.direct ?? 0,
          repaired: event.repaired ?? 0,
          lost: event.lost ?? 0,
          messages: event.messages ?? 0,
          live: event.live ?? null,
        });
        return;
      }
      if (event.kind === 'message' && event.navtex) {
        const message = event.navtex;
        setNavtexMessages((prev) => {
          const key = (m: NavtexMessage) => `${m.station}|${m.subject}|${m.serial}`;
          const next = prev.filter((m) => key(m) !== key(message));
          return [message, ...next].slice(0, 200);
        });
      }
    },
    clearNavtex: () => {
      setNavtexMessages([]);
      setNavtexStatus({
        inSync: false,
        level: 0,
        reverse: false,
        direct: 0,
        repaired: 0,
        lost: 0,
        messages: 0,
        live: null,
      });
    },
    packetFrames,
    packetStatus,
    /** Fold one `decoderType: "packet"` event into state. */
    applyPacketEvent: (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const event = data as Partial<PacketStatus> & {
        kind?: string;
        packet?: PacketFrame;
      };
      if (event.kind === 'status') {
        setPacketStatus({
          frames: event.frames ?? 0,
          badFcs: event.badFcs ?? 0,
          nonAx25: event.nonAx25 ?? 0,
          level: event.level ?? 0,
          baud: event.baud ?? 1200,
        });
        return;
      }
      if (event.kind === 'packet' && event.packet) {
        setPacketFrames((prev) => [event.packet!, ...prev].slice(0, 1000));
      }
    },
    clearPacket: () => {
      setPacketFrames([]);
      setPacketStatus({ frames: 0, badFcs: 0, nonAx25: 0, level: 0, baud: 1200 });
    },
    wefaxImage,
    wefaxStatus,
    /** Fold one `decoderType: "wefax"` event into the current image/status. */
    applyWefaxEvent: (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const event = data as Partial<WefaxStatus> & {
        kind?: string;
        imageId?: number;
        width?: number;
        height?: number;
        lpm?: number;
        ioc?: string;
        gray?: string;
        y?: number;
        byTone?: boolean;
      };
      if (event.kind === 'status') {
        setWefaxStatus({
          receiving: event.receiving ?? false,
          phasing: event.phasing ?? false,
          lines: event.lines ?? 0,
          ioc: event.ioc ?? 'IOC 576',
          lpm: event.lpm ?? 120,
          signal: event.signal ?? 0,
          subcarrierHz: event.subcarrierHz ?? 0,
          slantPpm: event.slantPpm ?? 0,
          imageId: event.imageId ?? 0,
          width: event.width ?? 0,
          height: event.height ?? 0,
        });
        return;
      }
      if (event.kind === 'start') {
        setWefaxImage({
          imageId: event.imageId ?? 0,
          width: event.width ?? 1809,
          height: 0,
          ioc: event.ioc ?? 'IOC 576',
          lpm: event.lpm ?? 120,
          complete: false,
          rows: [],
        });
        return;
      }
      if (event.kind === 'line' && event.gray) {
        const binary = atob(event.gray);
        const row = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) row[i] = binary.charCodeAt(i);
        setWefaxImage((previous) => {
          const width = event.width ?? previous?.width ?? row.length;
          const image = previous && previous.imageId === (event.imageId ?? previous.imageId)
            ? previous
            : {
                imageId: event.imageId ?? 0,
                width,
                height: 0,
                ioc: event.ioc ?? 'IOC 576',
                lpm: event.lpm ?? 120,
                complete: false,
                rows: [] as Uint8Array[],
              };
          const y = Math.max(0, Math.min(2600, event.y ?? image.rows.length));
          const rows = image.rows.slice();
          while (rows.length < y) rows.push(new Uint8Array(image.width));
          rows[y] = row;
          return {
            ...image,
            width,
            height: Math.max(image.height, y + 1),
            rows,
          };
        });
        return;
      }
      if (event.kind === 'complete') {
        setWefaxImage((previous) => previous ? {
          ...previous,
          height: Math.max(previous.height, event.height ?? previous.height),
          complete: true,
          byTone: event.byTone,
        } : previous);
      }
    },
    clearWefax: () => {
      setWefaxImage(null);
      setWefaxStatus({
        receiving: false,
        phasing: false,
        lines: 0,
        ioc: 'IOC 576',
        lpm: 120,
        signal: 0,
        subcarrierHz: 0,
        slantPpm: 0,
        imageId: 0,
        width: 0,
        height: 0,
      });
    },
    sstvImages,
    sstvStatus,
    /** Fold one `decoderType: "sstv"` event into the image history/status. */
    applySstvEvent: (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const event = data as {
        kind?: string;
        imageId?: number;
        sstvMode?: string | null;
        width?: number;
        height?: number;
        y?: number;
        rgb?: string;
        callsign?: string | null;
        receiving?: boolean;
        progress?: number;
        signal?: number;
        unsupported?: string | null;
        name?: string;
      };
      if (event.kind === 'status') {
        setSstvStatus({
          receiving: event.receiving ?? false,
          progress: event.progress ?? 0,
          signal: event.signal ?? 0,
          imageId: event.imageId ?? 0,
          mode: event.sstvMode ?? null,
          width: event.width ?? 0,
          height: event.height ?? 0,
          callsign: event.callsign ?? null,
          unsupported: event.unsupported ?? null,
        });
        return;
      }
      if (event.kind === 'start') {
        const image: SstvImage = {
          imageId: event.imageId ?? 0,
          width: event.width ?? 320,
          height: event.height ?? 256,
          mode: event.sstvMode ?? null,
          complete: false,
          callsign: null,
          rows: [],
        };
        setSstvImages((previous) => [image, ...previous].slice(0, 12));
        setSstvStatus((previous) => ({
          ...previous,
          receiving: true,
          progress: 0,
          imageId: image.imageId,
          mode: image.mode,
          width: image.width,
          height: image.height,
          callsign: null,
          unsupported: null,
        }));
        return;
      }
      if (event.kind === 'line' && event.rgb) {
        const binary = atob(event.rgb);
        const row = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) row[i] = binary.charCodeAt(i);
        setSstvImages((previous) => {
          const imageId = event.imageId ?? 0;
          let found = false;
          const updated = previous.map((image) => {
            if (image.imageId !== imageId) return image;
            found = true;
            const width = event.width ?? image.width;
            const y = event.y ?? image.rows.length;
            const rows = image.rows.slice();
            rows[y] = row;
            return {
              ...image,
              width,
              height: Math.max(image.height, event.height ?? y + 1),
              rows,
            };
          });
          if (found) return updated;
          // Free-run (no VIS) decoding can begin with a line event.
          const width = event.width ?? 320;
          const height = event.height ?? 256;
          const rows: Uint8Array[] = [];
          rows[event.y ?? 0] = row;
          return [
            {
              imageId,
              width,
              height,
              mode: event.sstvMode ?? null,
              complete: false,
              callsign: null,
              rows,
            },
            ...previous,
          ].slice(0, 12);
        });
        return;
      }
      if (event.kind === 'id') {
        setSstvImages((previous) =>
          previous.map((image) =>
            image.imageId === (event.imageId ?? image.imageId)
              ? { ...image, callsign: event.callsign ?? image.callsign }
              : image
          )
        );
        setSstvStatus((previous) => ({ ...previous, callsign: event.callsign ?? previous.callsign }));
        return;
      }
      if (event.kind === 'complete') {
        setSstvImages((previous) =>
          previous.map((image) =>
            image.imageId === (event.imageId ?? image.imageId)
              ? {
                  ...image,
                  complete: true,
                  height: Math.max(image.height, event.height ?? image.height),
                  callsign: event.callsign ?? image.callsign,
                }
              : image
          )
        );
        setSstvStatus((previous) => ({
          ...previous,
          receiving: false,
          progress: 1,
          callsign: event.callsign ?? previous.callsign,
        }));
        return;
      }
      if (event.kind === 'unsupported') {
        setSstvStatus((previous) => ({
          ...previous,
          unsupported: event.name ?? 'unsupported SSTV mode',
        }));
      }
    },
    clearSstv: () => {
      setSstvImages([]);
      setSstvStatus({
        receiving: false,
        progress: 0,
        signal: 0,
        imageId: 0,
        mode: null,
        width: 0,
        height: 0,
        callsign: null,
        unsupported: null,
      });
    },
    hellColumns,
    hellStatus,
    applyHellEvent: (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const event = data as {
        kind?: string;
        rows?: number;
        cols?: string;
        variant?: string;
        receiving?: boolean;
        columns?: number;
        seq?: number;
        level?: number;
        audioHz?: number;
      };
      if (event.kind === 'status') {
        setHellStatus({
          receiving: event.receiving ?? false,
          variant: event.variant ?? 'FELD',
          columns: event.columns ?? 0,
          seq: event.seq ?? 0,
          level: event.level ?? 0,
          audioHz: event.audioHz ?? 1500,
        });
        return;
      }
      if (event.kind !== 'columns' || !event.cols) return;
      const rows = event.rows ?? 14;
      const binary = atob(event.cols);
      const incoming: Uint8Array[] = [];
      for (let offset = 0; offset + rows <= binary.length; offset += rows) {
        const column = new Uint8Array(rows);
        for (let y = 0; y < rows; y += 1) {
          column[y] = binary.charCodeAt(offset + y);
        }
        incoming.push(column);
      }
      setHellColumns((previous) => [...previous, ...incoming].slice(-2000));
      setHellStatus((previous) => ({
        ...previous,
        receiving: true,
        columns: event.columns ?? previous.columns + incoming.length,
        seq: event.seq ?? previous.seq,
      }));
    },
    clearHell: () => {
      setHellColumns([]);
      setHellStatus({
        receiving: false,
        variant: 'FELD',
        columns: 0,
        seq: 0,
        level: 0,
        audioHz: 1500,
      });
    },
    textMessages,
    textStatus,
    /** Fold one Olivia/THOR/FSQ text or status event into state. */
    applyTextEvent: (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const event = data as Partial<TextModeMessage> & Partial<TextModeStatus> & {
        kind?: string;
      };
      if (event.kind === 'status') {
        setTextStatus({
          mode: event.mode ?? '',
          level: event.level ?? 0,
          audioHz: event.audioHz ?? 1500,
          listening: event.listening ?? true,
        });
        return;
      }
      if (event.kind !== 'text' || typeof event.text !== 'string' || !event.text) return;
      const message: TextModeMessage = {
        at: event.at ?? Math.floor(Date.now() / 1000),
        mode: event.mode ?? '',
        text: event.text,
        rfHz: event.rfHz ?? 0,
        audioHz: event.audioHz ?? 1500,
        level: event.level ?? 0,
      };
      setTextMessages((previous) => [...previous, message].slice(-4000));
      setTextStatus((previous) => ({
        ...previous,
        mode: message.mode,
        level: message.level,
        audioHz: message.audioHz,
        listening: true,
      }));
    },
    clearText: () => {
      setTextMessages([]);
      setTextStatus({ mode: '', level: 0, audioHz: 1500, listening: false });
    },
    meteorMessages,
    meteorStatus,
    /** Fold one MSK144/FSK441 decode or status event into state. */
    applyMeteorEvent: (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const event = data as Partial<MeteorMessage> &
        Partial<MeteorStatus> & { kind?: string };
      if (event.kind === 'status') {
        setMeteorStatus({
          mode: event.mode ?? '',
          level: event.level ?? 0,
          audioHz: event.audioHz ?? 1500,
          period: event.period ?? 15,
          decodes: event.decodes ?? 0,
          listening: event.listening ?? false,
        });
        return;
      }
      if (event.kind !== 'decode' || typeof event.text !== 'string' || !event.text) return;
      const message: MeteorMessage = {
        at: event.at ?? Math.floor(Date.now() / 1000),
        mode: event.mode ?? '',
        text: event.text,
        rfHz: event.rfHz ?? 0,
        audioHz: event.audioHz ?? 1500,
        snrDb: event.snrDb ?? 0,
        dtSec: event.dtSec ?? 0,
        durationSec: event.durationSec,
        confidence: event.confidence,
        period: event.period ?? 15,
      };
      setMeteorMessages((previous) => [message, ...previous].slice(0, 1000));
      setMeteorStatus((previous) => ({
        ...previous,
        mode: message.mode,
        audioHz: message.audioHz,
        period: message.period,
        listening: true,
      }));
    },
    clearMeteor: () => {
      setMeteorMessages([]);
      setMeteorStatus({
        mode: '',
        level: 0,
        audioHz: 1500,
        period: 15,
        decodes: 0,
        listening: false,
      });
    },
    js8Messages,
    js8Status,
    /** Fold one `decoderType: "js8"` message or status event into state. */
    applyJs8Event: (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const event = data as {
        kind?: string;
        id?: string;
        mode?: string;
        text?: string;
        rfHz?: number;
        audioHz?: number;
        snrDb?: number;
        speed?: string;
        period?: number;
        level?: number;
        decodes?: number;
        listening?: boolean;
        heard?: { call: string; lastSlotUtc: number }[];
        js8?: Partial<Js8Message>;
      };

      if (event.kind === 'status') {
        setJs8Status((previous) => ({
          speed: event.speed ?? previous.speed,
          period: event.period ?? previous.period,
          level: event.level ?? previous.level,
          decodes: event.decodes ?? previous.decodes,
          listening: event.listening ?? previous.listening,
          heard: Array.isArray(event.heard) ? event.heard : previous.heard,
        }));
        return;
      }

      if (event.kind !== 'message') return;
      const js8 = event.js8 ?? {};
      const message: Js8Message = {
        at: Date.now() / 1000,
        from: js8.from ?? '',
        to: js8.to ?? '',
        cmd: js8.cmd ?? null,
        text: js8.text ?? event.text ?? '',
        rfHz: event.rfHz ?? 0,
        audioHz: js8.audioHz ?? event.audioHz ?? 1500,
        snrDb: js8.snrDb ?? event.snrDb ?? 0,
        firstSlotUtc: js8.firstSlotUtc ?? event.period ?? 0,
        lastSlotUtc: js8.lastSlotUtc ?? event.period ?? 0,
        frames: js8.frames ?? 1,
        complete: js8.complete ?? true,
        toMe: js8.toMe ?? false,
        speed: js8.speed ?? event.speed ?? 'normal',
      };
      if (!message.text) return;
      setJs8Messages((previous) => [message, ...previous].slice(0, 1000));
    },
    clearJs8: () => {
      setJs8Messages([]);
      setJs8Status({
        speed: 'normal',
        period: 15,
        level: 0,
        decodes: 0,
        listening: false,
        heard: [],
      });
    },
    timeSignalClock,
    timeSignalStatus,
    /** Fold one `decoderType: "dcf77" | "als162"` event into state. */
    applyTimeSignalEvent: (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const event = data as Partial<TimeSignalStatus> & {
        kind?: string;
        time?: TimeSignalClock | null;
      };
      if (event.kind === 'status') {
        setTimeSignalStatus({
          mode: event.mode ?? '',
          sync: event.sync ?? false,
          bits: event.bits ?? 0,
          second: event.second,
          pulses: event.pulses,
          level: event.level ?? 0,
          listening: event.listening ?? false,
          time: event.time ?? null,
        });
        if (event.time) setTimeSignalClock(event.time);
        return;
      }
      if (event.kind === 'time' && event.time) {
        setTimeSignalClock(event.time);
        setTimeSignalStatus((previous) => ({
          ...previous,
          mode: event.mode ?? previous.mode,
          sync: true,
          listening: true,
          time: event.time ?? null,
        }));
      }
    },
    clearTimeSignal: () => {
      setTimeSignalClock(null);
      setTimeSignalStatus({
        mode: '',
        sync: false,
        bits: 0,
        level: 0,
        listening: false,
        time: null,
      });
    },
    ismDevices,
    ismStatus,
    /** Fold one `decoderType: "ism"` reports/status event into state. */
    applyIsmEvent: (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const event = data as {
        kind?: string;
        devices?: IsmDevice[];
        channels?: IsmStatus['channels'];
        unavailable?: string | null;
        suggestCenterHz?: number | null;
        bursts?: number;
        decodes?: number;
        windowCenterHz?: number;
        windowRateHz?: number;
      };
      if (event.kind === 'reports') {
        setIsmDevices(Array.isArray(event.devices) ? event.devices : []);
        return;
      }
      if (event.kind === 'status') {
        setIsmStatus({
          channels: Array.isArray(event.channels) ? event.channels : [],
          unavailable: event.unavailable ?? null,
          suggestCenterHz: event.suggestCenterHz ?? null,
          bursts: event.bursts ?? 0,
          decodes: event.decodes ?? 0,
          windowCenterHz: event.windowCenterHz ?? 0,
          windowRateHz: event.windowRateHz ?? 0,
        });
      }
    },
    clearIsm: () => {
      setIsmDevices([]);
      setIsmStatus(null);
    },
    /** Fold one `decoderType: "vdl2"` snapshot into reactive state. */
    applyVdl2Snapshot: (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const snapshot = data as Partial<Vdl2Snapshot>;
      setVdl2Messages(Array.isArray(snapshot.messages) ? snapshot.messages : []);
      setVdl2Stations(Array.isArray(snapshot.stations) ? snapshot.stations : []);
      setVdl2Status({
        channels: Array.isArray(snapshot.channels) ? snapshot.channels : [],
        unavailable: snapshot.unavailable ?? null,
        degraded: snapshot.degraded ?? null,
        suggestCenterHz: snapshot.suggestCenterHz ?? null,
        windowCenterHz: snapshot.windowCenterHz ?? 0,
        windowRateHz: snapshot.windowRateHz ?? 0,
        bursts: snapshot.bursts ?? 0,
        syncs: snapshot.syncs ?? 0,
        headers: snapshot.headers ?? 0,
        headerBad: snapshot.headerBad ?? 0,
        rsFail: snapshot.rsFail ?? 0,
        rsCorrected: snapshot.rsCorrected ?? 0,
        hdlcBad: snapshot.hdlcBad ?? 0,
        fecBypassed: snapshot.fecBypassed ?? 0,
        fcsBad: snapshot.fcsBad ?? 0,
        frames: snapshot.frames ?? 0,
        multiblock: snapshot.multiblock ?? 0,
        multiblockOk: snapshot.multiblockOk ?? 0,
        samplesPerSymbol: snapshot.samplesPerSymbol ?? 0,
      });
    },
    clearVdl2: () => {
      setVdl2Messages([]);
      setVdl2Stations([]);
      setVdl2Status(null);
    },
    tuningStep, setTuningStep,
    tunedFrequency,

    // Audio
    volume, setVolume,
    muted, setMuted,
    squelch, setSquelch,
    signalLevel, setSignalLevel,
    snr, setSnr,
    stereoDetected, setStereoDetected,
    stereoEnabled, setStereoEnabled,
    stereoThreshold, setStereoThreshold,
    balance, setBalance,
    eqLow, setEqLow,
    eqLowMid, setEqLowMid,
    eqMid, setEqMid,
    eqHighMid, setEqHighMid,
    eqHigh, setEqHigh,
    loudness, setLoudness,

    // Noise Reduction
    nrEnabled, setNrEnabled,
    nrStrength, setNrStrength,
    nbEnabled, setNbEnabled,
    nbLevel, setNbLevel,

    // AGC
    agcEnabled, setAgcEnabled,
    agcDecayMs, setAgcDecayMs,

    // Audio Filters
    rumbleFilterEnabled, setRumbleFilterEnabled,
    rumbleFilterCutoff, setRumbleFilterCutoff,
    autoNotchEnabled, setAutoNotchEnabled,
    hiBlendEnabled, setHiBlendEnabled,
    hiBlendCutoff, setHiBlendCutoff,
    hiBlendAuto, setHiBlendAuto,
    hiBlendAutoCutoff, setHiBlendAutoCutoff,
    softMuteEnabled, setSoftMuteEnabled,
    softMuteThreshold, setSoftMuteThreshold,
    deemphasisUs, setDeemphasisUs,

    // Display
    waterfallTheme, setWaterfallTheme,
    uiTheme, setUITheme,
    waterfallMin, setWaterfallMin,
    waterfallMax, setWaterfallMax,
    waterfallAutoRange, setWaterfallAutoRange,
    waterfallGamma, setWaterfallGamma,
    waterfallSpeed, setWaterfallSpeed,
    fftSize, setFftSize,

    // UI State
    audioStarted, setAudioStarted,
    audioRunning, setAudioRunning,
    sidebarOpen, setSidebarOpen,
    decoderPanelOpen, setDecoderPanelOpen,
    analysisPanelOpen, setAnalysisPanelOpen,
    isAdmin, setIsAdmin,
    adminSection, setAdminSection,
    meterStyle, setMeterStyle,
    audioSpectrumVisible, setAudioSpectrumVisible,
    spectrumPeakHold, setSpectrumPeakHold,
    spectrumSignalFill, setSpectrumSignalFill,
    spectrumPaused, setSpectrumPaused,
    spectrumAveraging, setSpectrumAveraging,
    spectrumNoiseFloor, setSpectrumNoiseFloor,
    spectrumZoom, setSpectrumZoom,
    spectrumRangeSelect, setSpectrumRangeSelect,
    signalMarkers, setSignalMarkers,
    bookmarks, setBookmarks,
    adminBookmarks, setAdminBookmarks,

    // Codec Preferences
    fftCodec, setFftCodec,
    iqCodec, setIqCodec,

    // Available Codecs (server-reported)
    availableFftCodecs, setAvailableFftCodecs,
    availableIqCodecs, setAvailableIqCodecs,

    // Bandwidth / Throughput
    fftRate, setFftRate,
    iqRate, setIqRate,
    wsBytes, setWsBytes,
    wsBytesHistory, setWsBytesHistory,
    serverWsBytes, setServerWsBytes,
    serverWsBytesHistory, setServerWsBytesHistory,

    // Server Stats
    serverCpu, setServerCpu,
    serverMem, setServerMem,
    serverClients, setServerClients,

    // Codec Performance Stats
    fftWireBytes, setFftWireBytes,
    fftRawBytes, setFftRawBytes,
    iqWireBytes, setIqWireBytes,
    iqRawBytes, setIqRawBytes,

    // RDS Data
    rdsPs, setRdsPs,
    rdsRt, setRdsRt,
    rdsPty, setRdsPty,
    rdsPi, setRdsPi,
    rdsSynced, setRdsSynced,
    rdsClock, setRdsClock,
    identifyState, setIdentifyState,
    identifyResult, setIdentifyResult,
    identifyReadyAt, setIdentifyReadyAt,
    toasts,
    addToast: (message: string, code?: string) => {
      const id = ++toastSeq;
      setToasts(prev => [...prev, { id, message, code }]);
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
    },
    dismissToast: (id: number) => setToasts(prev => prev.filter(t => t.id !== id)),
  };
}

// Create a singleton store
export const store = createRoot(createStore);
export { ALL_FFT_CODECS, ALL_IQ_CODECS };
