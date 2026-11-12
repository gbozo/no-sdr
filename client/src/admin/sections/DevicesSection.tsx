// ============================================================
// SDR Devices Section — Dongle & Profile management
// ============================================================

import { Component, Show, For, createSignal, createMemo, onMount, onCleanup } from 'solid-js';
import { adminStore, DongleConfig, DongleProfile, SourceConfig, UsbDevice } from '../admin-store';
import { PROFILE_PRESETS, PRESET_CATEGORIES, type PresetCategory } from '~/shared/profile-presets';
import { DEMOD_MODES } from '~/shared/modes';
import { formatFrequency } from '~/shared/modes';

// ---- Valid source types ----
const SOURCE_TYPES = [
  { value: 'demo', label: 'Demo (simulated)' },
  { value: 'rtl_tcp', label: 'RTL-TCP' },
  { value: 'local', label: 'Local RTL-SDR (USB)' },
  { value: 'hackrf', label: 'HackRF One/Pro (USB)' },
  { value: 'airspy', label: 'Airspy R2/Mini (USB)' },
  { value: 'airspyhf', label: 'Airspy HF+ (USB)' },
  { value: 'hydrasdr', label: 'HydraSDR RFOne (USB)' },
  { value: 'elad', label: 'ELAD FDM (USB)' },
  { value: 'rx888', label: 'RX-888 Mk2 (USB)' },
  { value: 'pluto', label: 'PlutoSDR (IIOD network)' },
  { value: 'sdrplay', label: 'SDRplay RSP (vendor API)' },
  { value: 'lime', label: 'LimeSDR (LimeSuite)' },
  { value: 'fobos', label: 'RigExpert Fobos SDR (libfobos)' },
  { value: 'airspy_tcp', label: 'Airspy TCP' },
  { value: 'hfp_tcp', label: 'HF+ TCP' },
  { value: 'rsp_tcp', label: 'RSP TCP' },
];

const VALID_MODES = Object.keys(DEMOD_MODES) as string[];

type DongleStatus = 'running' | 'stopped' | 'disabled';

/** Runtime state wins over the configured `enabled` flag: a dongle can be
 *  manually started even if it is not auto-started. */
function dongleStatus(d: { running?: boolean; enabled: boolean }): DongleStatus {
  if (d.running) return 'running';
  if (!d.enabled) return 'disabled';
  return 'stopped';
}

const STATUS_DOT: Record<DongleStatus, string> = {
  running: 'bg-green-500 shadow-[0_0_4px_rgba(34,197,94,0.5)]',
  stopped: 'bg-amber-500 shadow-[0_0_4px_rgba(245,158,11,0.4)]',
  disabled: 'bg-text-dim/40',
};

const STATUS_BADGE: Record<DongleStatus, string> = {
  running: 'text-green-400 border-green-500/40 bg-green-500/10',
  stopped: 'text-amber-400 border-amber-500/40 bg-amber-500/10',
  disabled: 'text-text-dim border-border/60',
};

const STATUS_LABEL: Record<DongleStatus, string> = {
  running: 'RUNNING',
  stopped: 'STOPPED',
  disabled: 'DISABLED',
};

const StatusBadge: Component<{ status: DongleStatus }> = (props) => (
  <span class={`text-[8px] font-mono uppercase tracking-wider border px-1.5 py-0.5 rounded-sm ${STATUS_BADGE[props.status]}`}>
    {STATUS_LABEL[props.status]}
  </span>
);

const DevicesSection: Component = () => {
  const [view, setView] = createSignal<'list' | 'dongle' | 'profile'>('list');
  const [editingDongle, setEditingDongle] = createSignal<DongleConfig | null>(null);
  const [editingProfile, setEditingProfile] = createSignal<DongleProfile | null>(null);
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null);

  onMount(() => {
    if (adminStore.dongles().length === 0 && adminStore.authenticated()) {
      adminStore.loadDongles();
    }
    // Running state is owned by the backend (auto-start, admin actions from
    // another tab, retry loops). Refresh it in the background without
    // replacing the view with the loading state.
    const poll = setInterval(() => {
      if (adminStore.authenticated()) adminStore.loadDongles(true);
    }, 3000);
    onCleanup(() => clearInterval(poll));
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
      iqCorrection: false,
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
              {/* Status LED: runtime state, not the configured enabled flag */}
              <div class={`w-2 h-2 rounded-full shrink-0 ${
                STATUS_DOT[dongleStatus(dongle)]
              } ${dongleStatus(dongle) === 'running' ? 'animate-pulse' : ''}`} />
              {/* Info */}
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-xs font-mono text-text-primary truncate">{dongle.name}</span>
                  <StatusBadge status={dongleStatus(dongle)} />
                  <Show when={!dongle.enabled}>
                    <span class="text-[8px] font-mono text-amber/80 uppercase border border-amber/30 px-1 rounded-sm">disabled</span>
                  </Show>
                </div>
                <div class="text-[9px] font-mono text-text-dim mt-0.5">
                  {dongle.source?.type || 'unknown'} — {dongle.profiles?.length || 0} profile{(dongle.profiles?.length || 0) !== 1 ? 's' : ''}
                  <Show when={dongle.running}>
                    {' · '}{(dongle.clientCount ?? 0)} client{(dongle.clientCount ?? 0) !== 1 ? 's' : ''}
                  </Show>
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
  const [action, setAction] = createSignal<'start' | 'stop' | null>(null);
  const [actionError, setActionError] = createSignal('');
  const [scanning, setScanning] = createSignal(false);
  const [scanError, setScanError] = createSignal('');

  async function scanDevices(type: string) {
    setScanning(true);
    setScanError('');
    await adminStore.scanUsbDevices(type);
    setScanning(false);
    if (adminStore.usbDevices().length === 0) {
      setScanError('No devices found. Check the USB cable, udev rules and vendor library/service.');
    }
  }

  function applyDetectedDevice(device: UsbDevice) {
    if (device.serial) updateLocalSource('serial', device.serial);
    if (typeof device.index === 'number') updateLocal('deviceIndex', device.index);
    if (device.address) {
      const [host, port] = device.address.split(':');
      updateLocalSource('host', host);
      if (port) updateLocalSource('port', parseInt(port) || 0);
    }
  }

  async function handleStart() {
    const d = dongle();
    if (!d || action()) return;
    setAction('start');
    setActionError('');
    const ok = await adminStore.startDongle(d.id);
    if (!ok) setActionError('Start failed — check the server log for the source error.');
    setAction(null);
  }

  async function handleStop() {
    const d = dongle();
    if (!d || action()) return;
    setAction('stop');
    setActionError('');
    const ok = await adminStore.stopDongle(d.id);
    if (!ok) setActionError('Stop failed — check the server log.');
    setAction(null);
  }

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
    const rates = sampleRatesFor(d.source?.type, d.source?.settings);
    const presetRate = preset?.sampleRate;
    const profile: Partial<DongleProfile> = preset ? {
      id,
      name: preset.name,
      centerFrequency: preset.centerFrequency,
      sampleRate: rates.includes(presetRate) ? presetRate : rates[0],
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
      sampleRate: rates[0],
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

  function updateLocalSetting(key: string, value: number | string | boolean) {
    setLocalState(prev => {
      const base = (prev.source || dongle()?.source || {}) as SourceConfig;
      const settings = { ...(base.settings || {}), [key]: value };
      return {
        ...prev,
        source: { ...base, settings } as SourceConfig,
      };
    });
  }

  function sourceSetting(key: string): number | string | boolean | undefined {
    const source = editing() ? localState().source : dongle()?.source;
    return source?.settings?.[key];
  }

  function sourceNumber(key: string, fallback: number): number {
    const v = sourceSetting(key);
    return typeof v === 'number' ? v : fallback;
  }

  return (
    <Show when={dongle()} fallback={<p class="text-text-dim text-xs font-mono">Dongle not found</p>}>
      {(d) => {
        const current = () => editing() ? localState() as DongleConfig : d();
        const sourceType = () => current().source?.type || d().source?.type || 'rtl_tcp';
        return (
          <div class="space-y-6">
            {/* Header */}
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                <div class={`w-2.5 h-2.5 rounded-full ${
                  STATUS_DOT[dongleStatus(d())]
                } ${dongleStatus(d()) === 'running' ? 'animate-pulse' : ''}`} />
                <h3 class="text-sm font-mono text-text-primary">{d().name}</h3>
                <StatusBadge status={dongleStatus(d())} />
                <Show when={d().state?.status && !['running', 'stopped', 'disabled'].includes(d().state!.status)}>
                  <span class="text-[8px] font-mono uppercase tracking-wider border border-amber/40 text-amber/90 bg-amber/5 px-1.5 py-0.5 rounded-sm">
                    {d().state!.status}
                  </span>
                </Show>
                <Show when={d().running}>
                  <span class="text-[9px] font-mono text-text-dim">
                    {(d().clientCount ?? 0)} client{(d().clientCount ?? 0) !== 1 ? 's' : ''}
                  </span>
                </Show>
                <Show when={!d().enabled}>
                  <span class="text-[8px] font-mono text-amber/80 uppercase border border-amber/30 px-1 rounded-sm">disabled</span>
                </Show>
              </div>
              <div class="flex items-center gap-2">
                <Show when={!editing()}>
                  <button
                    onClick={handleStart}
                    disabled={d().running || action() !== null}
                    class={`mil-btn text-[9px] px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed ${
                      !d().running && action() === null ? 'border-green-500/50 text-green-400' : ''
                    }`}
                  >
                    {action() === 'start' ? 'Starting…' : 'Start'}
                  </button>
                  <button
                    onClick={handleStop}
                    disabled={!d().running || action() !== null}
                    class={`mil-btn text-[9px] px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed ${
                      d().running && action() === null ? 'border-red-500/50 text-red-400' : ''
                    }`}
                  >
                    {action() === 'stop' ? 'Stopping…' : 'Stop'}
                  </button>
                  <button onClick={startEditing} class="mil-btn text-[9px] px-2 py-1">Edit</button>
                </Show>
                <Show when={editing()}>
                  <button onClick={saveDongle} class="mil-btn text-[9px] px-2 py-1 border-cyan text-cyan">Save</button>
                  <button onClick={cancelEditing} class="mil-btn text-[9px] px-2 py-1">Cancel</button>
                </Show>
              </div>
            </div>

            <Show when={actionError()}>
              <div class="text-[10px] font-mono text-red-400 border border-red-500/30 bg-red-500/5 rounded-sm px-3 py-2">
                {actionError()}
              </div>
            </Show>

            <Show when={d().state?.lastError}>
              <div class="text-[10px] font-mono text-amber/90 border border-amber/30 bg-amber/5 rounded-sm px-3 py-2 break-words">
                <span class="uppercase tracking-wider text-[8px] text-amber/70">Source: </span>
                {d().state?.lastError}
              </div>
            </Show>

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
                    <select value={current().source?.type || 'rtl_tcp'} onChange={(e) => {
                        const type = e.currentTarget.value;
                        updateLocalSource('type', type);
                        const rates = sampleRatesFor(type, current().source?.settings);
                        if (!rates.includes(current().sampleRate || 0)) updateLocal('sampleRate', rates[0]);
                      }}
                      class="admin-input w-full">
                      <For each={SOURCE_TYPES}>
                        {(st) => <option value={st.value}>{st.label}</option>}
                      </For>
                    </select>
                  </Show>
                </FieldGroup>
              </div>

              <Show when={isHackRf(sourceType()) || isPluto(sourceType()) || isLime(sourceType())}>
                <p class="text-[9px] font-mono text-text-dim">
                  Receive-only in this WebSDR build: transmit controls are not exposed.
                </p>
              </Show>

              {/* Native USB device selection */}
              <Show when={isNativeSource(sourceType())}>
                <FieldGroup label={isLime(sourceType()) ? 'Device string / serial (blank = first device)' : 'Serial (blank = first device)'}>
                  <Show when={editing()} fallback={<ValueDisplay value={d().source?.serial || 'first available'} />}>
                    <input type="text" value={current().source?.serial || ''}
                      onInput={(e) => updateLocalSource('serial', e.currentTarget.value)}
                      class="admin-input w-full" placeholder="optional serial" />
                  </Show>
                </FieldGroup>
              </Show>

              {/* Detected device picker (native / vendor / network sources) */}
              <Show when={editing() && hasDeviceScan(sourceType())}>
                <FieldGroup label="Detected Devices">
                  <div class="flex items-center gap-2">
                    <select
                      value=""
                      onChange={(e) => {
                        const rows = adminStore.usbDevices().filter((d) => d.source === sourceType());
                        const dev = rows[e.currentTarget.selectedIndex - 1];
                        if (dev) applyDetectedDevice(dev);
                        e.currentTarget.selectedIndex = 0;
                      }}
                      class="admin-input flex-1"
                    >
                      <option value="">{scanning() ? 'Scanning…' : 'Select a detected device'}</option>
                      <For each={adminStore.usbDevices().filter((d) => d.source === sourceType())}>
                        {(dev) => <option value={dev.serial || dev.label || dev.name}>{dev.label || dev.name}{dev.detail ? ` — ${dev.detail}` : ''}</option>}
                      </For>
                    </select>
                    <button type="button" onClick={() => scanDevices(sourceType())} disabled={scanning()}
                      class="mil-btn text-[9px] px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed">
                      {scanning() ? 'Scanning…' : 'Scan'}
                    </button>
                  </div>
                  <Show when={scanError()}>
                    <p class="text-[9px] font-mono text-amber/80 mt-1">{scanError()}</p>
                  </Show>
                </FieldGroup>
              </Show>

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
                    <select value={String(current().sampleRate || sampleRatesFor(sourceType(), current().source?.settings)[0])}
                      onChange={(e) => updateLocal('sampleRate', parseInt(e.currentTarget.value))}
                      class="admin-input">
                      <For each={sampleRatesFor(sourceType(), current().source?.settings)}>
                        {(rate) => <option value={String(rate)}>{formatSampleRate(rate)}</option>}
                      </For>
                    </select>
                  </Show>
                </FieldGroup>
                <Show when={!isAirspyFamily(sourceType()) && !isAirspyHf(sourceType()) && !isElad(sourceType()) && !isRx888(sourceType()) && !isPluto(sourceType()) && !isVendorLibrarySource(sourceType())}>
                  <FieldGroup label="PPM Correction">
                    <Show when={editing()} fallback={<ValueDisplay value={String(d().ppmCorrection || 0)} />}>
                      <input type="number" value={current().ppmCorrection || 0}
                        onInput={(e) => updateLocal('ppmCorrection', parseInt(e.currentTarget.value) || 0)}
                        class="admin-input w-20" />
                    </Show>
                  </FieldGroup>
                </Show>
                <Show when={!isHackRf(sourceType()) && !isAirspyFamily(sourceType()) && !isAirspyHf(sourceType()) && !isElad(sourceType()) && !isRx888(sourceType()) && !isPluto(sourceType()) && !isVendorLibrarySource(sourceType())}>
                  <FieldGroup label="Device Index">
                    <Show when={editing()} fallback={<ValueDisplay value={String(d().deviceIndex || 0)} />}>
                      <input type="number" value={current().deviceIndex || 0} min={0} max={9}
                        onInput={(e) => updateLocal('deviceIndex', parseInt(e.currentTarget.value) || 0)}
                        class="admin-input w-16" />
                    </Show>
                  </FieldGroup>
                </Show>
              </div>

              <div class="grid grid-cols-2 gap-4">
                <Show when={isRtlSource(sourceType())}>
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
                </Show>
                <Show when={!isHackRf(sourceType()) && !isAirspyFamily(sourceType()) && !isAirspyHf(sourceType()) && !isElad(sourceType()) && !isRx888(sourceType()) && !isPluto(sourceType()) && !isVendorLibrarySource(sourceType())}>
                  <FieldGroup label="Gain (dB)">
                    <Show when={editing()} fallback={<ValueDisplay value={String(d().gain || 0)} />}>
                      <input type="number" value={current().gain || 0} step={0.1}
                        onInput={(e) => updateLocal('gain', parseFloat(e.currentTarget.value) || 0)}
                        class="admin-input w-24" />
                    </Show>
                  </FieldGroup>
                </Show>
              </div>

              {/* HackRF gain stages */}
              <Show when={isHackRf(sourceType())}>
                <Show when={editing()} fallback={
                  <div class="grid grid-cols-3 gap-4">
                    <FieldGroup label="LNA (dB)"><ValueDisplay value={String(sourceNumber('lnaDb', 16))} /></FieldGroup>
                    <FieldGroup label="VGA (dB)"><ValueDisplay value={String(sourceNumber('vgaDb', 16))} /></FieldGroup>
                    <FieldGroup label="Filter BW"><ValueDisplay value={sourceNumber('filterBwHz', 0) ? `${sourceNumber('filterBwHz', 0)} Hz` : 'auto'} /></FieldGroup>
                  </div>
                }>
                  <div class="grid grid-cols-3 gap-4">
                    <FieldGroup label="LNA (dB)">
                      <input type="number" value={sourceNumber('lnaDb', 16)} min={0} max={40} step={8}
                        onInput={(e) => updateLocalSetting('lnaDb', parseFloat(e.currentTarget.value) || 0)}
                        class="admin-input w-24" />
                    </FieldGroup>
                    <FieldGroup label="VGA (dB)">
                      <input type="number" value={sourceNumber('vgaDb', 16)} min={0} max={62} step={2}
                        onInput={(e) => updateLocalSetting('vgaDb', parseFloat(e.currentTarget.value) || 0)}
                        class="admin-input w-24" />
                    </FieldGroup>
                    <FieldGroup label="Filter BW (Hz, 0=auto)">
                      <input type="number" value={sourceNumber('filterBwHz', 0)} min={0} step={100000}
                        onInput={(e) => updateLocalSetting('filterBwHz', parseFloat(e.currentTarget.value) || 0)}
                        class="admin-input w-28" />
                    </FieldGroup>
                  </div>
                </Show>
              </Show>

              {/* Airspy gain/AGC */}
              <Show when={isAirspyFamily(sourceType())}>
                <Show when={editing()} fallback={
                  <div class="grid grid-cols-2 gap-4">
                    <FieldGroup label="Gain Step"><ValueDisplay value={String(sourceNumber('gainStep', 11))} /></FieldGroup>
                    <FieldGroup label="Gain Curve"><ValueDisplay value={sourceNumber('gainCurve', 0) === 1 ? 'Sensitivity' : 'Linearity'} /></FieldGroup>
                    <Show when={isHydraSdr(sourceType())}>
                      <FieldGroup label="RF Port"><ValueDisplay value={['ANT', 'CABLE1', 'CABLE2'][sourceNumber('rfPort', 0)] || 'ANT'} /></FieldGroup>
                    </Show>
                  </div>
                }>
                  <div class="grid grid-cols-2 gap-4">
                    <FieldGroup label="Gain Step (0–21)">
                      <input type="number" value={sourceNumber('gainStep', 11)} min={0} max={21}
                        onInput={(e) => updateLocalSetting('gainStep', parseInt(e.currentTarget.value) || 0)}
                        class="admin-input w-24" />
                    </FieldGroup>
                    <FieldGroup label="Gain Curve">
                      <select value={String(sourceNumber('gainCurve', 0))}
                        onChange={(e) => updateLocalSetting('gainCurve', parseInt(e.currentTarget.value) || 0)}
                        class="admin-input">
                        <option value="0">Linearity (strong-signal)</option>
                        <option value="1">Sensitivity (weak-signal)</option>
                      </select>
                    </FieldGroup>
                    <Show when={isHydraSdr(sourceType())}>
                      <FieldGroup label="RF Port">
                        <select value={String(sourceNumber('rfPort', 0))}
                          onChange={(e) => updateLocalSetting('rfPort', parseInt(e.currentTarget.value) || 0)}
                          class="admin-input">
                          <option value="0">ANT</option>
                          <option value="1">CABLE1</option>
                          <option value="2">CABLE2</option>
                        </select>
                      </FieldGroup>
                    </Show>
                  </div>
                </Show>
              </Show>

              {/* Airspy HF+ */}
              <Show when={isAirspyHf(sourceType())}>
                <Show when={editing()} fallback={
                  <div class="grid grid-cols-3 gap-4">
                    <FieldGroup label="Attenuator"><ValueDisplay value={`${sourceNumber('attenuatorDb', 0)} dB`} /></FieldGroup>
                    <FieldGroup label="LNA"><ValueDisplay value={Boolean(sourceSetting('lna') ?? false) ? 'on' : 'off'} /></FieldGroup>
                    <FieldGroup label="Host DSP"><ValueDisplay value={Boolean(sourceSetting('libDsp') ?? true) ? 'on' : 'off'} /></FieldGroup>
                  </div>
                }>
                  <div class="grid grid-cols-3 gap-4">
                    <FieldGroup label="Attenuator (dB, 0 to -48)">
                      <input type="number" value={sourceNumber('attenuatorDb', 0)} min={-48} max={0} step={6}
                        onInput={(e) => updateLocalSetting('attenuatorDb', parseFloat(e.currentTarget.value) || 0)}
                        class="admin-input w-24" />
                    </FieldGroup>
                    <FieldGroup label="Calibration (ppb)">
                      <input type="number" value={sourceNumber('calibrationPpb', 0)}
                        onInput={(e) => updateLocalSetting('calibrationPpb', parseInt(e.currentTarget.value) || 0)}
                        class="admin-input w-24" />
                    </FieldGroup>
                    <FieldGroup label="AGC">
                      <select value={Boolean(sourceSetting('agc') ?? false) ? '1' : '0'}
                        onChange={(e) => updateLocalSetting('agc', e.currentTarget.value === '1')}
                        class="admin-input">
                        <option value="0">Off</option>
                        <option value="1">On</option>
                      </select>
                    </FieldGroup>
                  </div>
                </Show>
              </Show>

              {/* RX-888 */}
              <Show when={isRx888(sourceType())}>
                <Show when={editing()} fallback={
                  <div class="grid grid-cols-3 gap-4">
                    <FieldGroup label="ADC Rate"><ValueDisplay value={formatSampleRate(sourceNumber('adcRateHz', 64_800_000))} /></FieldGroup>
                    <FieldGroup label="DDC Bins"><ValueDisplay value={String(sourceNumber('ddcBins', 256))} /></FieldGroup>
                    <FieldGroup label="Output Rate"><ValueDisplay value={formatSampleRate(rx888OutputRate(current().source?.settings))} /></FieldGroup>
                  </div>
                }>
                  <div class="grid grid-cols-3 gap-4">
                    <FieldGroup label="ADC Rate">
                      <select value={String(sourceNumber('adcRateHz', 64_800_000))}
                        onChange={(e) => {
                          const adc = parseInt(e.currentTarget.value);
                          updateLocalSetting('adcRateHz', adc);
                          updateLocal('sampleRate', Math.round((adc * sourceNumber('ddcBins', 256)) / 8192));
                        }}
                        class="admin-input">
                        <For each={RX888_ADC_RATES}>
                          {(rate) => <option value={String(rate)}>{formatSampleRate(rate)}</option>}
                        </For>
                      </select>
                    </FieldGroup>
                    <FieldGroup label="DDC Bins">
                      <select value={String(sourceNumber('ddcBins', 256))}
                        onChange={(e) => {
                          const bins = parseInt(e.currentTarget.value);
                          updateLocalSetting('ddcBins', bins);
                          updateLocal('sampleRate', Math.round((sourceNumber('adcRateHz', 64_800_000) * bins) / 8192));
                        }}
                        class="admin-input">
                        <For each={RX888_DDC_BINS}>
                          {(bins) => <option value={String(bins)}>{bins}</option>}
                        </For>
                      </select>
                    </FieldGroup>
                    <FieldGroup label="Output Rate">
                      <ValueDisplay value={formatSampleRate(rx888OutputRate(current().source?.settings))} />
                    </FieldGroup>
                    <FieldGroup label="VGA (dB)">
                      <input type="number" value={sourceNumber('vgaDb', 12)} min={0} max={62} step={1}
                        onInput={(e) => updateLocalSetting('vgaDb', parseFloat(e.currentTarget.value) || 0)}
                        class="admin-input w-24" />
                    </FieldGroup>
                    <FieldGroup label="Attenuator (dB, 0 to -31.5)">
                      <input type="number" value={sourceNumber('attenuatorDb', 0)} min={-31.5} max={0} step={0.5}
                        onInput={(e) => updateLocalSetting('attenuatorDb', parseFloat(e.currentTarget.value) || 0)}
                        class="admin-input w-24" />
                    </FieldGroup>
                    <FieldGroup label="Tuner Gain (dB)">
                      <input type="number" value={sourceNumber('tunerGainDb', 30)} min={0} max={50} step={0.5}
                        onInput={(e) => updateLocalSetting('tunerGainDb', parseFloat(e.currentTarget.value) || 0)}
                        class="admin-input w-24" />
                    </FieldGroup>
                    <FieldGroup label="PPM">
                      <input type="number" value={sourceNumber('ppm', 0)} step={0.1}
                        onInput={(e) => updateLocalSetting('ppm', parseFloat(e.currentTarget.value) || 0)}
                        class="admin-input w-24" />
                    </FieldGroup>
                  </div>
                  <p class="text-[9px] font-mono text-text-dim pt-1">
                    Changing the ADC rate or DDC bins reopens the receiver. Output rate is
                    ADC × bins ÷ 8192.
                  </p>
                </Show>
              </Show>

              {/* PlutoSDR */}
              <Show when={isPluto(sourceType())}>
                <Show when={editing()} fallback={
                  <div class="grid grid-cols-3 gap-4">
                    <FieldGroup label="RX Gain"><ValueDisplay value={`${sourceNumber('rxGainDb', 40)} dB`} /></FieldGroup>
                    <FieldGroup label="RF Bandwidth"><ValueDisplay value={sourceNumber('rfBandwidthHz', 0) ? formatSampleRate(sourceNumber('rfBandwidthHz', 0)) : 'auto'} /></FieldGroup>
                    <FieldGroup label="RX Port"><ValueDisplay value={String(sourceSetting('rxPort') ?? 'default')} /></FieldGroup>
                  </div>
                }>
                  <div class="grid grid-cols-3 gap-4">
                    <FieldGroup label="RX Gain (dB)">
                      <input type="number" value={sourceNumber('rxGainDb', 40)} min={-10} max={73} step={1}
                        onInput={(e) => updateLocalSetting('rxGainDb', parseFloat(e.currentTarget.value) || 0)}
                        class="admin-input w-24" />
                    </FieldGroup>
                    <FieldGroup label="AGC">
                      <select value={String(sourceNumber('agc', 1))}
                        onChange={(e) => updateLocalSetting('agc', parseInt(e.currentTarget.value) || 0)}
                        class="admin-input">
                        <option value="0">Manual</option>
                        <option value="1">Slow attack</option>
                        <option value="2">Fast attack</option>
                        <option value="3">Hybrid</option>
                      </select>
                    </FieldGroup>
                    <FieldGroup label="RF Bandwidth (Hz, 0=auto)">
                      <input type="number" value={sourceNumber('rfBandwidthHz', 0)} min={0}
                        onInput={(e) => updateLocalSetting('rfBandwidthHz', parseFloat(e.currentTarget.value) || 0)}
                        class="admin-input w-28" />
                    </FieldGroup>
                    <FieldGroup label="RX Port">
                      <input type="text" value={String(sourceSetting('rxPort') ?? '')} placeholder="A_BALANCED"
                        onInput={(e) => updateLocalSetting('rxPort', e.currentTarget.value)}
                        class="admin-input w-full" />
                    </FieldGroup>
                    <FieldGroup label="Buffer Samples">
                      <input type="number" value={sourceNumber('bufferSamples', 32768)} min={1024}
                        onInput={(e) => updateLocalSetting('bufferSamples', parseInt(e.currentTarget.value) || 32768)}
                        class="admin-input w-28" />
                    </FieldGroup>
                    <FieldGroup label="PPM">
                      <input type="number" value={sourceNumber('ppm', 0)} step={0.1}
                        onInput={(e) => updateLocalSetting('ppm', parseFloat(e.currentTarget.value) || 0)}
                        class="admin-input w-24" />
                    </FieldGroup>
                  </div>
                </Show>
              </Show>

              {/* SDRplay RSP */}
              <Show when={isSdrPlay(sourceType())}>
                <Show when={editing()} fallback={
                  <div class="grid grid-cols-3 gap-4">
                    <FieldGroup label="IF Gain Reduction"><ValueDisplay value={`${sourceNumber('ifGrDb', 40)} dB`} /></FieldGroup>
                    <FieldGroup label="LNA State"><ValueDisplay value={String(sourceNumber('lnaState', 4))} /></FieldGroup>
                    <FieldGroup label="AGC"><ValueDisplay value={['Off', '100 Hz', '50 Hz', '5 Hz'][sourceNumber('agc', 2)] || '50 Hz'} /></FieldGroup>
                  </div>
                }>
                  <div class="grid grid-cols-3 gap-4">
                    <FieldGroup label="IF Gain Reduction (20–59 dB)">
                      <input type="number" value={sourceNumber('ifGrDb', 40)} min={20} max={59}
                        onInput={(e) => updateLocalSetting('ifGrDb', parseInt(e.currentTarget.value) || 20)}
                        class="admin-input w-24" />
                    </FieldGroup>
                    <FieldGroup label="LNA State (0=max gain)">
                      <input type="number" value={sourceNumber('lnaState', 4)} min={0} max={27}
                        onInput={(e) => updateLocalSetting('lnaState', parseInt(e.currentTarget.value) || 0)}
                        class="admin-input w-24" />
                    </FieldGroup>
                    <FieldGroup label="AGC">
                      <select value={String(sourceNumber('agc', 2))}
                        onChange={(e) => updateLocalSetting('agc', parseInt(e.currentTarget.value) || 0)}
                        class="admin-input">
                        <option value="0">Off (manual IF gain)</option>
                        <option value="1">100 Hz</option>
                        <option value="2">50 Hz</option>
                        <option value="3">5 Hz</option>
                      </select>
                    </FieldGroup>
                    <FieldGroup label="AGC Setpoint (dBFS)">
                      <input type="number" value={sourceNumber('agcSetpointDbfs', -60)} min={-72} max={0}
                        onInput={(e) => updateLocalSetting('agcSetpointDbfs', parseInt(e.currentTarget.value) || -60)}
                        class="admin-input w-24" />
                    </FieldGroup>
                    <FieldGroup label="Analog IF Bandwidth">
                      <select value={String(sourceNumber('bwKhz', 0))}
                        onChange={(e) => updateLocalSetting('bwKhz', parseInt(e.currentTarget.value) || 0)}
                        class="admin-input">
                        <option value="0">Auto</option>
                        <For each={[200, 300, 600, 1536, 5000, 6000, 7000, 8000]}>
                          {(bw) => <option value={String(bw)}>{bw} kHz</option>}
                        </For>
                      </select>
                    </FieldGroup>
                    <FieldGroup label="PPM">
                      <input type="number" value={sourceNumber('ppm', 0)} step={0.1}
                        onInput={(e) => updateLocalSetting('ppm', parseFloat(e.currentTarget.value) || 0)}
                        class="admin-input w-24" />
                    </FieldGroup>
                    <FieldGroup label="Antenna Port">
                      <input type="text" value={String(sourceSetting('antenna') ?? '')} placeholder="default"
                        onInput={(e) => updateLocalSetting('antenna', e.currentTarget.value)}
                        class="admin-input w-full" />
                    </FieldGroup>
                    <FieldGroup label="Duo Tuner">
                      <select value={String(sourceNumber('duoTuner', 0))}
                        onChange={(e) => updateLocalSetting('duoTuner', parseInt(e.currentTarget.value) || 0)}
                        class="admin-input">
                        <option value="0">Tuner 1 (50 Ohm / Hi-Z)</option>
                        <option value="1">Tuner 2 (50 Ohm)</option>
                      </select>
                    </FieldGroup>
                    <FieldGroup label="HDR Path (RSPdx)">
                      <select value={sourceNumber('hdr', 0) ? '1' : '0'}
                        onChange={(e) => updateLocalSetting('hdr', e.currentTarget.value === '1')}
                        class="admin-input">
                        <option value="0">Off</option>
                        <option value="1">On</option>
                      </select>
                    </FieldGroup>
                  </div>
                  <div class="flex flex-wrap gap-3 pt-2">
                    <ToggleChip label="FM Notch" value={Boolean(sourceSetting('rfNotch') ?? false)} onChange={(v) => updateLocalSetting('rfNotch', v)} />
                    <ToggleChip label="DAB Notch" value={Boolean(sourceSetting('dabNotch') ?? false)} onChange={(v) => updateLocalSetting('dabNotch', v)} />
                    <ToggleChip label="Extended IF Gain" value={Boolean(sourceSetting('extendedIfGr') ?? false)} onChange={(v) => updateLocalSetting('extendedIfGr', v)} />
                  </div>
                </Show>
              </Show>

              {/* LimeSDR */}
              <Show when={isLime(sourceType())}>
                <Show when={editing()} fallback={
                  <div class="grid grid-cols-3 gap-4">
                    <FieldGroup label="RX Gain"><ValueDisplay value={`${sourceNumber('rxGainDb', 40)} dB`} /></FieldGroup>
                    <FieldGroup label="RX Antenna"><ValueDisplay value={String(sourceSetting('antennaRx') ?? 'auto')} /></FieldGroup>
                    <FieldGroup label="RX Channel"><ValueDisplay value={String(sourceNumber('channel', 0))} /></FieldGroup>
                  </div>
                }>
                  <div class="grid grid-cols-3 gap-4">
                    <FieldGroup label="RX Gain (dB)">
                      <input type="number" value={sourceNumber('rxGainDb', 40)} min={0} max={73}
                        onInput={(e) => updateLocalSetting('rxGainDb', parseFloat(e.currentTarget.value) || 0)}
                        class="admin-input w-24" />
                    </FieldGroup>
                    <FieldGroup label="RX Channel">
                      <select value={String(sourceNumber('channel', 0))}
                        onChange={(e) => updateLocalSetting('channel', parseInt(e.currentTarget.value) || 0)}
                        class="admin-input">
                        <option value="0">0</option>
                        <option value="1">1</option>
                      </select>
                    </FieldGroup>
                    <FieldGroup label="RX Antenna (LNAH/LNAL/LNAW)">
                      <input type="text" value={String(sourceSetting('antennaRx') ?? '')} placeholder="auto"
                        onInput={(e) => updateLocalSetting('antennaRx', e.currentTarget.value)}
                        class="admin-input w-full" />
                    </FieldGroup>
                    <FieldGroup label="Analog LPF (Hz, 0=auto)">
                      <input type="number" value={sourceNumber('lpfRxHz', 0)} min={0} step={100000}
                        onInput={(e) => updateLocalSetting('lpfRxHz', parseFloat(e.currentTarget.value) || 0)}
                        class="admin-input w-28" />
                    </FieldGroup>
                    <FieldGroup label="Oversampling">
                      <select value={String(sourceNumber('oversample', 0))}
                        onChange={(e) => updateLocalSetting('oversample', parseInt(e.currentTarget.value) || 0)}
                        class="admin-input">
                        <option value="0">Device default</option>
                        <For each={[1, 2, 4, 8, 16, 32]}>
                          {(v) => <option value={String(v)}>{v}×</option>}
                        </For>
                      </select>
                    </FieldGroup>
                    <FieldGroup label="FIFO (kSamples)">
                      <input type="number" value={sourceNumber('fifoKsamples', 256)} min={16}
                        onInput={(e) => updateLocalSetting('fifoKsamples', parseInt(e.currentTarget.value) || 256)}
                        class="admin-input w-24" />
                    </FieldGroup>
                    <FieldGroup label="Throughput vs Latency">
                      <input type="number" value={sourceNumber('throughputVsLatency', 0.5)} min={0} max={1} step={0.05}
                        onInput={(e) => updateLocalSetting('throughputVsLatency', parseFloat(e.currentTarget.value) || 0)}
                        class="admin-input w-24" />
                    </FieldGroup>
                  </div>
                  <div class="flex flex-wrap gap-3 pt-2">
                    <ToggleChip label="Calibrate at Open" value={Boolean(sourceSetting('calibrate') ?? true)} onChange={(v) => updateLocalSetting('calibrate', v)} />
                    <ToggleChip label="IQ Correction" value={Boolean(sourceSetting('iqCorrection') ?? true)} onChange={(v) => updateLocalSetting('iqCorrection', v)} />
                  </div>
                  <p class="text-[9px] font-mono text-text-dim pt-1">TX is disabled in this build.</p>
                </Show>
              </Show>

              {/* Fobos SDR */}
              <Show when={isFobos(sourceType())}>
                <Show when={editing()} fallback={
                  <div class="grid grid-cols-3 gap-4">
                    <FieldGroup label="Port"><ValueDisplay value={['RF', 'HF1', 'HF2', 'HF1+HF2'][sourceNumber('port', 0)] || 'RF'} /></FieldGroup>
                    <FieldGroup label="LNA Gain"><ValueDisplay value={String(sourceNumber('lnaGain', 2))} /></FieldGroup>
                    <FieldGroup label="VGA Gain"><ValueDisplay value={String(sourceNumber('vgaGain', 10))} /></FieldGroup>
                  </div>
                }>
                  <div class="grid grid-cols-3 gap-4">
                    <FieldGroup label="Input Port">
                      <select value={String(sourceNumber('port', 0))}
                        onChange={(e) => updateLocalSetting('port', parseInt(e.currentTarget.value) || 0)}
                        class="admin-input">
                        <option value="0">RF (tuner)</option>
                        <option value="1">HF1 (direct sampling)</option>
                        <option value="2">HF2 (direct sampling)</option>
                        <option value="3">HF1 + HF2 (primary channel)</option>
                      </select>
                    </FieldGroup>
                    <FieldGroup label="LNA Gain (0–3)">
                      <input type="number" value={sourceNumber('lnaGain', 2)} min={0} max={3}
                        onInput={(e) => updateLocalSetting('lnaGain', parseInt(e.currentTarget.value) || 0)}
                        class="admin-input w-24" />
                    </FieldGroup>
                    <FieldGroup label="VGA Gain (0–31)">
                      <input type="number" value={sourceNumber('vgaGain', 10)} min={0} max={31}
                        onInput={(e) => updateLocalSetting('vgaGain', parseInt(e.currentTarget.value) || 0)}
                        class="admin-input w-24" />
                    </FieldGroup>
                  </div>
                  <div class="flex flex-wrap gap-3 pt-2">
                    <ToggleChip label="External Clock" value={Boolean(sourceSetting('clkExternal') ?? false)} onChange={(v) => updateLocalSetting('clkExternal', v)} />
                  </div>
                </Show>
              </Show>

              {/* Toggle options */}
              <Show when={editing()}>
                <div class="flex flex-wrap gap-3 pt-2 border-t border-border/30">
                  <ToggleChip label="Enabled" value={current().enabled ?? true} onChange={(v) => updateLocal('enabled', v)} />
                  <ToggleChip label="Auto Start" value={current().autoStart ?? false} onChange={(v) => updateLocal('autoStart', v)} />
                  <ToggleChip label="Bias-T" value={current().biasT ?? false} onChange={(v) => updateLocal('biasT', v)} />
                  <Show when={isHackRf(sourceType())}>
                    <ToggleChip label="RF Amp (+14 dB)" value={Boolean(sourceSetting('amp') ?? false)}
                      onChange={(v) => updateLocalSetting('amp', v)} />
                  </Show>
                  <Show when={isAirspyFamily(sourceType())}>
                    <ToggleChip label="LNA AGC" value={Boolean(sourceSetting('lnaAgc') ?? false)}
                      onChange={(v) => updateLocalSetting('lnaAgc', v)} />
                    <ToggleChip label="Mixer AGC" value={Boolean(sourceSetting('mixerAgc') ?? false)}
                      onChange={(v) => updateLocalSetting('mixerAgc', v)} />
                    <ToggleChip label="DC Block" value={Boolean(sourceSetting('dcBlock') ?? true)}
                      onChange={(v) => updateLocalSetting('dcBlock', v)} />
                  </Show>
                  <Show when={isRx888(sourceType())}>
                    <ToggleChip label="Dither" value={Boolean(sourceSetting('dither') ?? false)}
                      onChange={(v) => updateLocalSetting('dither', v)} />
                    <ToggleChip label="PGA" value={Boolean(sourceSetting('pga') ?? true)}
                      onChange={(v) => updateLocalSetting('pga', v)} />
                    <ToggleChip label="Tuner AGC" value={Boolean(sourceSetting('tunerAgc') ?? false)}
                      onChange={(v) => updateLocalSetting('tunerAgc', v)} />
                    <ToggleChip label="VHF Bias-T" value={Boolean(sourceSetting('biasTeeVhf') ?? false)}
                      onChange={(v) => updateLocalSetting('biasTeeVhf', v)} />
                  </Show>
                  <Show when={isElad(sourceType())}>
                    <ToggleChip label="12 dB Attenuator" value={Boolean(sourceSetting('attenuator') ?? false)}
                      onChange={(v) => updateLocalSetting('attenuator', v)} />
                    <ToggleChip label="Preselector" value={Boolean(sourceSetting('preselector') ?? true)}
                      onChange={(v) => updateLocalSetting('preselector', v)} />
                  </Show>
                  <Show when={isAirspyHf(sourceType())}>
                    <ToggleChip label="AGC High Threshold" value={Boolean(sourceSetting('agcThresholdHigh') ?? false)}
                      onChange={(v) => updateLocalSetting('agcThresholdHigh', v)} />
                    <ToggleChip label="HF LNA" value={Boolean(sourceSetting('lna') ?? false)}
                      onChange={(v) => updateLocalSetting('lna', v)} />
                    <ToggleChip label="Host DSP" value={Boolean(sourceSetting('libDsp') ?? true)}
                      onChange={(v) => updateLocalSetting('libDsp', v)} />
                  </Show>
                  <Show when={isRtlSource(sourceType())}>
                    <ToggleChip label="Digital AGC" value={current().digitalAgc ?? false} onChange={(v) => updateLocal('digitalAgc', v)} />
                    <ToggleChip label="Offset Tuning" value={current().offsetTuning ?? false} onChange={(v) => updateLocal('offsetTuning', v)} />
                  </Show>
                  <ToggleChip label="IQ Correction" value={current().iqCorrection ?? false} onChange={(v) => updateLocal('iqCorrection', v)} />
                </div>
              </Show>

              <Show when={!editing()}>
                <div class="flex flex-wrap gap-2 pt-2 border-t border-border/30">
                  <Show when={d().enabled}><StatusChip label="Enabled" active /></Show>
                  <Show when={d().autoStart}><StatusChip label="Auto Start" active /></Show>
                  <Show when={d().biasT}><StatusChip label="Bias-T" active /></Show>
                  <Show when={isHackRf(sourceType()) && Boolean(d().source?.settings?.amp)}>
                    <StatusChip label="RF Amp" active />
                  </Show>
                  <Show when={isAirspyFamily(sourceType()) && Boolean(d().source?.settings?.lnaAgc)}>
                    <StatusChip label="LNA AGC" active />
                  </Show>
                  <Show when={isAirspyFamily(sourceType()) && Boolean(d().source?.settings?.mixerAgc)}>
                    <StatusChip label="Mixer AGC" active />
                  </Show>
                  <Show when={isAirspyHf(sourceType()) && Boolean(d().source?.settings?.agc)}>
                    <StatusChip label="AGC" active />
                  </Show>
                  <Show when={isAirspyHf(sourceType()) && Boolean(d().source?.settings?.lna)}>
                    <StatusChip label="HF LNA" active />
                  </Show>
                  <Show when={isElad(sourceType()) && Boolean(d().source?.settings?.attenuator)}>
                    <StatusChip label="12 dB ATT" active />
                  </Show>
                  <Show when={isElad(sourceType()) && Boolean(d().source?.settings?.preselector ?? true)}>
                    <StatusChip label="Preselector" active />
                  </Show>
                  <Show when={isRtlSource(sourceType()) && d().digitalAgc}><StatusChip label="Digital AGC" active /></Show>
                  <Show when={isRtlSource(sourceType()) && d().offsetTuning}><StatusChip label="Offset Tuning" active /></Show>
                  <Show when={d().iqCorrection}><StatusChip label="IQ Correction" active /></Show>
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
  const dongleType = () => adminStore.getSelectedDongle()?.source?.type;
  const dongleSettings = () => adminStore.getSelectedDongle()?.source?.settings;

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
            <select value={String(local().sampleRate || sampleRatesFor(dongleType(), dongleSettings())[0])}
              onChange={(e) => update('sampleRate', parseInt(e.currentTarget.value))}
              class="admin-input w-full">
              <For each={sampleRatesFor(dongleType(), dongleSettings())}>
                {(rate) => <option value={String(rate)}>{formatSampleRate(rate)}</option>}
              </For>
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
          <Show when={isRtlSource(dongleType())}>
            <FieldGroup label="Direct Sampling">
              <select value={String(local().directSampling || 0)}
                onChange={(e) => update('directSampling', parseInt(e.currentTarget.value))}
                class="admin-input">
                <option value="0">Off</option>
                <option value="1">I-ADC</option>
                <option value="2">Q-ADC</option>
              </select>
            </FieldGroup>
          </Show>
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
  return type === 'rtl_tcp' || type === 'airspy_tcp' || type === 'hfp_tcp' || type === 'rsp_tcp' || type === 'pluto';
}

function isRtlSource(type?: string): boolean {
  return type === 'local' || type === 'rtl_tcp';
}

function isHackRf(type?: string): boolean {
  return type === 'hackrf';
}

function isAirspy(type?: string): boolean {
  return type === 'airspy';
}

function isAirspyHf(type?: string): boolean {
  return type === 'airspyhf';
}

function isHydraSdr(type?: string): boolean {
  return type === 'hydrasdr';
}

function isElad(type?: string): boolean {
  return type === 'elad';
}

function isRx888(type?: string): boolean {
  return type === 'rx888';
}

function isPluto(type?: string): boolean {
  return type === 'pluto';
}

function isSdrPlay(type?: string): boolean {
  return type === 'sdrplay';
}

function isLime(type?: string): boolean {
  return type === 'lime';
}

function isFobos(type?: string): boolean {
  return type === 'fobos';
}

/** Sources driven through a vendor/userspace library rather than a native
 *  USB protocol; they all use `source.serial` as the device selector. */
function isVendorLibrarySource(type?: string): boolean {
  return isSdrPlay(type) || isLime(type) || isFobos(type);
}

function isAirspyFamily(type?: string): boolean {
  return isAirspy(type) || isHydraSdr(type);
}

function isNativeSource(type?: string): boolean {
  return type === 'local' || type === 'hackrf' || type === 'airspy' || type === 'airspyhf' || type === 'hydrasdr' || type === 'elad' || type === 'rx888' || isVendorLibrarySource(type);
}

/** Sources with a non-invasive device scan on the backend. */
function hasDeviceScan(type?: string): boolean {
  return isNativeSource(type) || isPluto(type);
}

const RTL_SAMPLE_RATES = [960_000, 1_200_000, 1_440_000, 1_800_000, 2_400_000, 2_880_000, 3_200_000];
const HACKRF_SAMPLE_RATES = [2_000_000, 4_000_000, 8_000_000, 10_000_000, 12_500_000, 16_000_000, 20_000_000];
const AIRSPY_SAMPLE_RATES = [2_500_000, 3_000_000, 6_000_000, 10_000_000];
const AIRSPY_HF_SAMPLE_RATES = [192_000, 228_000, 256_000, 384_000, 456_000, 650_000, 768_000, 912_000];
const HYDRA_SDR_SAMPLE_RATES = [2_500_000, 4_096_000, 5_000_000, 6_000_000, 8_000_000, 10_000_000, 12_000_000];
const ELAD_SAMPLE_RATES = [192_000, 384_000, 768_000, 1_536_000, 3_072_000, 6_144_000];
const RX888_ADC_RATES = [8_100_000, 16_200_000, 32_400_000, 48_600_000, 64_800_000, 96_000_000, 129_600_000];
const RX888_DDC_BINS = [256, 512, 1024, 2048, 4096];
const PLUTO_SAMPLE_RATES = [521_000, 1_000_000, 2_000_000, 2_500_000, 3_840_000, 5_000_000];
const SDRPLAY_SAMPLE_RATES = [250_000, 500_000, 1_000_000, 2_000_000, 3_000_000, 4_000_000, 5_000_000, 6_000_000, 8_000_000, 10_000_000];
const LIME_SAMPLE_RATES = [100_000, 250_000, 500_000, 750_000, 1_000_000, 2_000_000, 2_500_000, 5_000_000, 10_000_000, 15_360_000, 20_000_000, 30_720_000, 40_000_000];
const FOBOS_SAMPLE_RATES = [625_000, 1_250_000, 2_500_000, 5_000_000, 8_000_000, 10_000_000, 12_500_000, 16_000_000, 20_000_000, 25_000_000, 32_000_000, 40_000_000, 50_000_000, 80_000_000];

type SourceSettings = Record<string, string | number | boolean> | undefined;

function numericSetting(settings: SourceSettings, key: string, fallback: number): number {
  const value = settings?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The RX-888's output rate is a function of the ADC rate and DDC bin count,
 *  not a free choice. Keep the admin's sample-rate option in step with it. */
function rx888OutputRate(settings?: SourceSettings): number {
  const adc = numericSetting(settings, 'adcRateHz', 64_800_000);
  const bins = numericSetting(settings, 'ddcBins', 256);
  return Math.round((adc * bins) / 8192);
}

function sampleRatesFor(type?: string, settings?: SourceSettings): number[] {
  if (isHackRf(type)) return HACKRF_SAMPLE_RATES;
  if (isAirspy(type)) return AIRSPY_SAMPLE_RATES;
  if (isAirspyHf(type)) return AIRSPY_HF_SAMPLE_RATES;
  if (isHydraSdr(type)) return HYDRA_SDR_SAMPLE_RATES;
  if (isElad(type)) return ELAD_SAMPLE_RATES;
  if (isRx888(type)) return [rx888OutputRate(settings)];
  if (isPluto(type)) return PLUTO_SAMPLE_RATES;
  if (isSdrPlay(type)) return SDRPLAY_SAMPLE_RATES;
  if (isLime(type)) return LIME_SAMPLE_RATES;
  if (isFobos(type)) return FOBOS_SAMPLE_RATES;
  return RTL_SAMPLE_RATES;
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
