// ============================================================
// node-sdr — Admin Modal (GitHub-style Settings)
// ============================================================

import { Component, Show, For, createSignal, createEffect } from 'solid-js';
import { PROFILE_PRESETS, PRESET_CATEGORIES } from '@node-sdr/shared';
import { store } from '../store/index.js';
import { engine } from '../engine/sdr-engine.js';

type AdminTab = 'receivers' | 'server';

const AdminModal: Component = () => {
  const [activeTab, setActiveTab] = createSignal<AdminTab>('receivers');
  const [dongles, setDongles] = createSignal<any[]>([]);
  const [selectedDongle, setSelectedDongle] = createSignal<string | null>(null);
  const [selectedProfile, setSelectedProfile] = createSignal<string | null>(null);
  const [password, setPassword] = createSignal('');
  const [isAuthenticated, setIsAuthenticated] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [success, setSuccess] = createSignal('');
  /** When set, ReceiversTab will auto-enter edit mode for this dongle */
  const [editNewDongleId, setEditNewDongleId] = createSignal<string | null>(null);

  const apiBase = () => '';

  const authHeaders = () => ({
    'Content-Type': 'application/json',
    ...(password() ? { 'Authorization': `Bearer ${password()}` } : {}),
  });

  /** Fetch wrapper that always includes credentials for cookie-based auth */
  const adminFetch = (url: string, opts: RequestInit = {}) =>
    fetch(url, { ...opts, credentials: 'same-origin' });

  const loadDongles = async () => {
    if (!isAuthenticated()) return;
    try {
      const res = await adminFetch(`${apiBase()}/api/admin/dongles`, {
        headers: authHeaders(),
        credentials: 'same-origin',
      });
      if (res.ok) {
        const data = await res.json();
        setDongles(data);
      }
    } catch (e) {
      console.error('Failed to load dongles:', e);
    }
  };

  // Check for existing session cookie when modal opens
  createEffect(() => {
    if (store.adminModalOpen() && !isAuthenticated()) {
      fetch('/api/admin/session', { credentials: 'same-origin' })
        .then(res => {
          if (res.ok) {
            setIsAuthenticated(true);
            store.setIsAdmin(true);
            loadDongles();
          }
        })
        .catch(() => { /* no session, show login */ });
    }
  });

  createEffect(() => {
    if (isAuthenticated() && store.adminModalOpen()) {
      loadDongles();
    }
  });

  const handleLogin = async () => {
    try {
      const res = await adminFetch(`${apiBase()}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password() }),
        credentials: 'same-origin',
      });
      if (res.ok) {
        setIsAuthenticated(true);
        store.setIsAdmin(true);
        engine.adminAuth(password());
        setError('');
        await loadDongles();
      } else {
        setError('Invalid password');
      }
    } catch {
      setError('Connection failed');
    }
  };

  const handleSave = async () => {
    if (!isAuthenticated()) return;
    setSaving(true);
    setError('');
    setSuccess('');

    try {
      const res = await adminFetch(`${apiBase()}/api/admin/save-config`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${password()}`,
        },
      });
      if (res.ok) {
        setSuccess('Configuration saved!');
        await loadDongles();
      } else {
        setError('Failed to save');
      }
    } catch {
      setError('Save failed');
    }
    setSaving(false);
  };

  const handleStartDongle = async (dongleId: string) => {
    try {
      await adminFetch(`${apiBase()}/api/admin/dongles/${dongleId}/start`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${password()}` },
      });
      await loadDongles();
    } catch {
      setError('Failed to start dongle');
    }
  };

  const handleStopDongle = async (dongleId: string) => {
    try {
      await adminFetch(`${apiBase()}/api/admin/dongles/${dongleId}/stop`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${password()}` },
      });
      await loadDongles();
    } catch {
      setError('Failed to stop dongle');
    }
  };

  const handleSwitchProfile = async (dongleId: string, profileId: string) => {
    try {
      await adminFetch(`${apiBase()}/api/admin/dongles/${dongleId}/profile`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${password()}`,
        },
        body: JSON.stringify({ profileId }),
      });
      await loadDongles();
    } catch {
      setError('Failed to switch profile');
    }
  };

  const handleUpdateDongle = async (dongleId: string, updates: any) => {
    try {
      const res = await adminFetch(`${apiBase()}/api/admin/dongles/${dongleId}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(updates),
      });
      if (res.ok) {
        await loadDongles();
        setSuccess('Dongle updated!');
      } else {
        setError('Failed to update dongle');
      }
    } catch {
      setError('Failed to update dongle');
    }
  };

  const handleUpdateProfile = async (dongleId: string, profileId: string, updates: any) => {
    try {
      const res = await adminFetch(`${apiBase()}/api/admin/dongles/${dongleId}/profiles/${profileId}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(updates),
      });
      if (res.ok) {
        await loadDongles();
        setSuccess('Profile updated!');
      } else {
        setError('Failed to update profile');
      }
    } catch {
      setError('Failed to update profile');
    }
  };

  const handleDeleteDongle = async (dongleId: string) => {
    try {
      const res = await adminFetch(`${apiBase()}/api/admin/dongles/${dongleId}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (res.ok) {
        await loadDongles();
        setSelectedDongle(null);
        setSuccess('Receiver deleted');
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to delete receiver');
      }
    } catch {
      setError('Failed to delete receiver');
    }
  };

  const addNewDongle = async () => {
    setLoading(true);
    setError('');
    const newId = `dongle-${Date.now()}`;
    const newDongle = {
      id: newId,
      name: 'New Dongle',
      deviceIndex: 0,
      ppmCorrection: 0,
      source: { type: 'local' },
      enabled: false,
      autoStart: false,
      profiles: [{
        id: 'default',
        name: 'Default Profile',
        centerFrequency: 100_000_000,
        sampleRate: 2_400_000,
        fftSize: 2048,
        fftFps: 30,
        defaultMode: 'wfm',
        defaultTuneOffset: 0,
        defaultBandwidth: 200_000,
        gain: null,
        description: '',
        decoders: [],
      }],
    };
    try {
      const res = await adminFetch(`${apiBase()}/api/admin/dongles`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(newDongle),
      });
      if (res.ok) {
        await loadDongles();
        setSelectedDongle(newId);
        setEditNewDongleId(newId);
        setSuccess('Receiver created — configure it below');
      } else {
        setError('Failed to add dongle');
      }
    } catch {
      setError('Failed to add dongle');
    }
    setLoading(false);
  };

  const addNewProfile = async (preset?: any) => {
    if (!selectedDongle()) return;
    setLoading(true);
    setError('');
    const newProfile = preset ? {
      id: `profile-${Date.now()}`,
      name: preset.name,
      centerFrequency: preset.centerFrequency,
      sampleRate: preset.sampleRate,
      fftSize: preset.fftSize,
      fftFps: preset.fftFps,
      defaultMode: preset.defaultMode,
      defaultTuneOffset: preset.defaultTuneOffset,
      defaultBandwidth: preset.defaultBandwidth,
      gain: preset.gain,
      description: preset.description,
      directSampling: preset.directSampling ?? 0,
      decoders: [],
    } : {
      id: `profile-${Date.now()}`,
      name: 'New Profile',
      centerFrequency: 100000000,
      sampleRate: 2400000,
      fftSize: 2048,
      fftFps: 30,
      defaultMode: 'wfm',
      defaultTuneOffset: 0,
      defaultBandwidth: 200000,
      gain: null,
      description: '',
      decoders: [],
    };
    try {
      const res = await adminFetch(`${apiBase()}/api/admin/dongles/${selectedDongle()}/profiles`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(newProfile),
      });
      const data = await res.json();
      console.log('Add profile response:', res.status, data);
      if (res.ok) {
        await loadDongles();
        setSuccess(preset ? `Profile "${preset.name}" added from preset!` : 'Profile added!');
      } else {
        setError(data.error || 'Failed to add profile');
      }
    } catch (e: any) {
      console.error('Add profile error:', e);
      setError('Failed to add profile');
    }
    setLoading(false);
  };

  const handleDeleteProfile = async (dongleId: string, profileId: string) => {
    try {
      const res = await adminFetch(`${apiBase()}/api/admin/dongles/${dongleId}/profiles/${profileId}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (res.ok) {
        await loadDongles();
        setSuccess('Profile deleted');
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to delete profile');
      }
    } catch {
      setError('Failed to delete profile');
    }
  };

  const handleReorderProfiles = async (dongleId: string, profileIds: string[]) => {
    try {
      const res = await adminFetch(`${apiBase()}/api/admin/dongles/${dongleId}/profiles-order`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ profileIds }),
      });
      if (res.ok) {
        await loadDongles();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to reorder profiles');
      }
    } catch {
      setError('Failed to reorder profiles');
    }
  };

  const closeModal = () => {
    store.setAdminModalOpen(false);
    setError('');
    setSuccess('');
  };

  return (
    <Show when={store.adminModalOpen()}>
      {/* Backdrop */}
      <div
        class="fixed inset-0 bg-black/60 z-50"
        onClick={closeModal}
      />

      {/* Modal */}
      <div class="fixed inset-4 md:inset-10 bg-sdr-surface border border-border rounded-lg shadow-2xl z-50 flex overflow-hidden">
        {/* Sidebar */}
        <div class="w-56 bg-sdr-base border-r border-border flex flex-col">
          <div class="p-4 border-b border-border">
            <h2 class="font-mono text-sm font-bold text-text-primary">Settings</h2>
          </div>

          <nav class="flex-1 p-2 space-y-0.5">
            <TabButton
              active={activeTab() === 'receivers'}
              onClick={() => setActiveTab('receivers')}
            >
              Receivers
            </TabButton>
            <TabButton
              active={activeTab() === 'server'}
              onClick={() => setActiveTab('server')}
            >
              Server
            </TabButton>
          </nav>

          <div class="p-3 border-t border-border">
            <Show when={isAuthenticated()} fallback={
              <div class="space-y-2">
                <input
                  type="password"
                  aria-label="Admin password"
                  placeholder="Admin password"
                  value={password()}
                  onInput={(e) => setPassword(e.currentTarget.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                  class="w-full bg-sdr-surface border border-border rounded-sm px-2 py-1.5
                         text-[10px] font-mono text-text-primary placeholder:text-text-muted
                         focus:border-border-focus focus:outline-none"
                />
                <button
                  class="sdr-btn sdr-btn-primary w-full text-[10px]"
                  onClick={handleLogin}
                >
                  Login
                </button>
              </div>
            }>
              <div class="flex items-center justify-between">
                <span class="text-[10px] font-mono text-amber">Authenticated</span>
                <button
                  class="text-[9px] font-mono text-text-dim hover:text-text-secondary"
                  onClick={() => {
                    fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
                    setIsAuthenticated(false);
                    store.setIsAdmin(false);
                  }}
                >
                  Logout
                </button>
              </div>
            </Show>
          </div>
        </div>

        {/* Content */}
        <div class="flex-1 flex flex-col overflow-hidden">
          {/* Header */}
          <div class="h-14 px-4 border-b border-border flex items-center justify-between shrink-0">
            <h3 class="font-mono text-sm font-semibold text-text-primary">
              {activeTab() === 'receivers' && 'Receivers & Profiles'}
              {activeTab() === 'server' && 'Server Configuration'}
            </h3>
            <button
              class="text-text-dim hover:text-text-secondary text-xl leading-none"
              onClick={closeModal}
            >
              ×
            </button>
          </div>

          {/* Body */}
          <div class="flex-1 overflow-y-auto p-4">
            <Show when={!isAuthenticated()}>
              <div class="flex flex-col items-center justify-center h-full text-center">
                <div class="text-4xl mb-4">🔒</div>
                <p class="text-text-secondary text-sm">Enter admin password to configure</p>
              </div>
            </Show>

            <Show when={isAuthenticated()}>
              <Show when={activeTab() === 'receivers'}>
                <ReceiversTab
                  dongles={dongles()}
                  selectedDongle={selectedDongle()}
                  onSelect={setSelectedDongle}
                  onAddDongle={addNewDongle}
                  onAddProfile={addNewProfile}
                  onStart={handleStartDongle}
                  onStop={handleStopDongle}
                  onUpdateDongle={handleUpdateDongle}
                  onUpdateProfile={handleUpdateProfile}
                  onDeleteDongle={handleDeleteDongle}
                  onDeleteProfile={handleDeleteProfile}
                  onReorderProfiles={handleReorderProfiles}
                  onSwitchProfile={handleSwitchProfile}
                  password={password}
                  editNewDongleId={editNewDongleId()}
                  onEditNewDongleHandled={() => setEditNewDongleId(null)}
                />
              </Show>

              <Show when={activeTab() === 'server'}>
                <ServerTab password={password} />
              </Show>
            </Show>
          </div>

          {/* Footer */}
          <Show when={isAuthenticated()}>
            <div class="px-4 py-3 border-t border-border flex items-center justify-between">
              <Show when={error()}>
                <span class="text-[10px] font-mono text-status-error">{error()}</span>
              </Show>
              <Show when={success()}>
                <span class="text-[10px] font-mono text-status-online">{success()}</span>
              </Show>
              <div class="flex gap-2 ml-auto">
                <button class="sdr-btn text-[10px]" onClick={closeModal}>
                  Close
                </button>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
};

const TabButton: Component<{ active: boolean; onClick: () => void; children: any }> = (props) => (
  <button
    class={`w-full text-left px-3 py-2 rounded-md text-[11px] font-mono transition-colors
            ${props.active
              ? 'bg-cyan-dim text-cyan'
              : 'text-text-secondary hover:bg-sdr-hover hover:text-text-primary'}`}
    onClick={props.onClick}
  >
    {props.children}
  </button>
);

// ---- Unified Receivers & Profiles Tab ----

const ReceiversTab: Component<{
  dongles: any[];
  selectedDongle: string | null;
  onSelect: (id: string) => void;
  onAddDongle: () => void;
  onAddProfile: (preset?: any) => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onUpdateDongle: (dongleId: string, updates: any) => void;
  onUpdateProfile: (dongleId: string, profileId: string, updates: any) => void;
  onDeleteDongle: (dongleId: string) => void;
  onDeleteProfile: (dongleId: string, profileId: string) => void;
  onReorderProfiles: (dongleId: string, profileIds: string[]) => void;
  onSwitchProfile: (dongleId: string, profileId: string) => void;
  password: () => string;
  /** When set, auto-enter edit mode for this dongle ID */
  editNewDongleId?: string | null;
  /** Called after the edit-new signal has been consumed */
  onEditNewDongleHandled?: () => void;
}> = (props) => {
  const currentDongle = () => props.dongles.find((d: any) => d.id === props.selectedDongle);
  const [activeProfileTab, setActiveProfileTab] = createSignal<string | null>(null);
  const [editingDongle, setEditingDongle] = createSignal(false);
  const [dongleForm, setDongleForm] = createSignal<any>({});
  const [profileForm, setProfileForm] = createSignal<any>({});
  const [profileDirty, setProfileDirty] = createSignal(false);

  // Auto-select first profile when dongle changes
  createEffect(() => {
    const d = currentDongle();
    if (d?.profiles?.length > 0) {
      setActiveProfileTab(d.profiles[0].id);
    } else {
      setActiveProfileTab(null);
    }
  });

  // Auto-enter edit mode when a new dongle is created
  createEffect(() => {
    const newId = props.editNewDongleId;
    if (newId && props.selectedDongle === newId) {
      const d = props.dongles.find((dd: any) => dd.id === newId);
      if (d) {
        setDongleForm({
          name: d.name,
          sourceType: d.source?.type || 'local',
          host: d.source?.host || '',
          port: d.source?.port || 1234,
          ppmCorrection: d.ppmCorrection || 0,
          deviceIndex: d.deviceIndex || 0,
          biasT: d.biasT || false,
          digitalAgc: d.digitalAgc || false,
          directSampling: d.directSampling || 0,
          offsetTuning: d.offsetTuning || false,
          autoStart: d.autoStart !== false,
          enabled: d.enabled !== false,
        });
        setEditingDongle(true);
        props.onEditNewDongleHandled?.();
      }
    }
  });

  const activeProfile = () => {
    const d = currentDongle();
    return d?.profiles?.find((p: any) => p.id === activeProfileTab());
  };

  // Load profile into form when tab changes
  createEffect(() => {
    const p = activeProfile();
    if (p) {
      setProfileForm({ ...p });
      setProfileDirty(false);
    }
  });

  const startDongleEdit = () => {
    const d = currentDongle();
    if (d) {
      setDongleForm({
        name: d.name,
        sourceType: d.source?.type || 'local',
        host: d.source?.host || '',
        port: d.source?.port || 1234,
        ppmCorrection: d.ppmCorrection || 0,
        deviceIndex: d.deviceIndex || 0,
        biasT: d.biasT || false,
        digitalAgc: d.digitalAgc || false,
        directSampling: d.directSampling || 0,
        offsetTuning: d.offsetTuning || false,
        autoStart: d.autoStart !== false,
        enabled: d.enabled !== false,
      });
      setEditingDongle(true);
    }
  };

  const saveDongle = () => {
    const d = currentDongle();
    if (d && dongleForm()) {
      props.onUpdateDongle(d.id, {
        name: dongleForm().name,
        source: {
          type: dongleForm().sourceType,
          ...(dongleForm().host ? { host: dongleForm().host } : {}),
          ...(dongleForm().port ? { port: dongleForm().port } : {}),
        },
        deviceIndex: dongleForm().deviceIndex,
        ppmCorrection: dongleForm().ppmCorrection,
        biasT: dongleForm().biasT,
        digitalAgc: dongleForm().digitalAgc,
        directSampling: dongleForm().directSampling,
        offsetTuning: dongleForm().offsetTuning,
        autoStart: dongleForm().autoStart,
        enabled: dongleForm().enabled,
      });
      setEditingDongle(false);
    }
  };

  const saveProfile = () => {
    const d = currentDongle();
    const pId = activeProfileTab();
    if (d && pId && profileForm()) {
      props.onUpdateProfile(d.id, pId, profileForm());
      setProfileDirty(false);
    }
  };

  const updateProfileField = (key: string, value: any) => {
    setProfileForm((prev: any) => ({ ...prev, [key]: value }));
    setProfileDirty(true);
  };

  return (
    <div class="space-y-4">
      {/* Dongle selector row */}
      <div class="flex items-center gap-3">
        <select
          class="flex-1 bg-sdr-base border border-border rounded-sm px-3 py-1.5
                 text-[11px] font-mono text-text-primary
                 focus:border-border-focus focus:outline-none"
          value={props.selectedDongle || ''}
          onChange={(e) => props.onSelect(e.currentTarget.value)}
        >
          <option value="">Select a receiver...</option>
          <For each={props.dongles}>
            {(dongle) => (
              <option value={dongle.id}>
                {dongle.name} ({dongle.source?.type || 'local'}) {dongle.enabled === false ? '⊘ Disabled' : dongle.running ? '● Running' : '○ Stopped'}
              </option>
            )}
          </For>
        </select>
        <button class="sdr-btn sdr-btn-primary text-[9px] whitespace-nowrap" onClick={props.onAddDongle}>
          + Receiver
        </button>
      </div>

      {/* Dongle hardware settings */}
      <Show when={currentDongle()}>
        {(dongle) => (
          <div class="border border-border rounded-md">
            {/* Dongle header */}
            <div class="flex items-center justify-between px-3 py-2 border-b border-border bg-sdr-base rounded-t-md">
              <div class="flex items-center gap-2">
                <div class={`w-2 h-2 rounded-full ${dongle().enabled === false ? 'bg-text-muted' : dongle().running ? 'bg-status-online' : 'bg-status-offline'}`} />
                <span class="text-[11px] font-mono text-text-primary font-medium">{dongle().name}</span>
                <Show when={dongle().enabled === false}>
                  <span class="text-[8px] font-mono text-text-muted bg-sdr-elevated px-1.5 py-0.5 rounded">DISABLED</span>
                </Show>
              </div>
              <div class="flex items-center gap-1.5">
                <button class="sdr-btn text-[8px]" onClick={() => props.onStart(dongle().id)} disabled={dongle().enabled === false}>Start</button>
                <button class="sdr-btn text-[8px]" onClick={() => props.onStop(dongle().id)}>Stop</button>
                <button class="sdr-btn sdr-btn-primary text-[8px]" onClick={startDongleEdit}>
                  {editingDongle() ? 'Cancel' : 'Edit'}
                </button>
              </div>
            </div>

            {/* Connection info (always visible) */}
            <Show when={!editingDongle()}>
              <div class="px-3 py-2 border-b border-border bg-sdr-surface">
                <div class="flex items-center gap-4 text-[9px] font-mono">
                  <div class="flex items-center gap-1.5">
                    <span class="text-text-dim">Source:</span>
                    <span class="text-text-primary font-medium">{dongle().source?.type || 'local'}</span>
                  </div>
                  <Show when={dongle().source?.host}>
                    <div class="flex items-center gap-1.5">
                      <span class="text-text-dim">Host:</span>
                      <span class="text-text-primary">{dongle().source?.host}:{dongle().source?.port || 1234}</span>
                    </div>
                  </Show>
                  <div class="flex items-center gap-1.5">
                    <span class="text-text-dim">Device:</span>
                    <span class="text-text-primary">{dongle().deviceIndex ?? 0}</span>
                  </div>
                  <Show when={dongle().ppmCorrection}>
                    <div class="flex items-center gap-1.5">
                      <span class="text-text-dim">PPM:</span>
                      <span class="text-text-primary">{dongle().ppmCorrection}</span>
                    </div>
                  </Show>
                </div>
              </div>
            </Show>

            {/* Dongle edit form */}
            <Show when={editingDongle()}>
              <div class="p-3 border-b border-border bg-sdr-elevated space-y-3">
                <div class="grid grid-cols-2 gap-3">
                  <div>
                    <label class="block text-[9px] font-mono text-text-dim mb-0.5">Name</label>
                    <input type="text" value={dongleForm().name || ''} onInput={(e) => setDongleForm({...dongleForm(), name: e.currentTarget.value})}
                      class="w-full bg-sdr-base border border-border rounded-sm px-2 py-1 text-[10px] font-mono text-text-primary focus:border-border-focus focus:outline-none" />
                  </div>
                  <div>
                    <label class="block text-[9px] font-mono text-text-dim mb-0.5">Source Type</label>
                    <select value={dongleForm().sourceType || 'local'} onChange={(e) => setDongleForm({...dongleForm(), sourceType: e.currentTarget.value})}
                      class="w-full bg-sdr-base border border-border rounded-sm px-2 py-1 text-[10px] font-mono text-text-primary focus:border-border-focus focus:outline-none">
                      <option value="local">Local (USB)</option>
                      <option value="rtl_tcp">RTL-TCP</option>
                      <option value="airspy_tcp">AirSpy TCP</option>
                      <option value="hfp_tcp">HF+ TCP</option>
                      <option value="rsp_tcp">SDRplay TCP</option>
                      <option value="demo">Demo</option>
                    </select>
                  </div>
                </div>

                <Show when={['rtl_tcp', 'airspy_tcp', 'hfp_tcp', 'rsp_tcp'].includes(dongleForm().sourceType)}>
                  <div class="grid grid-cols-2 gap-3">
                    <div>
                      <label class="block text-[9px] font-mono text-text-dim mb-0.5">Host</label>
                      <input type="text" value={dongleForm().host || ''} onInput={(e) => setDongleForm({...dongleForm(), host: e.currentTarget.value})}
                        placeholder="192.168.1.100"
                        class="w-full bg-sdr-base border border-border rounded-sm px-2 py-1 text-[10px] font-mono text-text-primary focus:border-border-focus focus:outline-none" />
                    </div>
                    <div>
                      <label class="block text-[9px] font-mono text-text-dim mb-0.5">Port</label>
                      <input type="number" value={dongleForm().port || 1234} onInput={(e) => setDongleForm({...dongleForm(), port: parseInt(e.currentTarget.value) || 1234})}
                        class="w-full bg-sdr-base border border-border rounded-sm px-2 py-1 text-[10px] font-mono text-text-primary focus:border-border-focus focus:outline-none" />
                    </div>
                  </div>
                </Show>

                <div class="grid grid-cols-3 gap-3">
                  <div>
                    <label class="block text-[9px] font-mono text-text-dim mb-0.5">Device Index</label>
                    <input type="number" min="0" value={dongleForm().deviceIndex || 0} onInput={(e) => setDongleForm({...dongleForm(), deviceIndex: parseInt(e.currentTarget.value) || 0})}
                      class="w-full bg-sdr-base border border-border rounded-sm px-2 py-1 text-[10px] font-mono text-text-primary focus:border-border-focus focus:outline-none" />
                  </div>
                  <div>
                    <label class="block text-[9px] font-mono text-text-dim mb-0.5">PPM Correction</label>
                    <input type="number" step="0.1" value={dongleForm().ppmCorrection || 0} onInput={(e) => setDongleForm({...dongleForm(), ppmCorrection: parseFloat(e.currentTarget.value) || 0})}
                      class="w-full bg-sdr-base border border-border rounded-sm px-2 py-1 text-[10px] font-mono text-text-primary focus:border-border-focus focus:outline-none" />
                  </div>
                  <div>
                    <label class="block text-[9px] font-mono text-text-dim mb-0.5">Direct Sampling</label>
                    <select value={dongleForm().directSampling || 0} onChange={(e) => setDongleForm({...dongleForm(), directSampling: parseInt(e.currentTarget.value)})}
                      class="w-full bg-sdr-base border border-border rounded-sm px-2 py-1 text-[10px] font-mono text-text-primary focus:border-border-focus focus:outline-none">
                      <option value={0}>Off</option>
                      <option value={1}>I-ADC (Q branch)</option>
                      <option value={2}>Q-ADC (I branch)</option>
                    </select>
                  </div>
                </div>

                <div class="flex flex-wrap gap-4">
                  <label class="flex items-center gap-1.5 text-[9px] font-mono text-text-secondary">
                    <input type="checkbox" checked={dongleForm().enabled !== false} onChange={(e) => setDongleForm({...dongleForm(), enabled: e.currentTarget.checked})} class="accent-cyan" />
                    Enabled
                  </label>
                  <label class="flex items-center gap-1.5 text-[9px] font-mono text-text-secondary">
                    <input type="checkbox" checked={dongleForm().autoStart !== false} onChange={(e) => setDongleForm({...dongleForm(), autoStart: e.currentTarget.checked})} class="accent-cyan" />
                    Auto-start
                  </label>
                  <label class="flex items-center gap-1.5 text-[9px] font-mono text-text-secondary">
                    <input type="checkbox" checked={dongleForm().biasT || false} onChange={(e) => setDongleForm({...dongleForm(), biasT: e.currentTarget.checked})} class="accent-cyan" />
                    Bias-T
                  </label>
                  <label class="flex items-center gap-1.5 text-[9px] font-mono text-text-secondary">
                    <input type="checkbox" checked={dongleForm().digitalAgc || false} onChange={(e) => setDongleForm({...dongleForm(), digitalAgc: e.currentTarget.checked})} class="accent-cyan" />
                    Digital AGC
                  </label>
                  <label class="flex items-center gap-1.5 text-[9px] font-mono text-text-secondary">
                    <input type="checkbox" checked={dongleForm().offsetTuning || false} onChange={(e) => setDongleForm({...dongleForm(), offsetTuning: e.currentTarget.checked})} class="accent-cyan" />
                    Offset Tuning
                  </label>
                </div>

                <div class="flex items-center justify-between">
                  <div class="flex gap-2">
                    <button class="sdr-btn text-[9px]" onClick={() => setEditingDongle(false)}>Cancel</button>
                    <button class="sdr-btn sdr-btn-primary text-[9px]" onClick={saveDongle}>Save Receiver</button>
                  </div>
                  <button
                    class="sdr-btn text-[9px] text-red-400 hover:text-red-300 hover:border-red-400/50"
                    onClick={() => {
                      if (confirm('Delete this receiver? This cannot be undone.')) {
                        const d = currentDongle();
                        if (d) props.onDeleteDongle(d.id);
                      }
                    }}
                  >
                    Delete Receiver
                  </button>
                </div>
              </div>
            </Show>

            {/* Profile tabs */}
            <div class="flex flex-wrap items-center gap-0 border-b border-border bg-sdr-base">
              <For each={dongle().profiles || []}>
                {(profile: any) => (
                  <button
                    class={`px-3 py-1.5 text-[9px] font-mono border-b-2 transition-colors
                      ${activeProfileTab() === profile.id
                        ? 'border-cyan text-cyan bg-sdr-surface'
                        : 'border-transparent text-text-dim hover:text-text-secondary hover:bg-sdr-elevated'}`}
                    onClick={() => setActiveProfileTab(profile.id)}
                  >
                    {profile.name}
                  </button>
                )}
              </For>
              <button
                class="px-3 py-1.5 text-[9px] font-mono text-text-muted hover:text-cyan border-b-2 border-transparent transition-colors"
                onClick={() => props.onAddProfile()}
                title="Add blank profile"
              >
                +
              </button>
              <select
                class="px-2 py-1 text-[8px] font-mono text-text-muted bg-transparent border-b-2 border-transparent
                       hover:text-cyan focus:text-cyan focus:outline-none cursor-pointer"
                value=""
                onChange={(e) => {
                  const presetId = e.currentTarget.value;
                  if (presetId) {
                    const preset = PROFILE_PRESETS.find(p => p.id === presetId);
                    if (preset) props.onAddProfile(preset);
                    e.currentTarget.value = '';
                  }
                }}
                title="Add profile from preset"
              >
                <option value="">+ From preset...</option>
                <For each={Object.entries(PRESET_CATEGORIES)}>
                  {([catId, catName]) => (
                    <optgroup label={catName}>
                      <For each={PROFILE_PRESETS.filter(p => p.category === catId)}>
                        {(preset) => (
                          <option value={preset.id}>{preset.name}</option>
                        )}
                      </For>
                    </optgroup>
                  )}
                </For>
              </select>
            </div>

            {/* Active profile editor */}
            <Show when={activeProfile()} fallback={
              <div class="p-4 text-[10px] font-mono text-text-dim">
                No profiles yet. Click + to create one.
              </div>
            }>
              {(_profile) => (
                <div class="p-3 space-y-4">
                  {/* Row 1: Name + Mode + Description */}
                  <div class="grid grid-cols-3 gap-3">
                    <div>
                      <label class="block text-[9px] font-mono text-text-dim mb-0.5">Profile Name</label>
                      <input type="text" value={profileForm().name || ''} onInput={(e) => updateProfileField('name', e.currentTarget.value)}
                        class="w-full bg-sdr-base border border-border rounded-sm px-2 py-1 text-[10px] font-mono text-text-primary focus:border-border-focus focus:outline-none" />
                    </div>
                    <div>
                      <label class="block text-[9px] font-mono text-text-dim mb-0.5">Default Mode</label>
                      <select value={profileForm().defaultMode || 'nfm'} onChange={(e) => updateProfileField('defaultMode', e.currentTarget.value)}
                        class="w-full bg-sdr-base border border-border rounded-sm px-2 py-1 text-[10px] font-mono text-text-primary focus:border-border-focus focus:outline-none">
                        <option value="wfm">WFM (Wideband FM)</option>
                        <option value="nfm">NFM (Narrowband FM)</option>
                        <option value="am">AM (Amplitude Mod)</option>
                        <option value="am-stereo">AM Stereo (C-QUAM)</option>
                        <option value="usb">USB (Upper Sideband)</option>
                        <option value="lsb">LSB (Lower Sideband)</option>
                        <option value="cw">CW (Morse)</option>
                        <option value="raw">RAW (Passthrough)</option>
                      </select>
                    </div>
                    <div>
                      <label class="block text-[9px] font-mono text-text-dim mb-0.5">Description</label>
                      <input type="text" value={profileForm().description || ''} onInput={(e) => updateProfileField('description', e.currentTarget.value)}
                        placeholder="e.g. FM broadcast band"
                        class="w-full bg-sdr-base border border-border rounded-sm px-2 py-1 text-[10px] font-mono text-text-primary placeholder:text-text-muted focus:border-border-focus focus:outline-none" />
                    </div>
                  </div>

                  {/* Row 2: Frequency settings */}
                  <div>
                    <h4 class="text-[9px] font-mono text-text-secondary uppercase tracking-wider mb-2">Frequency & Sampling</h4>
                    <div class="grid grid-cols-4 gap-3">
                      <div>
                        <label class="block text-[9px] font-mono text-text-dim mb-0.5">Center Frequency (Hz)</label>
                        <input type="number" value={profileForm().centerFrequency || 0} onInput={(e) => updateProfileField('centerFrequency', parseInt(e.currentTarget.value) || 0)}
                          class="w-full bg-sdr-base border border-border rounded-sm px-2 py-1 text-[10px] font-mono text-text-primary focus:border-border-focus focus:outline-none" />
                        <span class="text-[8px] font-mono text-text-muted">{((profileForm().centerFrequency || 0) / 1e6).toFixed(4)} MHz</span>
                      </div>
                      <div>
                        <label class="block text-[9px] font-mono text-text-dim mb-0.5">Sample Rate (S/s)</label>
                        <select value={profileForm().sampleRate || 2400000} onChange={(e) => updateProfileField('sampleRate', parseInt(e.currentTarget.value))}
                          class="w-full bg-sdr-base border border-border rounded-sm px-2 py-1 text-[10px] font-mono text-text-primary focus:border-border-focus focus:outline-none">
                          <option value={250000}>250 kS/s</option>
                          <option value={500000}>500 kS/s</option>
                          <option value={1000000}>1.0 MS/s</option>
                          <option value={1024000}>1.024 MS/s</option>
                          <option value={1200000}>1.2 MS/s</option>
                          <option value={1400000}>1.4 MS/s</option>
                          <option value={1600000}>1.6 MS/s</option>
                          <option value={1800000}>1.8 MS/s</option>
                          <option value={2000000}>2.0 MS/s</option>
                          <option value={2400000}>2.4 MS/s</option>
                          <option value={2800000}>2.8 MS/s</option>
                          <option value={3200000}>3.2 MS/s</option>
                        </select>
                      </div>
                      <div>
                        <label class="block text-[9px] font-mono text-text-dim mb-0.5">Default Bandwidth (Hz)</label>
                        <input type="number" value={profileForm().defaultBandwidth || 12500} onInput={(e) => updateProfileField('defaultBandwidth', parseInt(e.currentTarget.value) || 12500)}
                          class="w-full bg-sdr-base border border-border rounded-sm px-2 py-1 text-[10px] font-mono text-text-primary focus:border-border-focus focus:outline-none" />
                      </div>
                      <div>
                        <label class="block text-[9px] font-mono text-text-dim mb-0.5">Tuning Step (Hz)</label>
                        <select
                          value={profileForm().tuningStep || ''}
                          onChange={(e) => {
                            const v = e.currentTarget.value;
                            updateProfileField('tuningStep', v === '' ? undefined : parseInt(v));
                          }}
                          class="w-full bg-sdr-base border border-border rounded-sm px-2 py-1 text-[10px] font-mono text-text-primary focus:border-border-focus focus:outline-none"
                        >
                          <option value="">Auto (bandwidth)</option>
                          <option value={1}>1 Hz</option>
                          <option value={10}>10 Hz</option>
                          <option value={100}>100 Hz</option>
                          <option value={500}>500 Hz</option>
                          <option value={1000}>1 kHz</option>
                          <option value={2500}>2.5 kHz</option>
                          <option value={5000}>5 kHz</option>
                          <option value={6250}>6.25 kHz</option>
                          <option value={8330}>8.33 kHz</option>
                          <option value={9000}>9 kHz</option>
                          <option value={10000}>10 kHz</option>
                          <option value={12500}>12.5 kHz</option>
                          <option value={25000}>25 kHz</option>
                          <option value={50000}>50 kHz</option>
                          <option value={100000}>100 kHz</option>
                          <option value={200000}>200 kHz</option>
                        </select>
                        <span class="text-[8px] font-mono text-text-muted">Click/arrow step</span>
                      </div>
                    </div>
                  </div>

                  {/* Row 3: Gain & FFT */}
                  <div>
                    <h4 class="text-[9px] font-mono text-text-secondary uppercase tracking-wider mb-2">Gain & FFT</h4>
                    <div class="grid grid-cols-4 gap-3">
                      <div>
                        <label class="block text-[9px] font-mono text-text-dim mb-0.5">RF Gain (dB)</label>
                        <input type="number" step="0.1"
                          value={profileForm().gain ?? ''}
                          onInput={(e) => {
                            const v = e.currentTarget.value;
                            updateProfileField('gain', v === '' ? null : parseFloat(v));
                          }}
                          placeholder="Auto"
                          class="w-full bg-sdr-base border border-border rounded-sm px-2 py-1 text-[10px] font-mono text-text-primary placeholder:text-text-muted focus:border-border-focus focus:outline-none" />
                        <span class="text-[8px] font-mono text-text-muted">Empty = AGC</span>
                      </div>
                      <div>
                        <label class="block text-[9px] font-mono text-text-dim mb-0.5">FFT Size</label>
                        <select value={profileForm().fftSize || 2048} onChange={(e) => updateProfileField('fftSize', parseInt(e.currentTarget.value))}
                          class="w-full bg-sdr-base border border-border rounded-sm px-2 py-1 text-[10px] font-mono text-text-primary focus:border-border-focus focus:outline-none">
                          <option value={256}>256</option>
                          <option value={512}>512</option>
                          <option value={1024}>1024</option>
                          <option value={2048}>2048</option>
                          <option value={4096}>4096</option>
                          <option value={8192}>8192</option>
                          <option value={16384}>16384</option>
                          <option value={32768}>32768</option>
                          <option value={65536}>65536</option>
                        </select>
                      </div>
                      <div>
                        <label class="block text-[9px] font-mono text-text-dim mb-0.5">FFT FPS</label>
                        <input type="number" min="1" max="60" value={profileForm().fftFps || 30} onInput={(e) => updateProfileField('fftFps', Math.max(1, Math.min(60, parseInt(e.currentTarget.value) || 30)))}
                          class="w-full bg-sdr-base border border-border rounded-sm px-2 py-1 text-[10px] font-mono text-text-primary focus:border-border-focus focus:outline-none" />
                      </div>
                      <div>
                        <label class="block text-[9px] font-mono text-text-dim mb-0.5">Tune Offset (Hz)</label>
                        <input type="number" value={profileForm().defaultTuneOffset || 0} onInput={(e) => updateProfileField('defaultTuneOffset', parseInt(e.currentTarget.value) || 0)}
                          class="w-full bg-sdr-base border border-border rounded-sm px-2 py-1 text-[10px] font-mono text-text-primary focus:border-border-focus focus:outline-none" />
                      </div>
                    </div>
                  </div>

                  {/* Row 4: Hardware overrides (per-profile) */}
                  <div>
                    <h4 class="text-[9px] font-mono text-text-secondary uppercase tracking-wider mb-2">Hardware Overrides</h4>
                    <div class="grid grid-cols-3 gap-3">
                      <div>
                        <label class="block text-[9px] font-mono text-text-dim mb-0.5">Direct Sampling</label>
                        <select value={profileForm().directSampling ?? 0} onChange={(e) => updateProfileField('directSampling', parseInt(e.currentTarget.value))}
                          class="w-full bg-sdr-base border border-border rounded-sm px-2 py-1 text-[10px] font-mono text-text-primary focus:border-border-focus focus:outline-none">
                          <option value={0}>Off (normal tuner)</option>
                          <option value={1}>I-ADC (HF via I branch)</option>
                          <option value={2}>Q-ADC (HF via Q branch)</option>
                        </select>
                      </div>
                      <div>
                        <label class="block text-[9px] font-mono text-text-dim mb-0.5">Oscillator Offset (Hz)</label>
                        <input type="number" value={profileForm().oscillatorOffset ?? 0} onInput={(e) => updateProfileField('oscillatorOffset', parseInt(e.currentTarget.value) || 0)}
                          class="w-full bg-sdr-base border border-border rounded-sm px-2 py-1 text-[10px] font-mono text-text-primary focus:border-border-focus focus:outline-none" />
                        <span class="text-[8px] font-mono text-text-muted">Compensates LO error</span>
                      </div>
                      <div class="flex flex-col gap-2 justify-center">
                        <label class="flex items-center gap-1.5 text-[9px] font-mono text-text-secondary">
                          <input type="checkbox" checked={profileForm().biasT ?? false} onChange={(e) => updateProfileField('biasT', e.currentTarget.checked || undefined)} class="accent-cyan" />
                          Bias-T
                        </label>
                        <label class="flex items-center gap-1.5 text-[9px] font-mono text-text-secondary">
                          <input type="checkbox" checked={profileForm().offsetTuning ?? false} onChange={(e) => updateProfileField('offsetTuning', e.currentTarget.checked || undefined)} class="accent-cyan" />
                          Offset Tuning
                        </label>
                        <label class="flex items-center gap-1.5 text-[9px] font-mono text-text-secondary">
                          <input type="checkbox" checked={profileForm().swapIQ ?? false} onChange={(e) => updateProfileField('swapIQ', e.currentTarget.checked)} class="accent-cyan" />
                          Swap I/Q
                        </label>
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div class="flex items-center justify-between pt-2 border-t border-border">
                    <div class="flex items-center gap-2">
                      <button
                        class={`sdr-btn sdr-btn-primary text-[9px] ${!profileDirty() ? 'opacity-50' : ''}`}
                        onClick={saveProfile}
                        disabled={!profileDirty()}
                      >
                        Save Profile
                      </button>
                      <button
                        class="sdr-btn text-[9px]"
                        onClick={() => props.onSwitchProfile(dongle().id, activeProfileTab()!)}
                      >
                        Activate
                      </button>
                      <Show when={store.activeProfileId() === activeProfileTab()}>
                        <span class="text-[9px] font-mono text-status-online ml-2">Active</span>
                      </Show>
                    </div>
                    <div class="flex items-center gap-1.5">
                      {/* Move left / right */}
                      <button
                        class="sdr-btn text-[8px] px-1.5"
                        title="Move profile left"
                        onClick={() => {
                          const profiles = dongle().profiles || [];
                          const idx = profiles.findIndex((p: any) => p.id === activeProfileTab());
                          if (idx > 0) {
                            const ids = profiles.map((p: any) => p.id);
                            [ids[idx - 1], ids[idx]] = [ids[idx], ids[idx - 1]];
                            props.onReorderProfiles(dongle().id, ids);
                          }
                        }}
                        disabled={(dongle().profiles || []).findIndex((p: any) => p.id === activeProfileTab()) <= 0}
                      >
                        ←
                      </button>
                      <button
                        class="sdr-btn text-[8px] px-1.5"
                        title="Move profile right"
                        onClick={() => {
                          const profiles = dongle().profiles || [];
                          const idx = profiles.findIndex((p: any) => p.id === activeProfileTab());
                          if (idx >= 0 && idx < profiles.length - 1) {
                            const ids = profiles.map((p: any) => p.id);
                            [ids[idx], ids[idx + 1]] = [ids[idx + 1], ids[idx]];
                            props.onReorderProfiles(dongle().id, ids);
                          }
                        }}
                        disabled={(() => {
                          const profiles = dongle().profiles || [];
                          const idx = profiles.findIndex((p: any) => p.id === activeProfileTab());
                          return idx < 0 || idx >= profiles.length - 1;
                        })()}
                      >
                        →
                      </button>
                      {/* Delete */}
                      <button
                        class="sdr-btn text-[8px] text-red-400 hover:text-red-300 hover:border-red-400/50"
                        title="Delete this profile"
                        onClick={() => {
                          if (confirm('Delete this profile? This cannot be undone.')) {
                            props.onDeleteProfile(dongle().id, activeProfileTab()!);
                            setActiveProfileTab(null);
                          }
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
};

const ServerTab: Component<{ password: () => string }> = (props) => {
  const [callsign, setCallsign] = createSignal('');
  const [description, setDescription] = createSignal('');
  const [location, setLocation] = createSignal('');
  const [host, setHost] = createSignal('');
  const [port, setPort] = createSignal(3000);
  const [adminPassword, setAdminPassword] = createSignal('');
  const [demoMode, setDemoMode] = createSignal(false);
  const [fftHistoryFftSize, setFftHistoryFftSize] = createSignal(8192);
  const [fftHistoryCompression, setFftHistoryCompression] = createSignal('deflate');
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);

  const authHeaders = () => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${props.password()}`,
  });

  // Load current server config on mount
  const loadConfig = async () => {
    try {
      const res = await fetch('/api/admin/server/config', { headers: authHeaders(), credentials: 'same-origin' });
      if (res.ok) {
        const data = await res.json();
        setHost(data.host ?? '');
        setPort(data.port ?? 3000);
        setAdminPassword(data.adminPassword ?? '');
        setDemoMode(data.demoMode ?? false);
        setCallsign(data.callsign ?? '');
        setDescription(data.description ?? '');
        setLocation(data.location ?? '');
        setFftHistoryFftSize(data.fftHistoryFftSize ?? 8192);
        setFftHistoryCompression(data.fftHistoryCompression ?? 'deflate');
      }
    } catch { /* ignore */ }
  };

  createEffect(() => {
    if (store.adminModalOpen()) {
      loadConfig();
    }
  });

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch('/api/admin/server/config', {
        method: 'PUT',
        headers: authHeaders(),
        credentials: 'same-origin',
        body: JSON.stringify({
          adminPassword: adminPassword(),
          demoMode: demoMode(),
          callsign: callsign(),
          description: description(),
          location: location(),
          fftHistoryFftSize: fftHistoryFftSize(),
          fftHistoryCompression: fftHistoryCompression(),
        }),
      });
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch { /* ignore */ }
    setSaving(false);
  };

  return (
    <div class="space-y-5">
      {/* Station Info Section */}
      <div>
        <h3 class="text-[10px] font-mono text-text-secondary uppercase tracking-wider mb-3 border-b border-border pb-1">
          Station Information
        </h3>
        <div class="space-y-3">
          <div>
            <label class="block text-[9px] font-mono text-text-secondary uppercase tracking-wider mb-1">
              Callsign
            </label>
            <input
              type="text"
              value={callsign()}
              onInput={(e) => setCallsign(e.currentTarget.value)}
              placeholder="e.g. N0CALL"
              class="w-full bg-sdr-base border border-border rounded-sm px-3 py-1.5
                     text-[11px] font-mono text-text-primary
                     placeholder:text-text-muted
                     focus:border-border-focus focus:outline-none"
            />
          </div>
          <div>
            <label class="block text-[9px] font-mono text-text-secondary uppercase tracking-wider mb-1">
              Description
            </label>
            <textarea
              value={description()}
              onInput={(e) => setDescription(e.currentTarget.value)}
              placeholder="e.g. Wideband RTL-SDR receiver covering FM broadcast and air band"
              rows={2}
              class="w-full bg-sdr-base border border-border rounded-sm px-3 py-1.5
                     text-[11px] font-mono text-text-primary
                     placeholder:text-text-muted resize-none
                     focus:border-border-focus focus:outline-none"
            />
          </div>
          <div>
            <label class="block text-[9px] font-mono text-text-secondary uppercase tracking-wider mb-1">
              Location
            </label>
            <input
              type="text"
              value={location()}
              onInput={(e) => setLocation(e.currentTarget.value)}
              placeholder="e.g. San Francisco, CA — Grid CM87"
              class="w-full bg-sdr-base border border-border rounded-sm px-3 py-1.5
                     text-[11px] font-mono text-text-primary
                     placeholder:text-text-muted
                     focus:border-border-focus focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* Network Section */}
      <div>
        <h3 class="text-[10px] font-mono text-text-secondary uppercase tracking-wider mb-3 border-b border-border pb-1">
          Network (requires restart)
        </h3>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-[9px] font-mono text-text-secondary uppercase tracking-wider mb-1">
              Host
            </label>
            <input
              type="text"
              value={host()}
              disabled
              class="w-full bg-sdr-base border border-border rounded-sm px-3 py-1.5
                     text-[11px] font-mono text-text-dim opacity-60 cursor-not-allowed"
            />
          </div>
          <div>
            <label class="block text-[9px] font-mono text-text-secondary uppercase tracking-wider mb-1">
              Port
            </label>
            <input
              type="number"
              value={port()}
              disabled
              class="w-full bg-sdr-base border border-border rounded-sm px-3 py-1.5
                     text-[11px] font-mono text-text-dim opacity-60 cursor-not-allowed"
            />
          </div>
        </div>
        <p class="text-[8px] font-mono text-text-muted mt-1">
          Host and port require a server restart to take effect.
        </p>
      </div>

      {/* Security Section */}
      <div>
        <h3 class="text-[10px] font-mono text-text-secondary uppercase tracking-wider mb-3 border-b border-border pb-1">
          Security
        </h3>
        <div>
          <label class="block text-[9px] font-mono text-text-secondary uppercase tracking-wider mb-1">
            Admin Password
          </label>
          <input
            type="password"
            value={adminPassword()}
            onInput={(e) => setAdminPassword(e.currentTarget.value)}
            class="w-full bg-sdr-base border border-border rounded-sm px-3 py-1.5
                   text-[11px] font-mono text-text-primary
                   focus:border-border-focus focus:outline-none"
          />
        </div>
      </div>

      {/* DSP Section */}
      <div>
        <h3 class="text-[10px] font-mono text-text-secondary uppercase tracking-wider mb-3 border-b border-border pb-1">
          DSP / FFT History
        </h3>
        <div class="space-y-3">
          <div>
            <label class="block text-[9px] font-mono text-text-secondary uppercase tracking-wider mb-1">
              History FFT Size
            </label>
            <select
              value={fftHistoryFftSize()}
              onChange={(e) => setFftHistoryFftSize(Number(e.currentTarget.value))}
              class="w-full bg-sdr-base border border-border rounded-sm px-3 py-1.5
                     text-[11px] font-mono text-text-primary
                     focus:border-border-focus focus:outline-none"
            >
              <option value={256}>256</option>
              <option value={512}>512</option>
              <option value={1024}>1024</option>
              <option value={2048}>2048</option>
              <option value={4096}>4096</option>
              <option value={8192}>8192</option>
              <option value={16384}>16384</option>
              <option value={32768}>32768</option>
              <option value={65536}>65536</option>
            </select>
          </div>
          <div>
            <label class="block text-[9px] font-mono text-text-secondary uppercase tracking-wider mb-1">
              History Compression
            </label>
            <select
              value={fftHistoryCompression()}
              onChange={(e) => setFftHistoryCompression(e.currentTarget.value)}
              class="w-full bg-sdr-base border border-border rounded-sm px-3 py-1.5
                     text-[11px] font-mono text-text-primary
                     focus:border-border-focus focus:outline-none"
            >
              <option value="deflate">Deflate (best ratio, ~8-12x)</option>
              <option value="adpcm">ADPCM (~8x, lower CPU)</option>
              <option value="none">None (uncompressed)</option>
            </select>
          </div>
          <div class="flex items-center gap-2">
            <input
              type="checkbox"
              id="demoMode"
              checked={demoMode()}
              onChange={(e) => setDemoMode(e.currentTarget.checked)}
              class="accent-cyan"
            />
            <label for="demoMode" class="text-[10px] font-mono text-text-secondary">
              Demo Mode (simulated signals, no hardware)
            </label>
          </div>
        </div>
      </div>

      {/* Save button */}
      <div class="flex items-center gap-3 pt-2 border-t border-border">
        <button
          class="px-4 py-1.5 bg-sdr-elevated border border-border rounded-sm
                 text-[10px] font-mono text-text-primary
                 hover:border-border-focus hover:text-cyan transition-colors
                 disabled:opacity-50"
          onClick={handleSave}
          disabled={saving()}
        >
          {saving() ? 'Saving...' : 'Save Configuration'}
        </button>
        <Show when={saved()}>
          <span class="text-[10px] font-mono text-status-online">Saved to config.yaml</span>
        </Show>
      </div>
    </div>
  );
};

export default AdminModal;
