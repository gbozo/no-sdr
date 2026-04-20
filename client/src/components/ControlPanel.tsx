// ============================================================
// node-sdr — Control Panel (Sidebar)
// ============================================================

import { Component, For, Show, createSignal, createResource, onMount } from 'solid-js';
import { store } from '../store/index.js';
import { engine } from '../engine/sdr-engine.js';
import { DEMOD_MODES } from '@node-sdr/shared';
import type { DemodMode, DongleInfo, DongleProfile, WaterfallColorTheme } from '@node-sdr/shared';
import { getPaletteNames } from '../engine/palettes.js';

const ControlPanel: Component = () => {
  return (
    <div class="flex flex-col gap-3 p-3 overflow-y-auto h-full">
      {/* Mode Selector */}
      <ModeSelector />

      {/* Audio Controls */}
      <AudioControls />

      {/* Bandwidth Control */}
      <BandwidthControl />

      {/* Waterfall Settings */}
      <WaterfallSettings />

      {/* S-Meter */}
      <SMeter />

      {/* Connection Status */}
      <ConnectionStatus />

      {/* Dongle Selector */}
      <DongleSelector />

      {/* Admin Panel */}
      <AdminPanel />
    </div>
  );
};

// ---- Mode Selector ----
const ModeSelector: Component = () => {
  const modes: DemodMode[] = ['wfm', 'nfm', 'am', 'usb', 'lsb', 'cw', 'raw'];

  return (
    <div class="sdr-panel">
      <div class="sdr-panel-header">Demodulation</div>
      <div class="p-2">
        <div class="flex flex-wrap gap-1">
          <For each={modes}>
            {(mode) => (
              <button
                class={`sdr-mode-btn ${store.mode() === mode ? 'active' : ''}`}
                onClick={() => engine.setMode(mode)}
              >
                {DEMOD_MODES[mode].shortName}
              </button>
            )}
          </For>
        </div>
        <div class="mt-2 text-[9px] text-text-dim font-mono">
          {DEMOD_MODES[store.mode()]?.description ?? ''}
        </div>
      </div>
    </div>
  );
};

// ---- Audio Controls ----
const AudioControls: Component = () => {
  return (
    <div class="sdr-panel">
      <div class="sdr-panel-header">Audio</div>
      <div class="p-3 space-y-3">
        {/* Volume */}
        <div>
          <div class="flex justify-between items-center mb-1">
            <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider">
              Volume
            </label>
            <span class="text-[9px] font-mono text-text-dim">
              {Math.round(store.volume() * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(store.volume() * 100)}
            onInput={(e) => engine.setVolume(parseInt(e.currentTarget.value) / 100)}
            class="sdr-range"
          />
        </div>

        {/* Mute button */}
        <button
          class={`sdr-btn w-full ${store.muted() ? 'sdr-btn-primary' : 'sdr-btn-ghost'}`}
          onClick={() => engine.setMuted(!store.muted())}
        >
          {store.muted() ? 'Unmute' : 'Mute'}
        </button>

        {/* Squelch */}
        <div>
          <div class="flex justify-between items-center mb-1">
            <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider">
              Squelch
            </label>
            <span class="text-[9px] font-mono text-text-dim">
              {store.squelch() !== null ? `${store.squelch()} dB` : 'Off'}
            </span>
          </div>
          <input
            type="range"
            min={-150}
            max={0}
            value={store.squelch() ?? -150}
            onInput={(e) => {
              const val = parseInt(e.currentTarget.value);
              engine.setSquelch(val <= -150 ? null : val);
            }}
            class="sdr-range"
          />
        </div>
      </div>
    </div>
  );
};

// ---- Bandwidth Control ----
const BandwidthControl: Component = () => {
  const modeInfo = () => DEMOD_MODES[store.mode()];

  return (
    <div class="sdr-panel">
      <div class="sdr-panel-header">Bandwidth</div>
      <div class="p-3">
        <div class="flex justify-between items-center mb-1">
          <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider">
            Filter BW
          </label>
          <span class="text-[9px] font-mono text-text-dim">
            {(store.bandwidth() / 1000).toFixed(1)} kHz
          </span>
        </div>
        <input
          type="range"
          min={modeInfo()?.bandwidthRange[0] ?? 100}
          max={modeInfo()?.bandwidthRange[1] ?? 200000}
          step={100}
          value={store.bandwidth()}
          onInput={(e) => engine.setBandwidth(parseInt(e.currentTarget.value))}
          class="sdr-range"
        />
      </div>
    </div>
  );
};

// ---- Waterfall Settings ----
const WaterfallSettings: Component = () => {
  const themes = getPaletteNames();

  return (
    <div class="sdr-panel">
      <div class="sdr-panel-header">Waterfall</div>
      <div class="p-3 space-y-3">
        {/* Color Theme */}
        <div>
          <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider mb-1 block">
            Color Theme
          </label>
          <div class="flex flex-wrap gap-1">
            <For each={themes}>
              {(theme) => (
                <button
                  class={`sdr-mode-btn text-[8px] ${store.waterfallTheme() === theme ? 'active' : ''}`}
                  onClick={() => engine.setWaterfallTheme(theme)}
                >
                  {theme}
                </button>
              )}
            </For>
          </div>
        </div>

        {/* Min dB */}
        <div>
          <div class="flex justify-between items-center mb-1">
            <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider">
              Min Level
            </label>
            <span class="text-[9px] font-mono text-text-dim">{store.waterfallMin()} dB</span>
          </div>
          <input
            type="range"
            min={-160}
            max={-20}
            value={store.waterfallMin()}
            onInput={(e) => engine.setWaterfallRange(parseInt(e.currentTarget.value), store.waterfallMax())}
            class="sdr-range"
          />
        </div>

        {/* Max dB */}
        <div>
          <div class="flex justify-between items-center mb-1">
            <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider">
              Max Level
            </label>
            <span class="text-[9px] font-mono text-text-dim">{store.waterfallMax()} dB</span>
          </div>
          <input
            type="range"
            min={-100}
            max={0}
            value={store.waterfallMax()}
            onInput={(e) => engine.setWaterfallRange(store.waterfallMin(), parseInt(e.currentTarget.value))}
            class="sdr-range"
          />
        </div>
      </div>
    </div>
  );
};

// ---- S-Meter ----
const SMeter: Component = () => {
  const pct = () => {
    const level = store.signalLevel();
    // Map -120 to -20 dB range to 0-100%
    return Math.max(0, Math.min(100, ((level + 120) / 100) * 100));
  };

  const barColor = () => {
    const p = pct();
    if (p > 85) return 'bg-neon-red';
    if (p > 65) return 'bg-neon-orange';
    if (p > 40) return 'bg-amber';
    return 'bg-green';
  };

  return (
    <div class="sdr-panel">
      <div class="sdr-panel-header">Signal</div>
      <div class="p-3">
        <div class="flex justify-between text-[9px] text-text-dim font-mono mb-1">
          <span>S-Meter</span>
          <span class="text-text-secondary">{store.signalLevel().toFixed(0)} dB</span>
        </div>
        <div class="h-2.5 bg-sdr-base rounded-sm border border-border overflow-hidden relative">
          <div class="absolute inset-0 flex">
            <For each={Array(9).fill(0)}>
              {() => <div class="flex-1 border-r border-border/30" />}
            </For>
          </div>
          <div
            class={`h-full rounded-sm transition-[width] duration-100 ease-linear
                    ${barColor()} shadow-[0_0_8px_currentColor]`}
            style={{ width: `${pct()}%` }}
          />
        </div>
        <div class="flex justify-between text-[7px] text-text-muted font-mono mt-0.5">
          <span>S1</span><span>3</span><span>5</span><span>7</span><span>9</span>
          <span>+20</span><span>+40</span><span>+60</span>
        </div>
      </div>
    </div>
  );
};

// ---- Connection Status ----
const ConnectionStatus: Component = () => {
  return (
    <div class="sdr-panel">
      <div class="sdr-panel-header">Status</div>
      <div class="p-3 space-y-1 text-[9px] font-mono">
        <div class="flex justify-between">
          <span class="text-text-secondary">Connection</span>
          <span class={store.connected() ? 'text-status-online' : 'text-status-error'}>
            {store.connected() ? 'Connected' : 'Disconnected'}
          </span>
        </div>
        <div class="flex justify-between">
          <span class="text-text-secondary">Client ID</span>
          <span class="text-text-dim">{store.clientId() || '—'}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-text-secondary">Sample Rate</span>
          <span class="text-text-dim">{(store.sampleRate() / 1e6).toFixed(2)} MSPS</span>
        </div>
        <div class="flex justify-between">
          <span class="text-text-secondary">FFT Size</span>
          <span class="text-text-dim">{store.fftSize()}</span>
        </div>
      </div>
    </div>
  );
};

// ---- Dongle Selector ----
const DongleSelector: Component = () => {
  return (
    <Show when={store.dongles().length > 0}>
      <div class="sdr-panel">
        <div class="sdr-panel-header">Receivers</div>
        <div class="p-2">
          <For each={store.dongles()}>
            {(dongle) => (
              <button
                class={`w-full text-left p-2 rounded-sm text-[10px] font-mono
                        transition-colors duration-100
                        ${store.activeDongleId() === dongle.id
                          ? 'bg-cyan-dim text-cyan'
                          : 'text-text-secondary hover:bg-sdr-hover'}`}
                onClick={() => engine.subscribe(dongle.id)}
              >
                <div class="flex items-center gap-2">
                  <div class={`w-1.5 h-1.5 rounded-full ${dongle.running ? 'bg-status-online' : 'bg-status-offline'}`} />
                  <span>{dongle.name}</span>
                </div>
                <Show when={dongle.activeProfileId}>
                  <div class="text-text-dim ml-3.5 mt-0.5">
                    Profile: {dongle.activeProfileId}
                  </div>
                </Show>
              </button>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
};

// ---- Admin Panel ----
const AdminPanel: Component = () => {
  const [password, setPassword] = createSignal('');
  const [error, setError] = createSignal('');
  const [profiles, setProfiles] = createSignal<DongleProfile[]>([]);
  const [loading, setLoading] = createSignal(false);

  const apiBase = () => {
    // In dev, proxy handles this. In prod, same origin.
    return '';
  };

  const authHeaders = () => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${password()}`,
  });

  const handleLogin = async () => {
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`${apiBase()}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password() }),
      });
      if (res.ok) {
        store.setIsAdmin(true);
        // Also authenticate via WebSocket
        engine.adminAuth(password());
      } else {
        const data = await res.json();
        setError(data.error || 'Authentication failed');
      }
    } catch {
      setError('Connection failed');
    }
    setLoading(false);
  };

  const handleLogout = () => {
    store.setIsAdmin(false);
    setPassword('');
    setProfiles([]);
  };

  const loadProfiles = async (dongleId: string) => {
    try {
      const res = await fetch(`${apiBase()}/api/dongles/${dongleId}/profiles`);
      if (res.ok) {
        const data = await res.json();
        setProfiles(data);
      }
    } catch {
      // ignore
    }
  };

  const handleSwitchProfile = async (dongleId: string, profileId: string) => {
    setLoading(true);
    try {
      await fetch(`${apiBase()}/api/admin/dongles/${dongleId}/profile`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ profileId }),
      });
    } catch {
      setError('Failed to switch profile');
    }
    setLoading(false);
  };

  const handleStartDongle = async (dongleId: string) => {
    setLoading(true);
    try {
      await fetch(`${apiBase()}/api/admin/dongles/${dongleId}/start`, {
        method: 'POST',
        headers: authHeaders(),
      });
      // Refresh dongle list
      engine.fetchDongles();
    } catch {
      setError('Failed to start dongle');
    }
    setLoading(false);
  };

  const handleStopDongle = async (dongleId: string) => {
    setLoading(true);
    try {
      await fetch(`${apiBase()}/api/admin/dongles/${dongleId}/stop`, {
        method: 'POST',
        headers: authHeaders(),
      });
      engine.fetchDongles();
    } catch {
      setError('Failed to stop dongle');
    }
    setLoading(false);
  };

  return (
    <div class="sdr-panel">
      <div class="sdr-panel-header">Admin</div>
      <div class="p-3">
        <Show
          when={store.isAdmin()}
          fallback={
            <div class="space-y-2">
              <input
                type="password"
                placeholder="Admin password"
                value={password()}
                onInput={(e) => setPassword(e.currentTarget.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                class="w-full bg-sdr-base border border-border rounded-sm px-2 py-1.5
                       text-[10px] font-mono text-text-primary placeholder:text-text-muted
                       focus:border-border-focus focus:outline-none"
              />
              <button
                class="sdr-btn sdr-btn-primary w-full"
                onClick={handleLogin}
                disabled={loading() || !password()}
              >
                {loading() ? 'Authenticating...' : 'Login'}
              </button>
              <Show when={error()}>
                <div class="text-[9px] font-mono text-status-error">{error()}</div>
              </Show>
            </div>
          }
        >
          {/* Admin Controls */}
          <div class="space-y-3">
            <div class="flex justify-between items-center">
              <span class="text-[9px] font-mono text-amber uppercase tracking-wider font-bold">
                Admin Mode
              </span>
              <button
                class="text-[8px] font-mono text-text-dim hover:text-text-secondary"
                onClick={handleLogout}
              >
                Logout
              </button>
            </div>

            {/* Dongle Management */}
            <For each={store.dongles()}>
              {(dongle) => (
                <div class="bg-sdr-base border border-border rounded-sm p-2 space-y-2">
                  <div class="flex items-center justify-between">
                    <div class="flex items-center gap-1.5">
                      <div class={`w-1.5 h-1.5 rounded-full ${dongle.running ? 'bg-status-online' : 'bg-status-offline'}`} />
                      <span class="text-[10px] font-mono text-text-primary">{dongle.name}</span>
                    </div>
                    <span class="text-[8px] font-mono text-text-dim">
                      {dongle.clientCount} user{dongle.clientCount !== 1 ? 's' : ''}
                    </span>
                  </div>

                  <div class="flex gap-1">
                    <Show when={dongle.running}>
                      <button
                        class="sdr-btn flex-1 text-[8px] bg-status-error/20 text-status-error hover:bg-status-error/30"
                        onClick={() => handleStopDongle(dongle.id)}
                        disabled={loading()}
                      >
                        Stop
                      </button>
                    </Show>
                    <Show when={!dongle.running}>
                      <button
                        class="sdr-btn flex-1 text-[8px] bg-status-online/20 text-status-online hover:bg-status-online/30"
                        onClick={() => handleStartDongle(dongle.id)}
                        disabled={loading()}
                      >
                        Start
                      </button>
                    </Show>
                    <button
                      class="sdr-btn flex-1 text-[8px]"
                      onClick={() => loadProfiles(dongle.id)}
                    >
                      Profiles
                    </button>
                  </div>

                  {/* Profile list (shown when loaded) */}
                  <Show when={profiles().length > 0}>
                    <div class="space-y-0.5">
                      <div class="text-[8px] font-mono text-text-dim uppercase tracking-wider mb-1">
                        Switch Profile:
                      </div>
                      <For each={profiles()}>
                        {(profile) => (
                          <button
                            class={`w-full text-left px-2 py-1 rounded-sm text-[9px] font-mono
                                    transition-colors duration-100
                                    ${dongle.activeProfileId === profile.id
                                      ? 'bg-cyan-dim text-cyan'
                                      : 'text-text-secondary hover:bg-sdr-hover'}`}
                            onClick={() => handleSwitchProfile(dongle.id, profile.id)}
                            disabled={loading()}
                          >
                            <div>{profile.name}</div>
                            <div class="text-[7px] text-text-dim">
                              {(profile.centerFrequency / 1e6).toFixed(3)} MHz — {profile.defaultMode.toUpperCase()}
                            </div>
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              )}
            </For>

            <Show when={error()}>
              <div class="text-[9px] font-mono text-status-error">{error()}</div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default ControlPanel;
