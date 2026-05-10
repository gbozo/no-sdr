// ============================================================
// General Settings Section — Station info, network, security, codecs
// ============================================================

import { Component, Show, For, createMemo, createSignal } from 'solid-js';
import { adminStore } from '../admin-store';

// All available codecs for checkboxes
const ALL_FFT_CODECS = ['none', 'adpcm', 'deflate', 'deflate-floor'];
const ALL_IQ_CODECS = ['none', 'adpcm', 'opus-lo', 'opus', 'opus-hq'];

const GeneralSection: Component = () => {
  const cfg = () => adminStore.serverConfig();

  return (
    <div class="max-w-2xl">
      <h2 class="text-sm font-mono uppercase tracking-wider text-text-primary mb-1">General Settings</h2>
      <p class="text-[10px] font-mono text-text-dim mb-6">Station info, network, security, and codec configuration</p>

      <Show when={!adminStore.serverConfigLoading()} fallback={<LoadingIndicator />}>
        <div class="space-y-8">
          {/* Station Information */}
          <SettingsGroup title="Station Information" description="Public identification for your SDR station">
            <FieldRow label="Callsign" help="Station callsign or identifier">
              <TextInput
                value={cfg().callsign}
                onChange={(v) => adminStore.updateServerConfigField('callsign', v)}
                placeholder="e.g. KF7LDV"
              />
            </FieldRow>
            <FieldRow label="Description" help="Short description of what this SDR covers">
              <TextInput
                value={cfg().description}
                onChange={(v) => adminStore.updateServerConfigField('description', v)}
                placeholder="e.g. HF/VHF station in Athens, Greece"
              />
            </FieldRow>
            <FieldRow label="Location" help="Geographic location (city, country, grid square)">
              <TextInput
                value={cfg().location}
                onChange={(v) => adminStore.updateServerConfigField('location', v)}
                placeholder="e.g. Athens, Greece / KM17vx"
              />
            </FieldRow>
          </SettingsGroup>

          {/* Network */}
          <SettingsGroup title="Network" description="Server bind address (requires restart to take effect)">
            <FieldRow label="Host" help="IP address to bind to (0.0.0.0 = all interfaces)">
              <TextInput
                value={cfg().host}
                onChange={(v) => adminStore.updateServerConfigField('host', v)}
                placeholder="0.0.0.0"
              />
            </FieldRow>
            <FieldRow label="Port" help="TCP port for HTTP and WebSocket">
              <NumberInput
                value={cfg().port}
                onChange={(v) => adminStore.updateServerConfigField('port', v)}
                min={1}
                max={65535}
              />
            </FieldRow>
            <FieldRow label="Real IP Header" help="Read client IP from a proxy/tunnel header instead of TCP RemoteAddr">
              <ProxyIPHeaderInput
                value={cfg().realIPHeader}
                onChange={(v) => adminStore.updateServerConfigField('realIPHeader', v)}
              />
            </FieldRow>
            <div class="mt-2 px-3 py-2 bg-amber/5 border border-amber/20 rounded-sm">
              <p class="text-[9px] font-mono text-amber uppercase tracking-wider">
                Network changes require a server restart to take effect
              </p>
            </div>
          </SettingsGroup>

          {/* Security */}
          <SettingsGroup title="Security" description="Admin access password">
            <FieldRow label="Admin Password" help="Password for admin panel access">
              <PasswordInput
                value={cfg().adminPassword}
                onChange={(v) => adminStore.updateServerConfigField('adminPassword', v)}
                placeholder="Enter new password"
              />
            </FieldRow>
          </SettingsGroup>

          {/* DSP / History */}
          <SettingsGroup title="DSP & History" description="FFT history, signal processing, and Opus codec settings">
            <FieldRow label="History FFT Size" help="FFT bin count for waterfall history buffer">
              <SelectInput
                value={String(cfg().fftHistoryFftSize)}
                onChange={(v) => adminStore.updateServerConfigField('fftHistoryFftSize', parseInt(v))}
                options={[
                  { value: '256', label: '256' },
                  { value: '512', label: '512' },
                  { value: '1024', label: '1024' },
                  { value: '2048', label: '2048' },
                  { value: '4096', label: '4096' },
                ]}
              />
            </FieldRow>
            <FieldRow label="History Compression" help="Codec for FFT history storage">
              <SelectInput
                value={cfg().fftHistoryCompression}
                onChange={(v) => adminStore.updateServerConfigField('fftHistoryCompression', v)}
                options={[
                  { value: 'none', label: 'None' },
                  { value: 'deflate', label: 'Deflate' },
                  { value: 'adpcm', label: 'ADPCM' },
                ]}
              />
            </FieldRow>
            <FieldRow label="Opus Complexity" help="Encoder CPU vs quality trade-off (0=fastest, 10=best). Default 5 is transparent for radio audio at ≤64kbps.">
              <div class="flex items-center gap-3">
                <SelectInput
                  value={String(cfg().opusComplexity)}
                  onChange={(v) => adminStore.updateServerConfigField('opusComplexity', parseInt(v))}
                  options={[
                    { value: '0', label: '0 — Fastest' },
                    { value: '1', label: '1' },
                    { value: '2', label: '2' },
                    { value: '3', label: '3' },
                    { value: '4', label: '4' },
                    { value: '5', label: '5 — Default' },
                    { value: '6', label: '6' },
                    { value: '7', label: '7' },
                    { value: '8', label: '8' },
                    { value: '9', label: '9' },
                    { value: '10', label: '10 — Best' },
                  ]}
                />
                <span class="text-[9px] font-mono text-text-dim">Takes effect on next client connect</span>
              </div>
            </FieldRow>
            <FieldRow label="Demo Mode" help="Use simulated signals (no hardware required)">
              <ToggleInput
                value={cfg().demoMode}
                onChange={(v) => adminStore.updateServerConfigField('demoMode', v)}
              />
            </FieldRow>
          </SettingsGroup>

          {/* Allowed Codecs */}
          <SettingsGroup title="Allowed Codecs" description="Select which codecs clients may negotiate">
            <div class="space-y-4">
              <div>
                <label class="text-[10px] font-mono uppercase tracking-wider text-text-secondary mb-2 block">
                  FFT Codecs
                </label>
                <CodecCheckboxes
                  all={ALL_FFT_CODECS}
                  selected={cfg().allowedFftCodecs}
                  onChange={(v) => adminStore.updateServerConfigField('allowedFftCodecs', v)}
                />
              </div>
              <div>
                <label class="text-[10px] font-mono uppercase tracking-wider text-text-secondary mb-2 block">
                  IQ Codecs
                </label>
                <CodecCheckboxes
                  all={ALL_IQ_CODECS}
                  selected={cfg().allowedIqCodecs}
                  onChange={(v) => adminStore.updateServerConfigField('allowedIqCodecs', v)}
                />
              </div>
            </div>
          </SettingsGroup>
        </div>
      </Show>
    </div>
  );
};

// ---- Sub-components ----

const SettingsGroup: Component<{ title: string; description: string; children: any }> = (props) => (
  <div class="pb-6 border-b border-border/40 last:border-b-0">
    <h3 class="text-[11px] font-mono uppercase tracking-wider text-text-secondary mb-0.5">{props.title}</h3>
    <p class="text-[9px] font-mono text-text-dim mb-4">{props.description}</p>
    <div class="space-y-3">{props.children}</div>
  </div>
);

const FieldRow: Component<{ label: string; help?: string; children: any }> = (props) => (
  <div class="flex items-start gap-4">
    <div class="w-36 shrink-0 pt-2">
      <label class="text-[10px] font-mono text-text-primary">{props.label}</label>
      <Show when={props.help}>
        <p class="text-[8px] font-mono text-text-dim mt-0.5">{props.help}</p>
      </Show>
    </div>
    <div class="flex-1">{props.children}</div>
  </div>
);

const TextInput: Component<{ value: string; onChange: (v: string) => void; placeholder?: string }> = (props) => (
  <input
    type="text"
    value={props.value}
    onInput={(e) => props.onChange(e.currentTarget.value)}
    placeholder={props.placeholder}
    class="w-full px-3 py-1.5 bg-sdr-base border border-border rounded-sm
           text-xs font-mono text-text-primary placeholder-text-dim
           focus:outline-none focus:border-cyan transition-colors"
  />
);

const PasswordInput: Component<{ value: string; onChange: (v: string) => void; placeholder?: string }> = (props) => (
  <input
    type="password"
    value={props.value}
    onInput={(e) => props.onChange(e.currentTarget.value)}
    placeholder={props.placeholder}
    autocomplete="new-password"
    class="w-full px-3 py-1.5 bg-sdr-base border border-border rounded-sm
           text-xs font-mono text-text-primary placeholder-text-dim
           focus:outline-none focus:border-cyan transition-colors"
  />
);

const NumberInput: Component<{ value: number; onChange: (v: number) => void; min?: number; max?: number }> = (props) => (
  <input
    type="number"
    value={props.value}
    onInput={(e) => {
      const v = parseInt(e.currentTarget.value);
      if (!isNaN(v)) props.onChange(v);
    }}
    min={props.min}
    max={props.max}
    class="w-32 px-3 py-1.5 bg-sdr-base border border-border rounded-sm
           text-xs font-mono text-text-primary
           focus:outline-none focus:border-cyan transition-colors"
  />
);

const SelectInput: Component<{ value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }> = (props) => (
  <select
    onChange={(e) => props.onChange(e.currentTarget.value)}
    class="px-3 py-1.5 bg-sdr-base border border-border rounded-sm
           text-xs font-mono text-text-primary
           focus:outline-none focus:border-cyan transition-colors"
  >
    <For each={props.options}>
      {(opt) => <option value={opt.value} selected={opt.value === props.value}>{opt.label}</option>}
    </For>
  </select>
);

const ToggleInput: Component<{ value: boolean; onChange: (v: boolean) => void }> = (props) => (
  <button
    type="button"
    onClick={() => props.onChange(!props.value)}
    class={`relative w-10 h-5 rounded-full border transition-colors ${
      props.value
        ? 'bg-cyan/20 border-cyan'
        : 'bg-sdr-base border-border'
    }`}
  >
    <span
      class={`absolute top-0.5 w-4 h-4 rounded-full transition-all ${
        props.value
          ? 'left-5 bg-cyan'
          : 'left-0.5 bg-text-dim'
      }`}
    />
  </button>
);

const CodecCheckboxes: Component<{ all: string[]; selected: string[]; onChange: (v: string[]) => void }> = (props) => {
  const toggle = (codec: string) => {
    const current = props.selected;
    const next = current.includes(codec)
      ? current.filter(c => c !== codec)
      : [...current, codec];
    props.onChange(next);
  };

  return (
    <div class="flex flex-wrap gap-2">
      <For each={props.all}>
        {(codec) => {
          const checked = createMemo(() => props.selected.includes(codec));
          return (
            <button
              type="button"
              onClick={() => toggle(codec)}
              class={`px-3 py-1 text-[10px] font-mono uppercase tracking-wider rounded-sm border transition-colors ${
                checked()
                  ? 'border-cyan text-cyan bg-cyan/10'
                  : 'border-border text-text-dim hover:text-text-secondary hover:border-border'
              }`}
            >
              {codec}
            </button>
          );
        }}
      </For>
    </div>
  );
};

const KNOWN_PRESET_VALUES = new Set([
  '', 'CF-Connecting-IP', 'X-Real-IP', 'X-Forwarded-For', 'True-Client-IP', 'X-Client-IP',
]);

const PROXY_HEADER_PRESETS = [
  { value: '',                   label: 'Direct (no proxy)' },
  { value: 'CF-Connecting-IP',   label: 'CF-Connecting-IP — Cloudflare' },
  { value: 'X-Real-IP',          label: 'X-Real-IP — nginx / Caddy' },
  { value: 'X-Forwarded-For',    label: 'X-Forwarded-For — generic proxy' },
  { value: 'True-Client-IP',     label: 'True-Client-IP — Akamai / Cloudflare Enterprise' },
  { value: 'X-Client-IP',        label: 'X-Client-IP — Apache' },
  { value: '__custom__',         label: 'Custom header…' },
];

const ProxyIPHeaderInput: Component<{ value: string; onChange: (v: string) => void }> = (props) => {
  const isCustom = () => props.value !== '' && !KNOWN_PRESET_VALUES.has(props.value);

  // Local signal tracks whether the user has chosen the "Custom" option in the
  // dropdown. We need this separately from props.value because when the user
  // first clicks "Custom" the text field is empty and props.value stays ''.
  const [customMode, setCustomMode] = createSignal(isCustom());

  // The text shown in the custom text input — seeded from props.value if it
  // already holds a non-preset value (e.g. loaded from config).
  const [customText, setCustomText] = createSignal(isCustom() ? props.value : '');

  const selectValue = () => {
    if (customMode()) return '__custom__';
    if (KNOWN_PRESET_VALUES.has(props.value)) return props.value;
    return '';
  };

  const handlePresetChange = (v: string) => {
    if (v === '__custom__') {
      // Enter custom mode — do NOT call onChange yet; wait for the user to type
      setCustomMode(true);
    } else {
      setCustomMode(false);
      props.onChange(v);
    }
  };

  const handleCustomChange = (v: string) => {
    setCustomText(v);
    props.onChange(v);
  };

  return (
    <div class="flex flex-col gap-2">
      <SelectInput
        value={selectValue()}
        onChange={handlePresetChange}
        options={PROXY_HEADER_PRESETS}
      />
      <Show when={customMode()}>
        <TextInput
          value={customText()}
          onChange={handleCustomChange}
          placeholder="e.g. X-My-Real-IP"
        />
      </Show>
      <Show when={props.value !== ''}>
        <p class="text-[8px] font-mono text-text-dim">
          Active: <span class="text-cyan">{props.value}</span> — takes effect on next client connect
        </p>
      </Show>
    </div>
  );
};

const LoadingIndicator: Component = () => (
  <div class="flex items-center justify-center py-12">
    <div class="text-text-dim text-[10px] font-mono uppercase tracking-wider animate-pulse">
      Loading configuration...
    </div>
  </div>
);

export default GeneralSection;
