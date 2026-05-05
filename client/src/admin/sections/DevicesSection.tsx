// ============================================================
// SDR Devices Section — Dongle & Profile management
// ============================================================

import { Component, Show, For, createSignal, createMemo, onMount } from 'solid-js';
import { adminStore, DongleConfig, DongleProfile, SourceConfig } from '../admin-store';
import { PROFILE_PRESETS, PRESET_CATEGORIES, type PresetCategory } from '~/shared/profile-presets';
import { DEMOD_MODES } from '~/shared/modes';
import { formatFrequency } from '~/shared/modes';

// ---- Valid source types ----
const SOURCE_TYPES = [
  { value: 'demo', label: 'Demo (simulated)' },
  { value: 'rtl_tcp', label: 'RTL-TCP' },
  { value: 'local', label: 'Local (USB)' },
  { value: 'airspy_tcp', label: 'Airspy TCP' },
  { value: 'hfp_tcp', label: 'HF+ TCP' },
  { value: 'rsp_tcp', label: 'RSP TCP' },
];

const VALID_MODES = Object.keys(DEMOD_MODES) as string[];

const DevicesSection: Component = () => {
  const [view, setView] = createSignal<'list' | 'dongle' | 'profile'>('list');
  const [editingDongle, setEditingDongle] = createSignal<DongleConfig | null>(null);
  const [editingProfile, setEditingProfile] = createSignal<DongleProfile | null>(null);
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null);

  onMount(() => {
    if (adminStore.dongles().length === 0 && adminStore.authenticated()) {
      adminStore.loadDongles();
    }
  });

  // ---- Navigation ----
  function selectDongle(id: string) {
    adminStore.setSelectedDongleId(id);
    adminStore.setSelectedProfileId(null);
    setView('dongle');
  }

  function goToList() {
    setView('list');
    setEditingDongle(null);
    setEditingProfile(null);
  }

  function goToDongle() {
    setView('dongle');
    setEditingProfile(null);
  }

  // ---- Create Dongle ----
  async function handleAddDongle() {
    const id = `dongle-${Date.now().toString(36)}`;
    const result = await adminStore.createDongle({
      id,
      name: 'New Receiver',
      enabled: true,
      autoStart: false,
      source: { type: 'rtl_tcp', host: '127.0.0.1', port: 1234 },
      sampleRate: 2400000,
      gain: 0,
      ppmCorrection: 0,
      deviceIndex: 0,
      directSampling: 0,
      biasT: false,
      digitalAgc: false,
      offsetTuning: false,
      profiles: [],
    });
    if (result) {
      adminStore.setSelectedDongleId(result.id || id);
      setView('dongle');
    }
  }

  return (
    <div class="max-w-3xl">
      <h2 class="text-sm font-mono uppercase tracking-wider text-text-primary mb-1">SDR Devices</h2>
      <p class="text-[10px] font-mono text-text-dim mb-6">Manage receivers, profiles, and hardware settings</p>

      {/* Breadcrumb */}
      <Show when={view() !== 'list'}>
        <nav class="flex items-center gap-1 mb-4 text-[10px] font-mono">
          <button onClick={goToList} class="text-cyan hover:underline">Devices</button>
          <span class="text-text-dim">/</span>
          <Show when={view() === 'dongle' || view() === 'profile'}>
            <button onClick={goToDongle} class="text-cyan hover:underline">
              {adminStore.getSelectedDongle()?.name || 'Dongle'}
            </button>
          </Show>
          <Show when={view() === 'profile'}>
            <span class="text-text-dim">/</span>
            <span class="text-text-secondary">{editingProfile()?.name || 'Profile'}</span>
          </Show>
        </nav>
      </Show>

      <Show when={adminStore.donglesLoading()}>
        <div class="flex items-center justify-center py-12">
          <div class="text-text-dim text-[10px] font-mono uppercase tracking-wider animate-pulse">
            Loading devices...
          </div>
        </div>
      </Show>

      <Show when={!adminStore.donglesLoading()}>
        {/* Device List View */}
        <Show when={view() === 'list'}>
          <DongleList onSelect={selectDongle} onAdd={handleAddDongle} />
        </Show>

        {/* Dongle Editor View */}
        <Show when={view() === 'dongle'}>
          <DongleEditor
            onBack={goToList}
            onEditProfile={(p) => { setEditingProfile(p); setView('profile'); }}
          />
        </Show>

        {/* Profile Editor View */}
        <Show when={view() === 'profile'}>
          <ProfileEditor
            profile={editingProfile()!}
            onBack={goToDongle}
          />
        </Show>
      </Show>
    </div>
  );
};

// ============================================================
// Dongle List
// ============================================================

const DongleList: Component<{ onSelect: (id: string) => void; onAdd: () => void }> = (props) => {
  return (
    <div class="space-y-2">
      <For each={adminStore.dongles()} fallback={
        <div class="p-8 border border-border/40 rounded-md bg-sdr-surface/30 text-center">
          <p class="text-[10px] font-mono text-text-dim uppercase mb-3">No receivers configured</p>
          <button onClick={props.onAdd} class="mil-btn text-[10px]">+ Add Receiver</button>
        </div>
      }>
        {(dongle) => (
          <button
            onClick={() => props.onSelect(dongle.id)}
            class="w-full text-left p-3 border border-border/40 rounded-md bg-sdr-surface/30
                   hover:border-cyan/40 hover:bg-sdr-surface/50 transition-colors group"
          >
            <div class="flex items-center gap-3">
              {/* Status LED */}
              <div class={`w-2 h-2 rounded-full shrink-0 ${
                dongle.enabled ? 'bg-green-500 shadow-[0_0_4px_rgba(34,197,94,0.5)]' : 'bg-text-dim/40'
              }`} />
              {/* Info */}
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-xs font-mono text-text-primary truncate">{dongle.name}</span>
                  <Show when={!dongle.enabled}>
                    <span class="text-[8px] font-mono text-amber/80 uppercase border border-amber/30 px-1 rounded-sm">disabled</span>
                  </Show>
                </div>
                <div class="text-[9px] font-mono text-text-dim mt-0.5">
                  {dongle.source?.type || 'unknown'} — {dongle.profiles?.length || 0} profile{(dongle.profiles?.length || 0) !== 1 ? 's' : ''}
                </div>
              </div>
              {/* Arrow */}
              <svg class="w-4 h-4 text-text-dim group-hover:text-cyan transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </button>
        )}
      </For>

      <button
        onClick={props.onAdd}
        class="w-full p-3 border border-dashed border-border/40 rounded-md
               text-[10px] font-mono text-text-dim uppercase tracking-wider
               hover:border-cyan/40 hover:text-cyan transition-colors"
      >
        + Add Receiver
      </button>
    </div>
  );
};

// ============================================================
// Dongle Editor
// ============================================================

const DongleEditor: Component<{
  onBack: () => void;
  onEditProfile: (p: DongleProfile) => void;
}> = (props) => {
  const dongle = createMemo(() => adminStore.getSelectedDongle());
  const [editing, setEditing] = createSignal(false);
  const [localState, setLocalState] = createSignal<Partial<DongleConfig>>({});
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const [presetOpen, setPresetOpen] = createSignal(false);

  function startEditing() {
    const d = dongle();
    if (d) {
      setLocalState({ ...d, source: { ...d.source } });
      setEditing(true);
    }
  }

  function cancelEditing() {
    setEditing(false);
    setLocalState({});
  }

  async function saveDongle() {
    const d = dongle();
    if (!d) return;
    const updates = localState();
    // Don't send profiles with the update (they're managed separately)
    const { profiles, ...rest } = updates as any;
    await adminStore.updateDongle(d.id, rest);
    setEditing(false);
    setLocalState({});
  }

  async function handleDelete() {
    const d = dongle();
    if (!d) return;
    await adminStore.deleteDongle(d.id);
    props.onBack();
  }

  async function handleAddProfile(preset?: any) {
    const d = dongle();
    if (!d) return;
    const id = `profile-${Date.now().toString(36)}`;
    const profile: Partial<DongleProfile> = preset ? {
      id,
      name: preset.name,
      centerFrequency: preset.centerFrequency,
      sampleRate: preset.sampleRate,
      bandwidth: preset.defaultBandwidth,
      mode: preset.defaultMode,
      gain: preset.gain ?? 0,
      fftSize: preset.fftSize,
      fftFps: preset.fftFps,
      tuneOffset: preset.defaultTuneOffset,
      tuningStep: 1000,
      directSampling: preset.directSampling ?? 0,
      description: preset.description,
      dongleId: d.id,
    } : {
      id,
      name: 'New Profile',
      centerFrequency: 100000000,
      sampleRate: 2400000,
      bandwidth: 12500,
      mode: 'nfm',
      gain: 0,
      fftSize: 2048,
      fftFps: 25,
      tuneOffset: 0,
      tuningStep: 1000,
      directSampling: 0,
      description: '',
      dongleId: d.id,
    };
    const ok = await adminStore.createProfile(d.id, profile);
    if (ok) {
      adminStore.setSelectedProfileId(id);
    }
    setPresetOpen(false);
  }

  function updateLocal<K extends keyof DongleConfig>(key: K, value: DongleConfig[K]) {
    setLocalState(prev => ({ ...prev, [key]: value }));
  }

  function updateLocalSource<K extends keyof SourceConfig>(key: K, value: SourceConfig[K]) {
    setLocalState(prev => {
      const base = prev.source || dongle()?.source || {};
      const merged = { ...base, [key]: value };
      return {
        ...prev,
        source: merged as SourceConfig,
      };
    });
  }

  return (
    <Show when={dongle()} fallback={<p class="text-text-dim text-xs font-mono">Dongle not found</p>}>
      {(d) => {
        const current = () => editing() ? localState() as DongleConfig : d();
        return (
          <div class="space-y-6">
            {/* Header */}
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                <div class={`w-2.5 h-2.5 rounded-full ${
                  d().enabled ? 'bg-green-500 shadow-[0_0_4px_rgba(34,197,94,0.5)]' : 'bg-text-dim/40'
                }`} />
                <h3 class="text-sm font-mono text-text-primary">{d().name}</h3>
                <Show when={!d().enabled}>
                  <span class="text-[8px] font-mono text-amber/80 uppercase border border-amber/30 px-1 rounded-sm">disabled</span>
                </Show>
              </div>
              <div class="flex items-center gap-2">
                <Show when={!editing()}>
                  <button onClick={() => adminStore.startDongle(d().id)} class="mil-btn text-[9px] px-2 py-1">Start</button>
                  <button onClick={() => adminStore.stopDongle(d().id)} class="mil-btn text-[9px] px-2 py-1">Stop</button>
                  <button onClick={startEditing} class="mil-btn text-[9px] px-2 py-1">Edit</button>
                </Show>
                <Show when={editing()}>
                  <button onClick={saveDongle} class="mil-btn text-[9px] px-2 py-1 border-cyan text-cyan">Save</button>
                  <button onClick={cancelEditing} class="mil-btn text-[9px] px-2 py-1">Cancel</button>
                </Show>
              </div>
            </div>

            {/* Dongle Settings */}
            <div class="border border-border/40 rounded-md bg-sdr-surface/30 p-4 space-y-4">
              <div class="grid grid-cols-2 gap-4">
                <FieldGroup label="Name">
                  <Show when={editing()} fallback={<ValueDisplay value={d().name} />}>
                    <input type="text" value={current().name || ''} onInput={(e) => updateLocal('name', e.currentTarget.value)}
                      class="admin-input w-full" />
                  </Show>
                </FieldGroup>
                <FieldGroup label="Source Type">
                  <Show when={editing()} fallback={<ValueDisplay value={d().source?.type || 'unknown'} />}>
                    <select value={current().source?.type || 'rtl_tcp'} onChange={(e) => updateLocalSource('type', e.currentTarget.value)}
                      class="admin-input w-full">
                      <For each={SOURCE_TYPES}>
                        {(st) => <option value={st.value}>{st.label}</option>}
                      </For>
                    </select>
                  </Show>
                </FieldGroup>
              </div>

              {/* TCP settings (only for tcp sources) */}
              <Show when={isTcpSource(current().source?.type || d().source?.type)}>
                <div class="grid grid-cols-2 gap-4">
                  <FieldGroup label="Host">
                    <Show when={editing()} fallback={<ValueDisplay value={d().source?.host || '127.0.0.1'} />}>
                      <input type="text" value={current().source?.host || ''} onInput={(e) => updateLocalSource('host', e.currentTarget.value)}
                        class="admin-input w-full" />
                    </Show>
                  </FieldGroup>
                  <FieldGroup label="Port">
                    <Show when={editing()} fallback={<ValueDisplay value={String(d().source?.port || 1234)} />}>
                      <input type="number" value={current().source?.port || 1234}
                        onInput={(e) => updateLocalSource('port', parseInt(e.currentTarget.value) || 1234)}
                        class="admin-input w-24" />
                    </Show>
                  </FieldGroup>
                </div>
              </Show>

              <div class="grid grid-cols-3 gap-4">
                <FieldGroup label="Sample Rate">
                  <Show when={editing()} fallback={<ValueDisplay value={formatSampleRate(d().sampleRate)} />}>
                    <select value={String(current().sampleRate || 2400000)}
                      onChange={(e) => updateLocal('sampleRate', parseInt(e.currentTarget.value))}
                      class="admin-input">
                      <option value="960000">0.96 MSPS</option>
                      <option value="1200000">1.2 MSPS</option>
                      <option value="1440000">1.44 MSPS</option>
                      <option value="1800000">1.8 MSPS</option>
                      <option value="2400000">2.4 MSPS</option>
                      <option value="2880000">2.88 MSPS</option>
                      <option value="3200000">3.2 MSPS</option>
                    </select>
                  </Show>
                </FieldGroup>
                <FieldGroup label="PPM Correction">
                  <Show when={editing()} fallback={<ValueDisplay value={String(d().ppmCorrection || 0)} />}>
                    <input type="number" value={current().ppmCorrection || 0}
                      onInput={(e) => updateLocal('ppmCorrection', parseInt(e.currentTarget.value) || 0)}
                      class="admin-input w-20" />
                  </Show>
                </FieldGroup>
                <FieldGroup label="Device Index">
                  <Show when={editing()} fallback={<ValueDisplay value={String(d().deviceIndex || 0)} />}>
                    <input type="number" value={current().deviceIndex || 0} min={0} max={9}
                      onInput={(e) => updateLocal('deviceIndex', parseInt(e.currentTarget.value) || 0)}
                      class="admin-input w-16" />
                  </Show>
                </FieldGroup>
              </div>

              <div class="grid grid-cols-2 gap-4">
                <FieldGroup label="Direct Sampling">
                  <Show when={editing()} fallback={<ValueDisplay value={directSamplingLabel(d().directSampling)} />}>
                    <select value={String(current().directSampling || 0)}
                      onChange={(e) => updateLocal('directSampling', parseInt(e.currentTarget.value))}
                      class="admin-input">
                      <option value="0">Off</option>
                      <option value="1">I-ADC</option>
                      <option value="2">Q-ADC</option>
                    </select>
                  </Show>
                </FieldGroup>
                <FieldGroup label="Gain (dB)">
                  <Show when={editing()} fallback={<ValueDisplay value={String(d().gain || 0)} />}>
                    <input type="number" value={current().gain || 0} step={0.1}
                      onInput={(e) => updateLocal('gain', parseFloat(e.currentTarget.value) || 0)}
                      class="admin-input w-24" />
                  </Show>
                </FieldGroup>
              </div>

              {/* Toggle options */}
              <Show when={editing()}>
                <div class="flex flex-wrap gap-3 pt-2 border-t border-border/30">
                  <ToggleChip label="Enabled" value={current().enabled ?? true} onChange={(v) => updateLocal('enabled', v)} />
                  <ToggleChip label="Auto Start" value={current().autoStart ?? false} onChange={(v) => updateLocal('autoStart', v)} />
                  <ToggleChip label="Bias-T" value={current().biasT ?? false} onChange={(v) => updateLocal('biasT', v)} />
                  <ToggleChip label="Digital AGC" value={current().digitalAgc ?? false} onChange={(v) => updateLocal('digitalAgc', v)} />
                  <ToggleChip label="Offset Tuning" value={current().offsetTuning ?? false} onChange={(v) => updateLocal('offsetTuning', v)} />
                </div>
              </Show>

              <Show when={!editing()}>
                <div class="flex flex-wrap gap-2 pt-2 border-t border-border/30">
                  <Show when={d().enabled}><StatusChip label="Enabled" active /></Show>
                  <Show when={d().autoStart}><StatusChip label="Auto Start" active /></Show>
                  <Show when={d().biasT}><StatusChip label="Bias-T" active /></Show>
                  <Show when={d().digitalAgc}><StatusChip label="Digital AGC" active /></Show>
                  <Show when={d().offsetTuning}><StatusChip label="Offset Tuning" active /></Show>
                </div>
              </Show>
            </div>

            {/* Delete */}
            <Show when={editing()}>
              <div class="border border-red-500/30 rounded-md p-3 bg-red-500/5">
                <Show when={!confirmDelete()} fallback={
                  <div class="flex items-center gap-3">
                    <p class="text-[10px] font-mono text-red-400">Are you sure? This cannot be undone.</p>
                    <button onClick={handleDelete} class="text-[9px] font-mono px-2 py-1 border border-red-500 text-red-400 rounded-sm hover:bg-red-500/20">Confirm</button>
                    <button onClick={() => setConfirmDelete(false)} class="text-[9px] font-mono px-2 py-1 border border-border text-text-dim rounded-sm">Cancel</button>
                  </div>
                }>
                  <button onClick={() => setConfirmDelete(true)} class="text-[9px] font-mono text-red-400 hover:text-red-300">
                    Delete this receiver...
                  </button>
                </Show>
              </div>
            </Show>

            {/* Profiles Section */}
            <div class="border-t border-border/40 pt-6">
              <div class="flex items-center justify-between mb-3">
                <h4 class="text-[11px] font-mono uppercase tracking-wider text-text-secondary">Profiles</h4>
                <div class="flex items-center gap-2">
                  <div class="relative">
                    <button onClick={() => setPresetOpen(!presetOpen())}
                      class="mil-btn text-[9px] px-2 py-1">
                      + From Preset
                    </button>
                    <Show when={presetOpen()}>
                      <PresetDropdown onSelect={handleAddProfile} onClose={() => setPresetOpen(false)} />
                    </Show>
                  </div>
                  <button onClick={() => handleAddProfile()} class="mil-btn text-[9px] px-2 py-1">+ Blank</button>
                </div>
              </div>

              <ProfileList
                profiles={d().profiles || []}
                dongleId={d().id}
                onEdit={props.onEditProfile}
              />
            </div>
          </div>
        );
      }}
    </Show>
  );
};

// ============================================================
// Profile List (inside dongle editor)
// ============================================================

const ProfileList: Component<{
  profiles: DongleProfile[];
  dongleId: string;
  onEdit: (p: DongleProfile) => void;
}> = (props) => {
  async function moveUp(index: number) {
    if (index === 0) return;
    const order = props.profiles.map(p => p.id);
    [order[index - 1], order[index]] = [order[index], order[index - 1]];
    await adminStore.reorderProfiles(props.dongleId, order);
  }

  async function moveDown(index: number) {
    if (index >= props.profiles.length - 1) return;
    const order = props.profiles.map(p => p.id);
    [order[index], order[index + 1]] = [order[index + 1], order[index]];
    await adminStore.reorderProfiles(props.dongleId, order);
  }

  return (
    <div class="space-y-1.5">
      <For each={props.profiles} fallback={
        <div class="p-4 border border-border/30 rounded-md text-center">
          <p class="text-[9px] font-mono text-text-dim uppercase">No profiles — add one from a preset or blank</p>
        </div>
      }>
        {(profile, index) => (
          <div class="flex items-center gap-2 p-2.5 border border-border/30 rounded-md bg-sdr-base/50
                      hover:border-border/60 transition-colors group">
            {/* Reorder arrows */}
            <div class="flex flex-col gap-0.5">
              <button onClick={() => moveUp(index())}
                class="text-text-dim hover:text-cyan transition-colors disabled:opacity-30"
                disabled={index() === 0}>
                <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7" />
                </svg>
              </button>
              <button onClick={() => moveDown(index())}
                class="text-text-dim hover:text-cyan transition-colors disabled:opacity-30"
                disabled={index() === props.profiles.length - 1}>
                <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            </div>
            {/* Profile info */}
            <div class="flex-1 min-w-0 cursor-pointer" onClick={() => props.onEdit(profile)}>
              <div class="flex items-center gap-2">
                <span class="text-[10px] font-mono text-text-primary truncate">{profile.name}</span>
                <span class="text-[8px] font-mono text-cyan uppercase">{profile.mode}</span>
              </div>
              <div class="text-[9px] font-mono text-text-dim mt-0.5">
                {formatFrequency(profile.centerFrequency)} — {formatSampleRate(profile.sampleRate)} — FFT {profile.fftSize}
              </div>
            </div>
            {/* Actions */}
            <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button onClick={() => adminStore.activateProfile(props.dongleId, profile.id)}
                title="Activate"
                class="p-1 text-text-dim hover:text-green-400 transition-colors">
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                </svg>
              </button>
              <button onClick={() => props.onEdit(profile)}
                title="Edit"
                class="p-1 text-text-dim hover:text-cyan transition-colors">
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
            </div>
          </div>
        )}
      </For>
    </div>
  );
};

// ============================================================
// Profile Editor (full form)
// ============================================================

const ProfileEditor: Component<{
  profile: DongleProfile;
  onBack: () => void;
}> = (props) => {
  const [local, setLocal] = createSignal<Partial<DongleProfile>>({ ...props.profile });
  const [confirmDelete, setConfirmDelete] = createSignal(false);

  function update<K extends keyof DongleProfile>(key: K, value: DongleProfile[K]) {
    setLocal(prev => ({ ...prev, [key]: value }));
  }

  async function save() {
    const dongle = adminStore.getSelectedDongle();
    if (!dongle) return;
    const updates = local();
    await adminStore.updateProfile(dongle.id, props.profile.id, updates);
    props.onBack();
  }

  async function handleDelete() {
    const dongle = adminStore.getSelectedDongle();
    if (!dongle) return;
    await adminStore.deleteProfile(dongle.id, props.profile.id);
    props.onBack();
  }

  return (
    <div class="space-y-6">
      {/* Header */}
      <div class="flex items-center justify-between">
        <h3 class="text-xs font-mono text-text-primary">{local().name || 'Profile'}</h3>
        <div class="flex items-center gap-2">
          <button onClick={save} class="mil-btn text-[9px] px-3 py-1 border-cyan text-cyan">Save Profile</button>
          <button onClick={props.onBack} class="mil-btn text-[9px] px-2 py-1">Cancel</button>
        </div>
      </div>

      <div class="border border-border/40 rounded-md bg-sdr-surface/30 p-4 space-y-4">
        {/* Basic */}
        <div class="grid grid-cols-2 gap-4">
          <FieldGroup label="Name">
            <input type="text" value={local().name || ''} onInput={(e) => update('name', e.currentTarget.value)}
              class="admin-input w-full" />
          </FieldGroup>
          <FieldGroup label="Description">
            <input type="text" value={local().description || ''} onInput={(e) => update('description', e.currentTarget.value)}
              class="admin-input w-full" />
          </FieldGroup>
        </div>

        {/* Frequency & Mode */}
        <div class="grid grid-cols-3 gap-4">
          <FieldGroup label="Center Frequency (Hz)">
            <input type="number" value={local().centerFrequency || 0}
              onInput={(e) => update('centerFrequency', parseInt(e.currentTarget.value) || 0)}
              class="admin-input w-full" />
            <span class="text-[8px] font-mono text-text-dim mt-0.5 block">
              {formatFrequency(local().centerFrequency || 0)}
            </span>
          </FieldGroup>
          <FieldGroup label="Mode">
            <select value={local().mode || 'nfm'} onChange={(e) => update('mode', e.currentTarget.value)}
              class="admin-input w-full">
              <For each={VALID_MODES}>
                {(mode) => <option value={mode}>{DEMOD_MODES[mode as keyof typeof DEMOD_MODES]?.shortName || mode}</option>}
              </For>
            </select>
          </FieldGroup>
          <FieldGroup label="Bandwidth (Hz)">
            <input type="number" value={local().bandwidth || 0}
              onInput={(e) => update('bandwidth', parseInt(e.currentTarget.value) || 0)}
              class="admin-input w-full" />
          </FieldGroup>
        </div>

        {/* Sample Rate & FFT */}
        <div class="grid grid-cols-3 gap-4">
          <FieldGroup label="Sample Rate">
            <select value={String(local().sampleRate || 2400000)}
              onChange={(e) => update('sampleRate', parseInt(e.currentTarget.value))}
              class="admin-input w-full">
              <option value="960000">0.96 MSPS</option>
              <option value="1200000">1.2 MSPS</option>
              <option value="1440000">1.44 MSPS</option>
              <option value="1800000">1.8 MSPS</option>
              <option value="2400000">2.4 MSPS</option>
              <option value="2880000">2.88 MSPS</option>
              <option value="3200000">3.2 MSPS</option>
            </select>
          </FieldGroup>
          <FieldGroup label="FFT Size">
            <select value={String(local().fftSize || 2048)}
              onChange={(e) => update('fftSize', parseInt(e.currentTarget.value))}
              class="admin-input w-full">
              <option value="256">256</option>
              <option value="512">512</option>
              <option value="1024">1024</option>
              <option value="2048">2048</option>
              <option value="4096">4096</option>
              <option value="8192">8192</option>
              <option value="16384">16384</option>
            </select>
          </FieldGroup>
          <FieldGroup label="FFT FPS">
            <input type="number" value={local().fftFps || 25} min={1} max={60}
              onInput={(e) => update('fftFps', parseInt(e.currentTarget.value) || 25)}
              class="admin-input w-20" />
          </FieldGroup>
        </div>

        {/* Tuning */}
        <div class="grid grid-cols-3 gap-4">
          <FieldGroup label="Tune Offset (Hz)">
            <input type="number" value={local().tuneOffset || 0}
              onInput={(e) => update('tuneOffset', parseInt(e.currentTarget.value) || 0)}
              class="admin-input w-full" />
          </FieldGroup>
          <FieldGroup label="Tuning Step (Hz)">
            <input type="number" value={local().tuningStep || 1000}
              onInput={(e) => update('tuningStep', parseInt(e.currentTarget.value) || 1000)}
              class="admin-input w-full" />
          </FieldGroup>
          <FieldGroup label="Gain (dB)">
            <input type="number" value={local().gain || 0} step={0.1}
              onInput={(e) => update('gain', parseFloat(e.currentTarget.value) || 0)}
              class="admin-input w-24" />
          </FieldGroup>
        </div>

        {/* Advanced */}
        <div class="grid grid-cols-3 gap-4">
          <FieldGroup label="Direct Sampling">
            <select value={String(local().directSampling || 0)}
              onChange={(e) => update('directSampling', parseInt(e.currentTarget.value))}
              class="admin-input">
              <option value="0">Off</option>
              <option value="1">I-ADC</option>
              <option value="2">Q-ADC</option>
            </select>
          </FieldGroup>
          <FieldGroup label="Oscillator Offset (Hz)">
            <input type="number" value={local().oscillatorOffset || 0}
              onInput={(e) => update('oscillatorOffset', parseInt(e.currentTarget.value) || 0)}
              class="admin-input w-full" />
          </FieldGroup>
        </div>

        {/* Toggles */}
        <div class="flex flex-wrap gap-3 pt-3 border-t border-border/30">
          <ToggleChip label="Swap I/Q" value={local().swapIQ ?? false} onChange={(v) => update('swapIQ', v)} />
          <ToggleChip label="Pre-filter NB" value={local().preFilterNb ?? false} onChange={(v) => update('preFilterNb', v)} />
          <ToggleChip label="DC Offset Removal" value={local().dcOffsetRemoval ?? true} onChange={(v) => update('dcOffsetRemoval', v)} />
        </div>

        <Show when={local().preFilterNb}>
          <FieldGroup label="NB Threshold">
            <input type="number" value={local().preFilterNbThreshold || 10} min={3} max={50}
              onInput={(e) => update('preFilterNbThreshold', parseInt(e.currentTarget.value) || 10)}
              class="admin-input w-20" />
            <span class="text-[8px] font-mono text-text-dim ml-2">Range: 3-50 (lower = more aggressive)</span>
          </FieldGroup>
        </Show>
      </div>

      {/* Delete */}
      <div class="border border-red-500/30 rounded-md p-3 bg-red-500/5">
        <Show when={!confirmDelete()} fallback={
          <div class="flex items-center gap-3">
            <p class="text-[10px] font-mono text-red-400">Delete this profile?</p>
            <button onClick={handleDelete} class="text-[9px] font-mono px-2 py-1 border border-red-500 text-red-400 rounded-sm hover:bg-red-500/20">Confirm</button>
            <button onClick={() => setConfirmDelete(false)} class="text-[9px] font-mono px-2 py-1 border border-border text-text-dim rounded-sm">Cancel</button>
          </div>
        }>
          <button onClick={() => setConfirmDelete(true)} class="text-[9px] font-mono text-red-400 hover:text-red-300">
            Delete this profile...
          </button>
        </Show>
      </div>
    </div>
  );
};

// ============================================================
// Preset Dropdown
// ============================================================

const PresetDropdown: Component<{ onSelect: (preset: any) => void; onClose: () => void }> = (props) => {
  const grouped = createMemo(() => {
    const map = new Map<PresetCategory, typeof PROFILE_PRESETS>();
    for (const preset of PROFILE_PRESETS) {
      const list = map.get(preset.category) || [];
      list.push(preset);
      map.set(preset.category, list);
    }
    return map;
  });

  return (
    <div class="absolute right-0 top-full mt-1 z-50 w-72 max-h-80 overflow-y-auto
                bg-sdr-surface border border-border rounded-md shadow-xl">
      <div class="sticky top-0 bg-sdr-surface border-b border-border/40 px-3 py-2 flex items-center justify-between">
        <span class="text-[9px] font-mono uppercase text-text-secondary">Select Preset</span>
        <button onClick={props.onClose} class="text-text-dim hover:text-text-primary">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div class="p-1">
        <For each={Array.from(grouped().entries())}>
          {([category, presets]) => (
            <div class="mb-1">
              <div class="px-2 py-1 text-[8px] font-mono uppercase tracking-wider text-text-dim">
                {PRESET_CATEGORIES[category]}
              </div>
              <For each={presets}>
                {(preset) => (
                  <button
                    onClick={() => props.onSelect(preset)}
                    class="w-full text-left px-2 py-1.5 rounded-sm hover:bg-cyan/10 transition-colors"
                  >
                    <div class="text-[10px] font-mono text-text-primary">{preset.name}</div>
                    <div class="text-[8px] font-mono text-text-dim">{preset.description}</div>
                  </button>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </div>
  );
};

// ============================================================
// Shared Sub-components
// ============================================================

const FieldGroup: Component<{ label: string; children: any }> = (props) => (
  <div>
    <label class="text-[9px] font-mono uppercase tracking-wider text-text-dim mb-1 block">{props.label}</label>
    {props.children}
  </div>
);

const ValueDisplay: Component<{ value: string }> = (props) => (
  <span class="text-xs font-mono text-text-primary">{props.value}</span>
);

const ToggleChip: Component<{ label: string; value: boolean; onChange: (v: boolean) => void }> = (props) => (
  <button
    type="button"
    onClick={() => props.onChange(!props.value)}
    class={`px-2.5 py-1 text-[9px] font-mono uppercase tracking-wider rounded-sm border transition-colors ${
      props.value
        ? 'border-cyan text-cyan bg-cyan/10'
        : 'border-border text-text-dim hover:text-text-secondary'
    }`}
  >
    {props.label}
  </button>
);

const StatusChip: Component<{ label: string; active?: boolean }> = (props) => (
  <span class={`px-2 py-0.5 text-[8px] font-mono uppercase tracking-wider rounded-sm border ${
    props.active ? 'border-cyan/40 text-cyan/80 bg-cyan/5' : 'border-border text-text-dim'
  }`}>
    {props.label}
  </span>
);

// ============================================================
// Helpers
// ============================================================

function isTcpSource(type?: string): boolean {
  return type === 'rtl_tcp' || type === 'airspy_tcp' || type === 'hfp_tcp' || type === 'rsp_tcp';
}

function formatSampleRate(rate: number): string {
  if (rate >= 1_000_000) return `${(rate / 1_000_000).toFixed(2)} MSPS`;
  if (rate >= 1_000) return `${(rate / 1_000).toFixed(1)} kSPS`;
  return `${rate} SPS`;
}

function directSamplingLabel(val: number): string {
  if (val === 1) return 'I-ADC';
  if (val === 2) return 'Q-ADC';
  return 'Off';
}

export default DevicesSection;
