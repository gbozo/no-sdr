// ============================================================
// node-sdr — Admin Modal (GitHub-style Settings)
// ============================================================

import { Component, Show, For, createSignal, createEffect } from 'solid-js';
import { store } from '../store/index.js';
import { engine } from '../engine/sdr-engine.js';

type AdminTab = 'dongles' | 'profiles' | 'server';

const AdminModal: Component = () => {
  const [activeTab, setActiveTab] = createSignal<AdminTab>('dongles');
  const [dongles, setDongles] = createSignal<any[]>([]);
  const [selectedDongle, setSelectedDongle] = createSignal<string | null>(null);
  const [selectedProfile, setSelectedProfile] = createSignal<string | null>(null);
  const [password, setPassword] = createSignal('');
  const [isAuthenticated, setIsAuthenticated] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [success, setSuccess] = createSignal('');

  const apiBase = () => '';

  const authHeaders = () => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${password()}`,
  });

  const loadDongles = async () => {
    if (!isAuthenticated()) return;
    try {
      const res = await fetch(`${apiBase()}/api/admin/dongles`, {
        headers: authHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        setDongles(data);
      }
    } catch (e) {
      console.error('Failed to load dongles:', e);
    }
  };

  createEffect(() => {
    if (isAuthenticated() && store.adminModalOpen()) {
      loadDongles();
    }
  });

  const handleLogin = async () => {
    try {
      const res = await fetch(`${apiBase()}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password() }),
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
      const res = await fetch(`${apiBase()}/api/admin/save-config`, {
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
      await fetch(`${apiBase()}/api/admin/dongles/${dongleId}/start`, {
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
      await fetch(`${apiBase()}/api/admin/dongles/${dongleId}/stop`, {
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
      await fetch(`${apiBase()}/api/admin/dongles/${dongleId}/profile`, {
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
      const res = await fetch(`${apiBase()}/api/admin/dongles/${dongleId}`, {
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
      const res = await fetch(`${apiBase()}/api/admin/dongles/${dongleId}/profiles/${profileId}`, {
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

  const addNewDongle = async () => {
    setLoading(true);
    const newDongle = {
      id: `dongle-${Date.now()}`,
      name: 'New Dongle',
      deviceIndex: 0,
      ppmCorrection: 0,
      source: { type: 'local' },
      autoStart: true,
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
      const res = await fetch(`${apiBase()}/api/admin/dongles`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(newDongle),
      });
      if (res.ok) {
        await loadDongles();
      } else {
        setError('Failed to add dongle');
      }
    } catch {
      setError('Failed to add dongle');
    }
    setLoading(false);
  };

  const addNewProfile = async () => {
    if (!selectedDongle()) return;
    setLoading(true);
    setError('');
    const newProfile = {
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
      const res = await fetch(`${apiBase()}/api/admin/dongles/${selectedDongle()}/profiles`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(newProfile),
      });
      const data = await res.json();
      console.log('Add profile response:', res.status, data);
      if (res.ok) {
        await loadDongles();
        setSuccess('Profile added!');
      } else {
        setError(data.error || 'Failed to add profile');
      }
    } catch (e: any) {
      console.error('Add profile error:', e);
      setError('Failed to add profile');
    }
    setLoading(false);
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
              active={activeTab() === 'dongles'}
              onClick={() => setActiveTab('dongles')}
            >
              Receivers
            </TabButton>
            <TabButton
              active={activeTab() === 'profiles'}
              onClick={() => setActiveTab('profiles')}
            >
              Profiles
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
                  onClick={() => { setIsAuthenticated(false); store.setIsAdmin(false); }}
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
              {activeTab() === 'dongles' && 'Receivers'}
              {activeTab() === 'profiles' && 'Profiles'}
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
              <Show when={activeTab() === 'dongles'}>
                <DonglesTab
                  dongles={dongles()}
                  selectedDongle={selectedDongle()}
                  onSelect={setSelectedDongle}
                  onAdd={addNewDongle}
                  onStart={handleStartDongle}
                  onStop={handleStopDongle}
                  onUpdate={handleUpdateDongle}
                  password={password}
                />
              </Show>

              <Show when={activeTab() === 'profiles'}>
                <ProfilesTab
                  dongles={dongles()}
                  selectedDongle={selectedDongle()}
                  onSelect={setSelectedDongle}
                  onAdd={addNewProfile}
                  onSwitch={handleSwitchProfile}
                  onUpdate={handleUpdateProfile}
                  password={password}
                />
              </Show>

              <Show when={activeTab() === 'server'}>
                <ServerTab />
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
                  Cancel
                </button>
                <button
                  class="sdr-btn sdr-btn-primary text-[10px]"
                  onClick={handleSave}
                  disabled={saving()}
                >
                  {saving() ? 'Saving...' : 'Save to YAML'}
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

const DonglesTab: Component<{
  dongles: any[];
  selectedDongle: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onUpdate: (dongleId: string, updates: any) => void;
  password: () => string;
}> = (props) => {
  const currentDongle = () => props.dongles.find(d => d.id === props.selectedDongle);
  const [editing, setEditing] = createSignal(false);
  const [formData, setFormData] = createSignal<any>({});

  const startEdit = () => {
    const d = currentDongle();
    if (d) {
      setFormData({
        name: d.name,
        sourceType: d.source?.type || 'local',
        host: d.source?.host || '',
        port: d.source?.port || 1234,
        ppmCorrection: d.ppmCorrection || 0,
        biasT: d.biasT || false,
        autoStart: d.autoStart !== false,
      });
      setEditing(true);
    }
  };

  const saveEdit = () => {
    const d = currentDongle();
    if (d && formData()) {
      props.onUpdate(d.id, {
        name: formData().name,
        source: {
          type: formData().sourceType,
          host: formData().host || undefined,
          port: formData().port || undefined,
        },
        ppmCorrection: formData().ppmCorrection,
        biasT: formData().biasT,
        autoStart: formData().autoStart,
      });
      setEditing(false);
    }
  };

  return (
    <div class="flex gap-4 h-full">
      {/* Dongle list */}
      <div class="w-1/2 space-y-2">
        <div class="flex justify-between items-center mb-2">
          <span class="text-[10px] font-mono text-text-dim uppercase">Receivers</span>
          <button class="sdr-btn sdr-btn-primary text-[9px]" onClick={props.onAdd}>
            + Add
          </button>
        </div>
        <div class="space-y-1 max-h-[300px] overflow-y-auto">
          <For each={props.dongles}>
            {(dongle) => (
              <div
                class={`p-2 border rounded cursor-pointer transition-colors
                        ${props.selectedDongle === dongle.id
                          ? 'border-cyan bg-cyan/10'
                          : 'border-border hover:border-border-focus'}`}
                onClick={() => props.onSelect(dongle.id)}
              >
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-2">
                    <div class={`w-2 h-2 rounded-full ${dongle.running ? 'bg-status-online' : 'bg-status-offline'}`} />
                    <span class="font-mono text-xs text-text-primary">{dongle.name}</span>
                  </div>
                  <span class="text-[8px] font-mono text-text-dim">{dongle.source?.type}</span>
                </div>
              </div>
            )}
          </For>
        </div>
      </div>

      {/* Dongle detail/edit panel */}
      <div class="w-1/2 border-l border-border pl-4">
        <Show when={currentDongle()} fallback={
          <div class="text-text-dim text-[10px] font-mono">Select a receiver to view details</div>
        }>
          {(dongle) => (
            <div class="space-y-3">
              <div class="flex justify-between items-center">
                <div class="text-[10px] font-mono text-text-dim uppercase">Details</div>
                <Show when={!editing()}>
                  <button class="sdr-btn text-[9px]" onClick={startEdit}>Edit</button>
                </Show>
              </div>
              
              <Show when={editing()} fallback={
                <div class="space-y-2">
                  <div class="text-[9px] font-mono text-text-primary">{dongle().name}</div>
                  <div class="text-[8px] font-mono text-text-dim">Type: {dongle().source?.type}</div>
                  <Show when={dongle().source?.host}>
                    <div class="text-[8px] font-mono text-text-dim">Host: {dongle().source?.host}:{dongle().source?.port}</div>
                  </Show>
                </div>
              }>
                <div class="space-y-2">
                  <div>
                    <label class="text-[9px] font-mono text-text-dim block">Name</label>
                    <input
                      type="text"
                      aria-label="Dongle name"
                      value={formData().name || ''}
                      onInput={(e) => setFormData({...formData(), name: e.currentTarget.value})}
                      class="w-full bg-sdr-base border border-border rounded-sm px-2 py-1 text-[10px] font-mono"
                    />
                  </div>
                  
                  <div>
                    <label class="text-[9px] font-mono text-text-dim block">Source Type</label>
                    <select
                      aria-label="Source type"
                      value={formData().sourceType || 'local'}
                      onChange={(e) => setFormData({...formData(), sourceType: e.currentTarget.value})}
                      class="w-full bg-sdr-base border border-border rounded-sm px-2 py-1 text-[10px] font-mono"
                    >
                      <option value="local">Local (USB)</option>
                      <option value="rtl_tcp">RTL-TCP</option>
                      <option value="airspy_tcp">AirSpy TCP</option>
                      <option value="hfp_tcp">HF+ TCP</option>
                      <option value="rsp_tcp">SDRplay TCP</option>
                      <option value="demo">Demo</option>
                    </select>
                  </div>

                  <Show when={['rtl_tcp', 'airspy_tcp', 'hfp_tcp', 'rsp_tcp'].includes(formData().sourceType)}>
                    <div>
                      <label class="text-[9px] font-mono text-text-dim block">Host</label>
                      <input
                        type="text"
                        aria-label="Host address"
                        value={formData().host || ''}
                        onInput={(e) => setFormData({...formData(), host: e.currentTarget.value})}
                        placeholder="192.168.1.100"
                        class="w-full bg-sdr-base border border-border rounded-sm px-2 py-1 text-[10px] font-mono"
                      />
                    </div>
                    <div>
                      <label class="text-[9px] font-mono text-text-dim block">Port</label>
                      <input
                        type="number"
                        aria-label="Port number"
                        value={formData().port || 1234}
                        onInput={(e) => setFormData({...formData(), port: parseInt(e.currentTarget.value) || 1234})}
                        class="w-full bg-sdr-base border border-border rounded-sm px-2 py-1 text-[10px] font-mono"
                      />
                    </div>
                  </Show>

                  <div>
                    <label class="text-[9px] font-mono text-text-dim block">PPM Correction</label>
                    <input
                      type="number"
                      aria-label="PPM correction"
                      step="0.1"
                      value={formData().ppmCorrection || 0}
                      onInput={(e) => setFormData({...formData(), ppmCorrection: parseFloat(e.currentTarget.value) || 0})}
                      class="w-full bg-sdr-base border border-border rounded-sm px-2 py-1 text-[10px] font-mono"
                    />
                  </div>

                  <div class="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={formData().biasT || false}
                      onChange={(e) => setFormData({...formData(), biasT: e.currentTarget.checked})}
                      id="biasT"
                    />
                    <label for="biasT" class="text-[9px] font-mono text-text-dim">Bias-T</label>
                  </div>

                  <div class="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={formData().autoStart !== false}
                      onChange={(e) => setFormData({...formData(), autoStart: e.currentTarget.checked})}
                      id="autoStart"
                    />
                    <label for="autoStart" class="text-[9px] font-mono text-text-dim">Auto-start</label>
                  </div>

                  <div class="flex gap-2 pt-2">
                    <button class="sdr-btn text-[9px]" onClick={() => setEditing(false)}>Cancel</button>
                    <button class="sdr-btn sdr-btn-primary text-[9px]" onClick={saveEdit}>Save</button>
                  </div>
                </div>
              </Show>

              <Show when={!editing()}>
                <div class="flex gap-2 pt-2">
                  <button
                    class="sdr-btn text-[9px]"
                    onClick={(e) => { e.stopPropagation(); props.onStart(dongle().id); }}
                  >
                    Start
                  </button>
                  <button
                    class="sdr-btn text-[9px]"
                    onClick={(e) => { e.stopPropagation(); props.onStop(dongle().id); }}
                  >
                    Stop
                  </button>
                </div>

                <div class="pt-2">
                  <div class="text-[9px] font-mono text-text-dim uppercase mb-1">Profiles ({dongle().profiles?.length || 0})</div>
                  <For each={dongle().profiles || []}>
                    {(profile: any) => (
                      <div class="text-[9px] font-mono text-text-secondary py-0.5">
                        {profile.name} — {profile.centerFrequency / 1e6}MHz {profile.defaultMode}
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
};

const ProfilesTab: Component<{
  dongles: any[];
  selectedDongle: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onSwitch: (dongleId: string, profileId: string) => void;
  onUpdate: (dongleId: string, profileId: string, updates: any) => void;
  password: () => string;
}> = (props) => {
  const currentDongle = () => props.dongles.find(d => d.id === props.selectedDongle);
  const [editingProfile, setEditingProfile] = createSignal<string | null>(null);
  const [formData, setFormData] = createSignal<any>({});

  const startEdit = (profile: any) => {
    setFormData({...profile});
    setEditingProfile(profile.id);
  };

  const saveEdit = (profileId: string) => {
    if (props.selectedDongle()) {
      props.onUpdate(props.selectedDongle()!, profileId, formData());
      setEditingProfile(null);
    }
  };

  return (
    <div class="flex gap-4 h-full">
      <div class="w-1/2 space-y-2">
        <div class="flex justify-between items-center mb-2">
          <span class="text-[10px] font-mono text-text-dim uppercase">Select Receiver</span>
        </div>
        <select
          class="w-full bg-sdr-base border border-border rounded-sm px-2 py-1.5
                 text-[10px] font-mono text-text-primary"
          value={props.selectedDongle || ''}
          onChange={(e) => props.onSelect(e.currentTarget.value)}
        >
          <option value="">Choose a receiver...</option>
          <For each={props.dongles}>
            {(dongle) => (
              <option value={dongle.id}>{dongle.name}</option>
            )}
          </For>
        </select>

        <Show when={currentDongle()}>
          <div class="flex justify-between items-center mt-4">
            <span class="text-[10px] font-mono text-text-dim uppercase">Profiles</span>
            <button
              class="sdr-btn sdr-btn-primary text-[9px]"
              onClick={props.onAdd}
            >
              + Add Profile
            </button>
          </div>

          <div class="space-y-1 max-h-[250px] overflow-y-auto">
            <For each={currentDongle()?.profiles || []}>
              {(profile: any) => (
                <div class="p-2 border border-border rounded">
                  <Show when={editingProfile() === profile.id} fallback={
                    <>
                      <div class="flex items-center justify-between">
                        <span class="font-mono text-xs text-text-primary">{profile.name}</span>
                        <span class="text-[8px] font-mono text-cyan">{profile.defaultMode}</span>
                      </div>
                      <div class="text-[8px] font-mono text-text-dim mt-1">
                        {profile.centerFrequency / 1e6} MHz | {profile.sampleRate / 1e3} kS/s | FFT {profile.fftSize}
                      </div>
                      <div class="flex gap-1 mt-1">
                        <button
                          class="sdr-btn text-[8px]"
                          onClick={() => startEdit(profile)}
                        >
                          Edit
                        </button>
                        <button
                          class="sdr-btn text-[8px]"
                          onClick={() => props.onSwitch(props.selectedDongle!, profile.id)}
                        >
                          Use This
                        </button>
                      </div>
                    </>
                  }>
                    <div class="space-y-1">
                      <input
                        type="text"
                        aria-label="Profile name"
                        value={formData().name || ''}
                        onInput={(e) => setFormData({...formData(), name: e.currentTarget.value})}
                        class="w-full bg-sdr-base border border-border rounded-sm px-1 py-0.5 text-[9px] font-mono"
                        placeholder="Profile name"
                      />
                      <input
                        type="number"
                        aria-label="Center frequency in Hz"
                        value={formData().centerFrequency || 0}
                        onInput={(e) => setFormData({...formData(), centerFrequency: parseInt(e.currentTarget.value) || 0})}
                        class="w-full bg-sdr-base border border-border rounded-sm px-1 py-0.5 text-[9px] font-mono"
                        placeholder="Frequency Hz"
                      />
                      <input
                        type="number"
                        aria-label="Sample rate"
                        value={formData().sampleRate || 0}
                        onInput={(e) => setFormData({...formData(), sampleRate: parseInt(e.currentTarget.value) || 0})}
                        class="w-full bg-sdr-base border border-border rounded-sm px-1 py-0.5 text-[9px] font-mono"
                        placeholder="Sample rate"
                      />
                      <select
                        aria-label="Default demodulation mode"
                        value={formData().defaultMode || 'wfm'}
                        onChange={(e) => setFormData({...formData(), defaultMode: e.currentTarget.value})}
                        class="w-full bg-sdr-base border border-border rounded-sm px-1 py-0.5 text-[9px] font-mono"
                      >
                        <option value="wfm">WFM</option>
                        <option value="nfm">NFM</option>
                        <option value="am">AM</option>
                        <option value="usb">USB</option>
                        <option value="lsb">LSB</option>
                        <option value="cw">CW</option>
                        <option value="raw">RAW</option>
                      </select>
                      <div class="flex gap-1">
                        <button class="sdr-btn text-[8px]" onClick={() => setEditingProfile(null)}>Cancel</button>
                        <button class="sdr-btn sdr-btn-primary text-[8px]" onClick={() => saveEdit(profile.id)}>Save</button>
                      </div>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div class="w-1/2 border-l border-border pl-4">
        <Show when={currentDongle()?.profiles?.length}>
          <div class="text-[10px] font-mono text-text-dim uppercase">Help</div>
          <div class="mt-2 text-[9px] font-mono text-text-dim space-y-1">
            <div>• Click "Edit" to modify profile settings</div>
            <div>• Click "Use This" to switch active profile</div>
            <div>• Click "+ Add Profile" to create new profile</div>
            <div>• Changes auto-save to config.yaml</div>
          </div>
        </Show>
      </div>
    </div>
  );
};

const ServerTab: Component = () => {
  return (
    <div class="space-y-4">
      <p class="text-text-secondary text-[11px]">
        Server configuration options will appear here.
      </p>
      <div class="p-4 bg-sdr-base border border-border rounded-md">
        <div class="text-[10px] font-mono text-text-dim">
          Port: 3000<br />
          Host: 0.0.0.0
        </div>
      </div>
    </div>
  );
};

export default AdminModal;
