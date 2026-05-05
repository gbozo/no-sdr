// ============================================================
// Music ID Section — AudD + ACRCloud API key configuration
// ============================================================

import { Component, Show } from 'solid-js';
import { adminStore } from '../admin-store';

const IdentifySection: Component = () => {
  const cfg = () => adminStore.serverConfig();

  return (
    <div class="max-w-2xl">
      <h2 class="text-sm font-mono uppercase tracking-wider text-text-primary mb-1">Music Identification</h2>
      <p class="text-[10px] font-mono text-text-dim mb-6">
        API credentials for the identify button (AudD primary, ACRCloud fallback).
        Keys are stored in config.yaml and never sent to clients.
      </p>

      <Show when={!adminStore.serverConfigLoading()} fallback={<LoadingIndicator />}>
        <div class="space-y-8">

          {/* AudD */}
          <SettingsGroup
            title="AudD"
            description="Primary recognition service — https://audd.io"
          >
            <FieldRow label="API Key" help="Your AudD API key from dashboard.audd.io">
              <PasswordInput
                value={cfg().auddApiKey}
                onChange={(v) => adminStore.updateServerConfigField('auddApiKey', v)}
                placeholder="test (free tier) or your key"
              />
            </FieldRow>
          </SettingsGroup>

          {/* ACRCloud */}
          <SettingsGroup
            title="ACRCloud"
            description="Fallback recognition service — https://www.acrcloud.com"
          >
            <FieldRow label="Host" help="Regional endpoint, e.g. identify-eu-west-1.acrcloud.com">
              <TextInput
                value={cfg().acrcloudHost}
                onChange={(v) => adminStore.updateServerConfigField('acrcloudHost', v)}
                placeholder="identify-eu-west-1.acrcloud.com"
              />
            </FieldRow>
            <FieldRow label="Access Key" help="Access key from ACRCloud console">
              <TextInput
                value={cfg().acrcloudAccessKey}
                onChange={(v) => adminStore.updateServerConfigField('acrcloudAccessKey', v)}
                placeholder="Your ACRCloud access key"
              />
            </FieldRow>
            <FieldRow label="Access Secret" help="Access secret from ACRCloud console">
              <PasswordInput
                value={cfg().acrcloudAccessSecret}
                onChange={(v) => adminStore.updateServerConfigField('acrcloudAccessSecret', v)}
                placeholder="Your ACRCloud access secret"
              />
            </FieldRow>
          </SettingsGroup>

          {/* Status hint */}
          <div class="px-3 py-2 bg-cyan/5 border border-cyan/20 rounded-sm">
            <p class="text-[9px] font-mono text-cyan uppercase tracking-wider mb-1">Recognition flow</p>
            <p class="text-[9px] font-mono text-text-dim leading-relaxed">
              When a client presses Identify, the server captures 12 s of PCM audio and tries AudD first.
              If AudD returns no match (or the key is empty) and ACRCloud credentials are set, it falls back
              to ACRCloud. Rate limiting: max 3 identifications per client per minute.
            </p>
          </div>

        </div>
      </Show>
    </div>
  );
};

// ---- Sub-components (scoped to this section) ----

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
    autocomplete="off"
    spellcheck={false}
    class="w-full px-3 py-1.5 bg-sdr-base border border-border rounded-sm
           text-xs font-mono text-text-primary placeholder-text-dim
           focus:outline-none focus:border-cyan transition-colors"
  />
);

// API keys shown as plain text with autocomplete off — no password masking,
// no browser credential popups.
const PasswordInput: Component<{ value: string; onChange: (v: string) => void; placeholder?: string }> = (props) => (
  <input
    type="text"
    value={props.value}
    onInput={(e) => props.onChange(e.currentTarget.value)}
    placeholder={props.placeholder}
    autocomplete="off"
    spellcheck={false}
    class="w-full px-3 py-1.5 bg-sdr-base border border-border rounded-sm
           text-xs font-mono text-text-primary placeholder-text-dim
           focus:outline-none focus:border-cyan transition-colors"
  />
);

const LoadingIndicator: Component = () => (
  <div class="flex items-center justify-center py-12">
    <div class="text-text-dim text-[10px] font-mono uppercase tracking-wider animate-pulse">
      Loading configuration...
    </div>
  </div>
);

export default IdentifySection;
