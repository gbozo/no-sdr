// ============================================================
// Admin Store — authentication, config state, dirty tracking
// ============================================================

import { createSignal, createRoot } from 'solid-js';

export type AdminSection =
  | 'general'
  | 'devices'
  | 'bookmarks'
  | 'features'
  | 'monitor'
  | 'identify';

// ---- Dongle & Profile Types (matches Go backend) ----
export interface SourceConfig {
  type: string;
  host?: string;
  port?: number;
  deviceIndex?: number;
  serial?: string;
  binary?: string;
  extraArgs?: string[];
  spawnRtlTcp?: boolean;
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
  source: SourceConfig;
  sampleRate: number;
  gain: number;
  ppmCorrection: number;
  deviceIndex: number;
  directSampling: number;
  biasT: boolean;
  digitalAgc: boolean;
  offsetTuning: boolean;
  profiles: DongleProfile[];
}

export interface UsbDevice {
  index: number;
  name: string;
  serial: string;
  available: boolean;
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

// ---- Server Config Types ----
export interface ServerConfig {
  port: number;
  host: string;
  adminPassword: string;
  callsign: string;
  description: string;
  location: string;
  demoMode: boolean;
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
}

const DEFAULT_SERVER_CONFIG: ServerConfig = {
  port: 3000,
  host: '0.0.0.0',
  adminPassword: '',
  callsign: '',
  description: '',
  location: '',
  demoMode: false,
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
  // ---- Auth Helpers ----
  async function checkSession(): Promise<boolean> {
    setAuthChecking(true);
    try {
      const res = await fetch('/api/admin/session', { credentials: 'same-origin' });
      const ok = res.ok;
      setAuthenticated(ok);
      if (ok) {
        // Auto-load server config and dongles on session check success
        loadServerConfig();
        loadDongles();
        loadBookmarks();
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
          demoMode: data.demoMode ?? false,
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
  async function loadDongles(): Promise<void> {
    setDonglesLoading(true);
    try {
      const res = await fetch('/api/admin/dongles', { credentials: 'same-origin' });
      if (res.ok) {
        const data = await res.json();
        setDongles(Array.isArray(data) ? data : []);
      }
    } catch {
      // Silent fail
    } finally {
      setDonglesLoading(false);
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
        await loadDongles();
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
        await loadDongles();
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
  async function scanUsbDevices(): Promise<void> {
    try {
      const res = await fetch('/api/admin/devices', { credentials: 'same-origin' });
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

    // Dirty / Save
    dirty, setDirty, markDirty,
    saving, setSaving,
    saveError, setSaveError,
    saveSuccess, setSaveSuccess,
    saveConfig,
  };
}

export const adminStore = createRoot(createAdminStore);
