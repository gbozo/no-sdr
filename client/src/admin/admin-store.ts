// ============================================================
// Admin Store — authentication, config state, dirty tracking
// ============================================================

import { createSignal, createRoot } from 'solid-js';

export type AdminSection =
  | 'general'
  | 'devices'
  | 'bookmarks'
  | 'decoders'
  | 'features'
  | 'monitor'
  | 'identify';

// ---- Dongle & Profile Types (matches the server API) ----
export interface SourceConfig {
  type: string;
  host?: string;
  port?: number;
  deviceIndex?: number;
  serial?: string;
  binary?: string;
  extraArgs?: string[];
  spawnRtlTcp?: boolean;
  /** Source-specific hardware settings, e.g. lnaDb/vgaDb/amp for HackRF. */
  settings?: Record<string, string | number | boolean>;
}

export interface DongleProfile {
  id: string;
  name: string;
  centerFrequency: number;
  sampleRate: number;
  bandwidth: number;
  mode: string;
  gain: number;
  fftSize: number;
  fftFps: number;
  tuneOffset: number;
  tuningStep: number;
  swapIQ: boolean;
  oscillatorOffset: number;
  directSampling: number;
  description: string;
  dongleId: string;
  preFilterNb: boolean;
  preFilterNbThreshold: number;
  dcOffsetRemoval?: boolean;
}

export interface DongleConfig {
  id: string;
  name: string;
  enabled: boolean;
  autoStart: boolean;
  /** True while the backend has an active source/pipeline for this dongle. */
  running?: boolean;
  clientCount?: number;
  activeProfileId?: string;
  source: SourceConfig;
  sampleRate: number;
  gain: number;
  ppmCorrection: number;
  deviceIndex: number;
  directSampling: number;
  biasT: boolean;
  digitalAgc: boolean;
  offsetTuning: boolean;
  iqCorrection?: boolean;
  profiles: DongleProfile[];
  /** Runtime state from the manager, including the last source error. */
  state?: {
    status: string;
    retryCount?: number;
    maxRetries?: number;
    lastError?: string;
  };
}

export interface UsbDevice {
  /** Source type this row belongs to (`local`, `hackrf`, `sdrplay`, ...). */
  source?: string;
  /** RTL-SDR index, where the source opens by index. */
  index?: number;
  name: string;
  serial: string;
  /** Network address for Pluto and other network sources. */
  address?: string;
  /** Picker label from the backend. */
  label?: string;
  /** Extra state, e.g. firmware upload or permission warnings. */
  detail?: string;
  available?: boolean;
  product?: string;
  manufact?: string;
}

// ---- Bookmark Types ----
export interface Bookmark {
  id: string;
  name: string;
  frequency: number;
  mode: string;
  bandwidth?: number;
  description?: string;
}

// ---- Background Decoder Types ----

export interface DecoderConfig {
  id: string;
  enabled: boolean;
  dongleId: string;
  mode: string;
  frequencyHz: number;
  bandwidthHz: number;
  /** Per-decoder history retention. 0 inherits the global setting. */
  retentionDays: number;
  settings?: Record<string, unknown>;
}

export interface DecoderModeInfo {
  mode: string;
  label: string;
  category: string;
  description: string;
  defaultFrequencyHz: number;
  defaultBandwidthHz: number;
  background: boolean;
}

export interface DecoderModeSummary {
  mode: string;
  count: number;
  decoders: number;
  oldestMs: number;
  latestMs: number;
}

export interface DecoderSummary {
  modes: DecoderModeSummary[];
  decoders: {
    mode: string;
    decoderId: string;
    dongleId: string;
    count: number;
    latestMs: number;
    oldestMs: number;
  }[];
  entities: { kind: string; count: number; latestMs: number }[];
  total: number;
  stats?: {
    enabled: boolean;
    path?: string;
    messages?: number;
    entities?: number;
    oldestMs?: number | null;
    newestMs?: number | null;
    dbBytes?: number;
  };
}

// ---- Server Config Types ----
export interface ServerConfig {
  port: number;
  host: string;
  adminPassword: string;
  callsign: string;
  description: string;
  location: string;
  /** Receiver map position (0,0 = unset). Separate from the display location. */
  receiverLatitude: number;
  receiverLongitude: number;
  demoMode: boolean;
  identifyEnabled: boolean;
  usersRibbon: 'off' | 'users' | 'ip';
  fftHistoryFftSize: number;
  fftHistoryCompression: string;
  allowedFftCodecs: string[];
  allowedIqCodecs: string[];
  opusComplexity: number;
  realIPHeader: string;
  // Music identification
  auddApiKey: string;
  acrcloudHost: string;
  acrcloudAccessKey: string;
  acrcloudAccessSecret: string;
  // Decoder history database
  decoderPath: string;
  retentionDays: number;
  purgeIntervalMinutes: number;
  maxMessages: number;
}

const DEFAULT_SERVER_CONFIG: ServerConfig = {
  port: 3000,
  host: '0.0.0.0',
  adminPassword: '',
  callsign: '',
  description: '',
  location: '',
  receiverLatitude: 0,
  receiverLongitude: 0,
  demoMode: false,
  identifyEnabled: true,
  usersRibbon: 'users',
  fftHistoryFftSize: 1024,
  fftHistoryCompression: 'deflate',
  allowedFftCodecs: ['none', 'adpcm', 'deflate', 'deflate-floor'],
  allowedIqCodecs: ['none', 'adpcm', 'opus-lo', 'opus', 'opus-hq'],
  opusComplexity: 5,
  realIPHeader: '',
  auddApiKey: '',
  acrcloudHost: '',
  acrcloudAccessKey: '',
  acrcloudAccessSecret: '',
  decoderPath: '',
  retentionDays: 0,
  purgeIntervalMinutes: 30,
  maxMessages: 0,
};

function createAdminStore() {
  // ---- Authentication ----
  const [authenticated, setAuthenticated] = createSignal(false);
  const [authChecking, setAuthChecking] = createSignal(true);
  const [authError, setAuthError] = createSignal('');

  // ---- Navigation ----
  const [activeSection, setActiveSection] = createSignal<AdminSection>('general');

  // ---- Config Version (optimistic concurrency) ----
  const [configVersion, setConfigVersion] = createSignal<number>(0);

  // ---- Dirty State (unsaved changes) ----
  const [dirty, setDirty] = createSignal(false);

  // ---- Save State ----
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal('');
  const [saveSuccess, setSaveSuccess] = createSignal(false);

  // ---- Server Config ----
  const [serverConfig, setServerConfig] = createSignal<ServerConfig>({ ...DEFAULT_SERVER_CONFIG });
  const [serverConfigLoading, setServerConfigLoading] = createSignal(false);

  // ---- Dongles & Profiles ----
  const [dongles, setDongles] = createSignal<DongleConfig[]>([]);
  const [donglesLoading, setDonglesLoading] = createSignal(false);
  const [selectedDongleId, setSelectedDongleId] = createSignal<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = createSignal<string | null>(null);
  const [usbDevices, setUsbDevices] = createSignal<UsbDevice[]>([]);

  // ---- Bookmarks ----
  const [bookmarks, setBookmarks] = createSignal<Bookmark[]>([]);
  const [bookmarksLoading, setBookmarksLoading] = createSignal(false);

  // ---- Background Decoders ----
  const [decoders, setDecoders] = createSignal<DecoderConfig[]>([]);
  const [decoderModes, setDecoderModes] = createSignal<DecoderModeInfo[]>([]);
  const [decoderSummary, setDecoderSummary] = createSignal<DecoderSummary | null>(null);
  const [decodersLoading, setDecodersLoading] = createSignal(false);
  const [decodersError, setDecodersError] = createSignal('');
  // ---- Auth Helpers ----
  async function checkSession(): Promise<boolean> {
    setAuthChecking(true);
    try {
      // A source reinit can briefly make the backend/proxy return 5xx. Do not
      // treat that as a logout; retry transient failures before deciding.
      let res: Response | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          res = await fetch('/api/admin/session', { credentials: 'same-origin' });
        } catch {
          res = null;
        }
        if (res && res.status < 500) break;
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
      const ok = !!res?.ok;
      setAuthenticated(ok);
      if (ok) {
        // Auto-load server config and dongles on session check success
        loadServerConfig();
        loadDongles();
        loadBookmarks();
        loadDecoders();
      }
      return ok;
    } catch {
      setAuthenticated(false);
      return false;
    } finally {
      setAuthChecking(false);
    }
  }

  async function login(password: string): Promise<boolean> {
    setAuthError('');
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        setAuthenticated(true);
        // Load config and dongles on login
        loadServerConfig();
        loadDongles();
        loadBookmarks();
        loadDecoders();
        return true;
      }
      const data = await res.json().catch(() => ({ error: 'Login failed' }));
      setAuthError(data.error || 'Invalid password');
      return false;
    } catch (err) {
      setAuthError('Connection error');
      return false;
    }
  }

  async function logout(): Promise<void> {
    await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    setAuthenticated(false);
  }

  // ---- Server Config ----
  async function loadServerConfig(): Promise<void> {
    setServerConfigLoading(true);
    try {
      const res = await fetch('/api/admin/server/config', { credentials: 'same-origin' });
      if (res.ok) {
        const data = await res.json();
        const version = data.version || 0;
        setConfigVersion(version);
        // Map server response to our local type
        setServerConfig({
          port: data.port ?? DEFAULT_SERVER_CONFIG.port,
          host: data.host ?? DEFAULT_SERVER_CONFIG.host,
          adminPassword: data.adminPassword ?? '',
          callsign: data.callsign ?? '',
          description: data.description ?? '',
          location: data.location ?? '',
          receiverLatitude: data.receiverLatitude ?? 0,
          receiverLongitude: data.receiverLongitude ?? 0,
          demoMode: data.demoMode ?? false,
          identifyEnabled: data.identifyEnabled ?? true,
          usersRibbon: data.usersRibbon ?? 'users',
          fftHistoryFftSize: data.fftHistoryFftSize ?? DEFAULT_SERVER_CONFIG.fftHistoryFftSize,
          fftHistoryCompression: data.fftHistoryCompression ?? DEFAULT_SERVER_CONFIG.fftHistoryCompression,
          allowedFftCodecs: data.allowedFftCodecs ?? DEFAULT_SERVER_CONFIG.allowedFftCodecs,
          allowedIqCodecs: data.allowedIqCodecs ?? DEFAULT_SERVER_CONFIG.allowedIqCodecs,
          opusComplexity: data.opusComplexity ?? DEFAULT_SERVER_CONFIG.opusComplexity,
          realIPHeader: data.realIPHeader ?? '',
          auddApiKey: data.auddApiKey ?? '',
          acrcloudHost: data.acrcloudHost ?? '',
          acrcloudAccessKey: data.acrcloudAccessKey ?? '',
          acrcloudAccessSecret: data.acrcloudAccessSecret ?? '',
          decoderPath: data.decoderPath ?? '',
          retentionDays: data.retentionDays ?? 0,
          purgeIntervalMinutes: data.purgeIntervalMinutes ?? 30,
          maxMessages: data.maxMessages ?? 0,
        });
      }
    } catch {
      // Silent fail — config stays at defaults
    } finally {
      setServerConfigLoading(false);
    }
  }

  async function updateServerConfig(partial: Partial<ServerConfig>): Promise<boolean> {
    try {
      const res = await fetch('/api/admin/server/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(partial),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.version) setConfigVersion(data.version);
        // Update local state
        setServerConfig(prev => ({ ...prev, ...partial }));
        markDirty();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // Update a single field in-memory only (for live editing). Mark dirty.
  function updateServerConfigField<K extends keyof ServerConfig>(key: K, value: ServerConfig[K]) {
    setServerConfig(prev => ({ ...prev, [key]: value }));
    markDirty();
  }

  // ---- Dongle CRUD ----
  async function loadDongles(silent = false): Promise<void> {
    if (!silent) setDonglesLoading(true);
    try {
      // A source switch reinitialises the dongle in the background. On small
      // hosts the first follow-up request can briefly hit a proxy 502 while
      // the USB open completes, so retry transient 5xx responses.
      let res: Response | null = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          res = await fetch('/api/admin/dongles', { credentials: 'same-origin' });
        } catch {
          res = null;
        }
        if (res && res.status < 500) break;
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
      if (res?.status === 401) {
        setAuthenticated(false);
        return;
      }
      if (res?.ok) {
        const data = await res.json();
        setDongles(Array.isArray(data) ? data : []);
      }
    } catch {
      // Silent fail
    } finally {
      if (!silent) setDonglesLoading(false);
    }
  }

  async function createDongle(dongle: Partial<DongleConfig>): Promise<DongleConfig | null> {
    try {
      const res = await fetch('/api/admin/dongles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(dongle),
      });
      if (res.ok) {
        const data = await res.json();
        const version = parseInt(res.headers.get('X-Config-Version') || '0');
        if (version) setConfigVersion(version);
        await loadDongles();
        markDirty();
        return data;
      }
    } catch {}
    return null;
  }

  async function updateDongle(id: string, updates: Partial<DongleConfig>): Promise<boolean> {
    try {
      const res = await fetch(`/api/admin/dongles/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(updates),
      });
      if (res.ok) {
        const version = parseInt(res.headers.get('X-Config-Version') || '0');
        if (version) setConfigVersion(version);
        await loadDongles();
        markDirty();
        return true;
      }
    } catch {}
    return false;
  }

  async function deleteDongle(id: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/admin/dongles/${id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (res.ok) {
        const version = parseInt(res.headers.get('X-Config-Version') || '0');
        if (version) setConfigVersion(version);
        if (selectedDongleId() === id) {
          setSelectedDongleId(null);
          setSelectedProfileId(null);
        }
        await loadDongles();
        markDirty();
        return true;
      }
    } catch {}
    return false;
  }

  async function startDongle(id: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/admin/dongles/${id}/start`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (res.ok) {
        await loadDongles(true);
        return true;
      }
    } catch {}
    return false;
  }

  async function stopDongle(id: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/admin/dongles/${id}/stop`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (res.ok) {
        await loadDongles(true);
        return true;
      }
    } catch {}
    return false;
  }

  // ---- Profile CRUD ----
  async function createProfile(dongleId: string, profile: Partial<DongleProfile>): Promise<boolean> {
    try {
      const res = await fetch(`/api/admin/dongles/${dongleId}/profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(profile),
      });
      if (res.ok) {
        const version = parseInt(res.headers.get('X-Config-Version') || '0');
        if (version) setConfigVersion(version);
        await loadDongles();
        markDirty();
        return true;
      }
    } catch {}
    return false;
  }

  async function updateProfile(dongleId: string, profileId: string, updates: Partial<DongleProfile>): Promise<boolean> {
    try {
      const res = await fetch(`/api/admin/dongles/${dongleId}/profiles/${profileId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(updates),
      });
      if (res.ok) {
        const version = parseInt(res.headers.get('X-Config-Version') || '0');
        if (version) setConfigVersion(version);
        await loadDongles();
        markDirty();
        return true;
      }
    } catch {}
    return false;
  }

  async function deleteProfile(dongleId: string, profileId: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/admin/dongles/${dongleId}/profiles/${profileId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (res.ok) {
        const version = parseInt(res.headers.get('X-Config-Version') || '0');
        if (version) setConfigVersion(version);
        if (selectedProfileId() === profileId) setSelectedProfileId(null);
        await loadDongles();
        markDirty();
        return true;
      }
    } catch {}
    return false;
  }

  async function reorderProfiles(dongleId: string, order: string[]): Promise<boolean> {
    try {
      const res = await fetch(`/api/admin/dongles/${dongleId}/profiles-order`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ order }),
      });
      if (res.ok) {
        const version = parseInt(res.headers.get('X-Config-Version') || '0');
        if (version) setConfigVersion(version);
        await loadDongles();
        markDirty();
        return true;
      }
    } catch {}
    return false;
  }

  async function activateProfile(dongleId: string, profileId: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/admin/dongles/${dongleId}/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ profileId }),
      });
      return res.ok;
    } catch {}
    return false;
  }

  // ---- USB Devices ----
  async function scanUsbDevices(type?: string): Promise<void> {
    try {
      const query = type ? `?type=${encodeURIComponent(type)}` : '';
      const res = await fetch(`/api/admin/devices${query}`, { credentials: 'same-origin' });
      if (res.ok) {
        const data = await res.json();
        setUsbDevices(Array.isArray(data) ? data : []);
      }
    } catch {}
  }

  // ---- Bookmarks CRUD ----
  async function loadBookmarks(): Promise<void> {
    setBookmarksLoading(true);
    try {
      const res = await fetch('/api/admin/bookmarks', { credentials: 'same-origin' });
      if (res.ok) {
        const data = await res.json();
        setBookmarks(Array.isArray(data) ? data : []);
      }
    } catch {}
    setBookmarksLoading(false);
  }

  async function createBookmark(bm: Bookmark): Promise<boolean> {
    try {
      const res = await fetch('/api/admin/bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(bm),
      });
      if (res.ok) {
        const version = parseInt(res.headers.get('X-Config-Version') || '0');
        if (version) setConfigVersion(version);
        await loadBookmarks();
        markDirty();
        return true;
      }
    } catch {}
    return false;
  }

  async function updateBookmark(id: string, bm: Partial<Bookmark>): Promise<boolean> {
    try {
      const res = await fetch(`/api/admin/bookmarks/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ ...bm, id }),
      });
      if (res.ok) {
        const version = parseInt(res.headers.get('X-Config-Version') || '0');
        if (version) setConfigVersion(version);
        await loadBookmarks();
        markDirty();
        return true;
      }
    } catch {}
    return false;
  }

  async function deleteBookmark(id: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/admin/bookmarks/${id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (res.ok) {
        const version = parseInt(res.headers.get('X-Config-Version') || '0');
        if (version) setConfigVersion(version);
        await loadBookmarks();
        markDirty();
        return true;
      }
    } catch {}
    return false;
  }

  // ---- Background Decoder CRUD ----
  async function loadDecoders(): Promise<void> {
    setDecodersLoading(true);
    setDecodersError('');
    try {
      const res = await fetch('/api/admin/decoders', { credentials: 'same-origin' });
      if (res.status === 404) {
        // The server was built without the `decoders` feature.
        setDecoders([]);
        setDecoderModes([]);
        setDecoderSummary(null);
        setDecodersError('This server build does not include background decoders.');
        return;
      }
      if (!res.ok) {
        setDecodersError(`Failed to load decoders (HTTP ${res.status}).`);
        return;
      }
      const data = await res.json();
      setDecoders(Array.isArray(data.decoders) ? data.decoders : []);
      setDecoderModes(Array.isArray(data.modes) ? data.modes : []);
      setDecoderSummary(data.summary ?? null);
      if (data.version) setConfigVersion(data.version);
    } catch {
      setDecodersError('Connection error while loading decoders.');
    } finally {
      setDecodersLoading(false);
    }
  }

  async function createDecoder(decoder: Partial<DecoderConfig>): Promise<boolean> {
    try {
      const res = await fetch('/api/admin/decoders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(decoder),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setDecodersError(data.error || `Failed to add decoder (HTTP ${res.status}).`);
        return false;
      }
      const version = parseInt(res.headers.get('X-Config-Version') || '0');
      if (version) setConfigVersion(version);
      await loadDecoders();
      markDirty();
      return true;
    } catch {
      setDecodersError('Connection error while adding decoder.');
      return false;
    }
  }

  async function updateDecoder(id: string, updates: Partial<DecoderConfig>): Promise<boolean> {
    try {
      const res = await fetch(`/api/admin/decoders/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(updates),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setDecodersError(data.error || `Failed to update decoder (HTTP ${res.status}).`);
        return false;
      }
      const version = parseInt(res.headers.get('X-Config-Version') || '0');
      if (version) setConfigVersion(version);
      await loadDecoders();
      markDirty();
      return true;
    } catch {
      setDecodersError('Connection error while updating decoder.');
      return false;
    }
  }

  async function deleteDecoder(id: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/admin/decoders/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setDecodersError(data.error || `Failed to delete decoder (HTTP ${res.status}).`);
        return false;
      }
      const version = parseInt(res.headers.get('X-Config-Version') || '0');
      if (version) setConfigVersion(version);
      await loadDecoders();
      markDirty();
      return true;
    } catch {
      setDecodersError('Connection error while deleting decoder.');
      return false;
    }
  }

  async function reloadDecoders(): Promise<boolean> {
    try {
      const res = await fetch('/api/admin/decoders/reload', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!res.ok) return false;
      await loadDecoders();
      return true;
    } catch {
      return false;
    }
  }

  async function purgeDecoderHistory(body: {
    all?: boolean;
    mode?: string;
    olderThanDays?: number;
  }): Promise<{ messages: number; entities: number } | null> {
    try {
      // "Apply retention now" uses the server's in-memory database settings.
      // Push the edited admin fields first so the purge sees them without
      // requiring a full Save Config round trip.
      if (!body.all && !body.mode && body.olderThanDays === undefined) {
        const cfgRes = await fetch('/api/admin/server/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(serverConfig()),
        });
        if (cfgRes.ok) {
          const cfgData = await cfgRes.json();
          if (cfgData.version) setConfigVersion(cfgData.version);
        }
      }
      const res = await fetch('/api/admin/decoders/purge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setDecodersError(data.error || `Purge failed (HTTP ${res.status}).`);
        return null;
      }
      const data = await res.json();
      await loadDecoders();
      return {
        messages: data.messages ?? 0,
        entities: data.entities ?? 0,
      };
    } catch {
      setDecodersError('Connection error while purging history.');
      return null;
    }
  }

  // ---- Helpers ----
  function getSelectedDongle(): DongleConfig | undefined {
    const id = selectedDongleId();
    return id ? dongles().find(d => d.id === id) : undefined;
  }

  function getSelectedProfile(): DongleProfile | undefined {
    const dongle = getSelectedDongle();
    const profId = selectedProfileId();
    if (!dongle || !profId) return undefined;
    return dongle.profiles?.find(p => p.id === profId);
  }

  // ---- Save Config ----
  async function saveConfig(): Promise<boolean> {
    setSaving(true);
    setSaveError('');
    setSaveSuccess(false);
    try {
      // First, push current server config to backend (in-memory)
      const cfgRes = await fetch('/api/admin/server/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(serverConfig()),
      });
      if (!cfgRes.ok) {
        if (cfgRes.status === 401) {
          setAuthenticated(false);
          setAuthError('Session expired. Please log in again.');
          return false;
        }
        const data = await cfgRes.json().catch(() => ({ error: 'Failed to update server config' }));
        setSaveError(data.error || 'Failed to update config');
        return false;
      }
      const cfgData = await cfgRes.json();
      if (cfgData.version) setConfigVersion(cfgData.version);

      // Then persist to YAML
      const res = await fetch('/api/admin/save-config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'If-Match': `"${configVersion()}"`,
        },
        credentials: 'same-origin',
        body: JSON.stringify({ version: configVersion() }),
      });
      if (res.ok) {
        const data = await res.json();
        setConfigVersion(data.version || configVersion());
        setDirty(false);
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 3000);
        return true;
      }
      if (res.status === 409) {
        setSaveError('Config was modified by another admin. Please refresh and try again.');
        return false;
      }
      if (res.status === 401) {
        setAuthenticated(false);
        setAuthError('Session expired. Please log in again.');
        return false;
      }
      const data = await res.json().catch(() => ({ error: 'Save failed' }));
      setSaveError(data.error || 'Save failed');
      return false;
    } catch (err) {
      setSaveError('Connection error');
      return false;
    } finally {
      setSaving(false);
    }
  }

  // Mark dirty when any config change is made
  function markDirty() {
    setDirty(true);
    setSaveSuccess(false);
  }

  return {
    // Auth
    authenticated, setAuthenticated,
    authChecking, setAuthChecking,
    authError, setAuthError,
    checkSession, login, logout,

    // Navigation
    activeSection, setActiveSection,

    // Config version
    configVersion, setConfigVersion,

    // Server config
    serverConfig, setServerConfig,
    serverConfigLoading,
    loadServerConfig, updateServerConfig, updateServerConfigField,

    // Dongles
    dongles, donglesLoading,
    selectedDongleId, setSelectedDongleId,
    selectedProfileId, setSelectedProfileId,
    loadDongles, createDongle, updateDongle, deleteDongle,
    startDongle, stopDongle,
    getSelectedDongle, getSelectedProfile,

    // Profiles
    createProfile, updateProfile, deleteProfile,
    reorderProfiles, activateProfile,

    // USB Devices
    usbDevices, scanUsbDevices,

    // Bookmarks
    bookmarks, bookmarksLoading,
    loadBookmarks, createBookmark, updateBookmark, deleteBookmark,

    // Background decoders
    decoders, decoderModes, decoderSummary, decodersLoading, decodersError,
    loadDecoders, createDecoder, updateDecoder, deleteDecoder,
    reloadDecoders, purgeDecoderHistory,

    // Dirty / Save
    dirty, setDirty, markDirty,
    saving, setSaving,
    saveError, setSaveError,
    saveSuccess, setSaveSuccess,
    saveConfig,
  };
}

export const adminStore = createRoot(createAdminStore);
