// ============================================================
// Decoders Section — background decoder config + stored history
// ============================================================

import { Component, For, Show, createEffect, createSignal, onMount } from 'solid-js';
import {
  adminStore,
  type DecoderConfig,
  type DecoderModeInfo,
} from '../admin-store';

function formatTimestamp(ms?: number | null): string {
  if (!ms || !Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString([], {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatFrequency(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return '—';
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(6)} MHz`;
  if (hz >= 1_000) return `${(hz / 1_000).toFixed(3)} kHz`;
  return `${hz.toFixed(0)} Hz`;
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

interface StoredMessage {
  id: number;
  decoderId: string;
  dongleId: string;
  mode: string;
  receivedMs: number;
  text: string;
  frequencyHz: number;
  snrDb: number;
}

const FieldLabel: Component<{ children: any }> = (props) => (
  <label class="text-[10px] font-mono uppercase tracking-wider text-text-dim">
    {props.children}
  </label>
);

const FrequencyField: Component<{
  value: number;
  onCommit: (hz: number) => void;
  disabled?: boolean;
}> = (props) => (
  <div class="flex items-center gap-1">
    <input
      type="text"
      class="admin-input w-32"
      value={(props.value / 1_000_000).toFixed(6)}
      disabled={props.disabled}
      onChange={(event) => {
        const mhz = Number.parseFloat(event.currentTarget.value);
        if (Number.isFinite(mhz) && mhz > 0) {
          props.onCommit(Math.round(mhz * 1_000_000));
        }
      }}
    />
    <span class="text-[9px] font-mono text-text-dim">MHz</span>
  </div>
);

const DecodersSection: Component = () => {
  const [recent, setRecent] = createSignal<StoredMessage[]>([]);
  const [recentLoading, setRecentLoading] = createSignal(false);
  const [purgeMode, setPurgeMode] = createSignal('');
  // Selection of the "Add decoder" mode picker. Kept in a signal: binding a
  // reactive expression straight to <select value> re-applies it on every
  // re-run (mode list refresh, adding() etc.) and snaps the operator's choice
  // back to the first entry.
  const [addMode, setAddMode] = createSignal('');
  const [purgeDays, setPurgeDays] = createSignal(7);
  const [purgeMessage, setPurgeMessage] = createSignal('');
  const [adding, setAdding] = createSignal(false);

  const modes = () => adminStore.decoderModes();
  const decoders = () => adminStore.decoders();
  const dongles = () => adminStore.dongles();
  const summary = () => adminStore.decoderSummary();
  const server = () => adminStore.serverConfig();

  const modeInfo = (mode: string): DecoderModeInfo | undefined =>
    modes().find((info) => info.mode === mode);

  const commonModes = () =>
    ['ft8', 'ft4', 'ft2', 'wspr', 'js8', 'adsb'].filter((mode) =>
      modes().some((info) => info.mode === mode),
    );

  // Keep the add-mode selection valid as the mode list arrives or refreshes;
  // default to the first common mode only when there is no usable selection.
  createEffect(() => {
    const list = modes();
    const current = addMode();
    if (current && list.some((info) => info.mode === current)) return;
    const preferred = commonModes()[0] ?? list[0]?.mode ?? '';
    if (preferred !== current) setAddMode(preferred);
  });

  async function loadRecent(): Promise<void> {
    setRecentLoading(true);
    try {
      const res = await fetch('/api/decoder/history?limit=40', {
        credentials: 'same-origin',
      });
      if (res.ok) {
        const data = await res.json();
        setRecent(Array.isArray(data.messages) ? data.messages : []);
      }
    } catch {
      // Leave the last good page visible.
    } finally {
      setRecentLoading(false);
    }
  }

  onMount(() => {
    adminStore.loadDecoders();
    loadRecent();
  });

  const newDecoder = (mode: DecoderModeInfo): Partial<DecoderConfig> => ({
    enabled: true,
    dongleId: dongles()[0]?.id ?? '',
    mode: mode.mode,
    frequencyHz: mode.defaultFrequencyHz,
    bandwidthHz: mode.defaultBandwidthHz,
    retentionDays: 0,
  });

  async function addDecoder(mode: DecoderModeInfo): Promise<void> {
    if (!mode || adding()) return;
    setAdding(true);
    setPurgeMessage('');
    await adminStore.createDecoder(newDecoder(mode));
    setAdding(false);
  }

  async function purge(body: { all?: boolean; mode?: string; olderThanDays?: number }) {
    const result = await adminStore.purgeDecoderHistory(body);
    if (result) {
      setPurgeMessage(
        `Removed ${result.messages} message${result.messages === 1 ? '' : 's'} and ${result.entities} entit${result.entities === 1 ? 'y' : 'ies'}.`,
      );
      loadRecent();
    }
  }

  return (
    <div class="max-w-5xl space-y-5">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h2 class="text-sm font-mono uppercase tracking-wider text-text-primary mb-0.5">
            Background Decoders
          </h2>
          <p class="text-[10px] font-mono text-text-dim max-w-2xl">
            Decode digital modes continuously, independently of connected
            listeners. Only message-producing modes are listed; continuous text
            modes such as RTTY and image modes stay foreground-only. Results are
            stored in SQLite and shared with the client decoder workspace.
          </p>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <button
            class="px-2 py-0.5 text-[10px] font-mono uppercase rounded border border-border/50 text-text-dim hover:text-text-primary hover:border-accent/50 transition-colors"
            onClick={() => adminStore.reloadDecoders()}
          >
            Apply
          </button>
          <button
            class="px-2 py-0.5 text-[10px] font-mono uppercase rounded border border-border/50 text-text-dim hover:text-text-primary hover:border-accent/50 transition-colors"
            onClick={() => adminStore.loadDecoders()}
          >
            Refresh
          </button>
        </div>
      </div>

      <Show when={adminStore.decodersError()}>
        <div class="p-3 border border-red-400/30 rounded-md bg-red-400/5">
          <span class="text-[10px] font-mono text-red-400">
            {adminStore.decodersError()}
          </span>
        </div>
      </Show>

      {/* Quick add */}
      <div class="p-3 border border-accent/25 rounded-md bg-sdr-base/40 space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-[10px] font-mono uppercase tracking-wider text-accent">
            Quick add
          </span>
          <span class="text-[9px] font-mono text-text-dim">
            {modes().length} background-capable modes
          </span>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <For each={commonModes()}>
            {(mode) => (
              <button
                class="px-2 py-0.5 text-[10px] font-mono uppercase rounded border border-accent/30 text-accent bg-accent/5 hover:bg-accent/15 transition-colors disabled:opacity-40"
                disabled={adding() || dongles().length === 0}
                onClick={() => {
                  const info = modeInfo(mode);
                  if (info) addDecoder(info);
                }}
                title={
                  dongles().length === 0
                    ? 'Configure a dongle first'
                    : modeInfo(mode)?.description
                }
              >
                + {modeInfo(mode)?.label ?? mode}
              </button>
            )}
          </For>
        </div>
        <Show when={dongles().length === 0}>
          <p class="text-[9px] font-mono text-amber">
            Add and enable a dongle before creating background decoders.
          </p>
        </Show>
      </div>

      {/* Configured decoders */}
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <h3 class="text-[10px] font-mono uppercase tracking-wider text-text-dim border-b border-border/30 pb-1 flex-1">
            Configured decoders
          </h3>
          <span class="text-[9px] font-mono text-text-dim ml-3">
            changes apply immediately
          </span>
        </div>

        <Show
          when={decoders().length > 0}
          fallback={
            <div class="p-4 border border-border/30 rounded-md bg-sdr-base/30 text-center">
              <p class="text-[10px] font-mono text-text-dim">
                No background decoders yet. Use a quick-add button or the form
                below.
              </p>
            </div>
          }
        >
          <For each={decoders()}>
            {(decoder) => {
              const info = () => modeInfo(decoder.mode);
              return (
                <div class="p-3 border border-border/30 rounded-md bg-sdr-base/50 space-y-2">
                  <div class="flex items-center gap-2 flex-wrap">
                    <label class="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={decoder.enabled}
                        onChange={(event) =>
                          adminStore.updateDecoder(decoder.id, {
                            enabled: event.currentTarget.checked,
                          })
                        }
                      />
                      <span class="text-[10px] font-mono uppercase tracking-wider text-text-secondary">
                        {decoder.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </label>
                    <span class="text-[11px] font-mono text-accent uppercase">
                      {info()?.label ?? decoder.mode}
                    </span>
                    <span class="text-[9px] font-mono text-text-dim">
                      {info()?.category ?? 'decoder'}
                    </span>
                    <span class="text-[9px] font-mono text-text-muted truncate">
                      {decoder.id}
                    </span>
                    <button
                      class="ml-auto px-2 py-0.5 text-[10px] font-mono uppercase rounded border border-red-400/30 text-red-400/70 hover:text-red-400 hover:border-red-400/60 transition-colors"
                      onClick={() => {
                        if (confirm(`Delete decoder ${decoder.id}?`)) {
                          adminStore.deleteDecoder(decoder.id);
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>

                  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
                    <div class="flex flex-col gap-1">
                      <FieldLabel>Dongle</FieldLabel>
                      <select
                        class="admin-input"
                        onChange={(event) =>
                          adminStore.updateDecoder(decoder.id, {
                            dongleId: event.currentTarget.value,
                          })
                        }
                      >
                        <For each={dongles()}>
                          {(dongle) => (
                            <option
                              value={dongle.id}
                              selected={dongle.id === decoder.dongleId}
                            >
                              {dongle.name || dongle.id}
                            </option>
                          )}
                        </For>
                      </select>
                    </div>

                    <div class="flex flex-col gap-1">
                      <FieldLabel>Frequency</FieldLabel>
                      <FrequencyField
                        value={decoder.frequencyHz}
                        onCommit={(hz) =>
                          adminStore.updateDecoder(decoder.id, { frequencyHz: hz })
                        }
                      />
                    </div>

                    <div class="flex flex-col gap-1">
                      <FieldLabel>Bandwidth (Hz)</FieldLabel>
                      <input
                        type="number"
                        class="admin-input"
                        min="100"
                        step="100"
                        value={decoder.bandwidthHz}
                        onChange={(event) => {
                          const bandwidth = Number.parseInt(
                            event.currentTarget.value,
                            10,
                          );
                          if (Number.isFinite(bandwidth) && bandwidth > 0) {
                            adminStore.updateDecoder(decoder.id, {
                              bandwidthHz: bandwidth,
                            });
                          }
                        }}
                      />
                    </div>

                    <div class="flex flex-col gap-1">
                      <FieldLabel>Mode</FieldLabel>
                      <select
                        class="admin-input"
                        onChange={(event) => {
                          const mode = event.currentTarget.value;
                          const next = modeInfo(mode);
                          adminStore.updateDecoder(decoder.id, {
                            mode,
                            ...(next
                              ? {
                                  bandwidthHz: next.defaultBandwidthHz,
                                  frequencyHz: next.defaultFrequencyHz,
                                }
                              : {}),
                          });
                        }}
                      >
                        {/* Keep the stored mode visible even when the catalog
                            does not list it (older config or mode not built). */}
                        <Show when={!modeInfo(decoder.mode)}>
                          <option value={decoder.mode} selected>
                            {decoder.mode.toUpperCase()} — unavailable
                          </option>
                        </Show>
                        <For each={modes()}>
                          {(mode) => (
                            <option
                              value={mode.mode}
                              selected={mode.mode === decoder.mode}
                            >
                              {mode.label}
                            </option>
                          )}
                        </For>
                      </select>
                    </div>

                    <div class="flex flex-col gap-1">
                      <FieldLabel>Keep (days)</FieldLabel>
                      <input
                        type="number"
                        class="admin-input"
                        min="0"
                        value={decoder.retentionDays ?? 0}
                        onChange={(event) => {
                          const days = Number.parseInt(
                            event.currentTarget.value,
                            10,
                          );
                          if (Number.isFinite(days) && days >= 0) {
                            adminStore.updateDecoder(decoder.id, {
                              retentionDays: days,
                            });
                          }
                        }}
                      />
                      <span class="text-[9px] font-mono text-text-muted">
                        0 = global
                      </span>
                    </div>
                  </div>
                </div>
              );
            }}
          </For>
        </Show>

        {/* Add form */}
        <div class="p-3 border border-border/30 rounded-md bg-sdr-surface/50 flex items-center gap-2 flex-wrap">
          <span class="text-[10px] font-mono uppercase tracking-wider text-text-dim">
            Add
          </span>
          <select
            class="admin-input w-44"
            id="decoder-add-mode"
            onChange={(event) => setAddMode(event.currentTarget.value)}
          >
            <For each={modes()}>
              {(mode) => (
                <option value={mode.mode} selected={mode.mode === addMode()}>
                  {mode.label} — {mode.category}
                </option>
              )}
            </For>
          </select>
          <button
            class="px-3 py-1 text-[10px] font-mono uppercase rounded border border-accent/40 text-accent hover:bg-accent hover:text-text-inverse transition-colors disabled:opacity-40"
            disabled={adding() || dongles().length === 0}
            onClick={() => {
              const info = modeInfo(addMode());
              if (info) addDecoder(info);
            }}
          >
            {adding() ? 'Adding…' : 'Add decoder'}
          </button>
          <span class="text-[9px] font-mono text-text-dim">
            Typical frequency and bandwidth are filled automatically.
          </span>
        </div>
      </div>

      {/* Database settings */}
      <div class="space-y-3">
        <h3 class="text-[10px] font-mono uppercase tracking-wider text-text-dim border-b border-border/30 pb-1">
          History storage
        </h3>

        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div class="flex flex-col gap-1">
            <FieldLabel>Retention (days)</FieldLabel>
            <input
              type="number"
              class="admin-input"
              min="0"
              value={server().retentionDays}
              onChange={(event) =>
                adminStore.updateServerConfigField(
                  'retentionDays',
                  Math.max(0, Number.parseInt(event.currentTarget.value, 10) || 0),
                )
              }
            />
            <span class="text-[9px] font-mono text-text-muted">0 = keep forever</span>
          </div>

          <div class="flex flex-col gap-1">
            <FieldLabel>Purge interval (minutes)</FieldLabel>
            <input
              type="number"
              class="admin-input"
              min="0"
              value={server().purgeIntervalMinutes}
              onChange={(event) =>
                adminStore.updateServerConfigField(
                  'purgeIntervalMinutes',
                  Math.max(0, Number.parseInt(event.currentTarget.value, 10) || 0),
                )
              }
            />
            <span class="text-[9px] font-mono text-text-muted">0 = manual purges only</span>
          </div>

          <div class="flex flex-col gap-1">
            <FieldLabel>Max messages</FieldLabel>
            <input
              type="number"
              class="admin-input"
              min="0"
              value={server().maxMessages}
              onChange={(event) =>
                adminStore.updateServerConfigField(
                  'maxMessages',
                  Math.max(0, Number.parseInt(event.currentTarget.value, 10) || 0),
                )
              }
            />
            <span class="text-[9px] font-mono text-text-muted">0 = unlimited</span>
          </div>

          <div class="flex flex-col gap-1">
            <FieldLabel>SQLite path</FieldLabel>
            <input
              type="text"
              class="admin-input"
              value={server().decoderPath}
              placeholder="decoders.sqlite"
              onChange={(event) =>
                adminStore.updateServerConfigField(
                  'decoderPath',
                  event.currentTarget.value.trim(),
                )
              }
            />
            <span class="text-[9px] font-mono text-text-muted">restart required</span>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2 p-3 border border-border/30 rounded-md bg-sdr-base/40">
          <button
            class="px-2 py-0.5 text-[10px] font-mono uppercase rounded border border-border/50 text-text-dim hover:text-text-primary hover:border-accent/50 transition-colors"
            onClick={() => purge({})}
          >
            Apply retention now
          </button>

          <span class="text-[10px] font-mono text-text-dim ml-2">Purge mode</span>
          <select
            class="admin-input w-32"
            value={purgeMode()}
            onChange={(event) => setPurgeMode(event.currentTarget.value)}
          >
            <option value="">All modes</option>
            <For each={summary()?.modes ?? []}>
              {(entry) => <option value={entry.mode}>{entry.mode.toUpperCase()}</option>}
            </For>
          </select>
          <button
            class="px-2 py-0.5 text-[10px] font-mono uppercase rounded border border-amber/40 text-amber hover:bg-amber/10 transition-colors"
            onClick={() => {
              if (!purgeMode()) {
                if (!confirm('Purge all stored decode history? This cannot be undone.')) {
                  return;
                }
                purge({ all: true });
                return;
              }
              purge({ mode: purgeMode() });
            }}
          >
            Purge selected
          </button>

          <span class="text-[10px] font-mono text-text-dim ml-2">Older than</span>
          <input
            type="number"
            class="admin-input w-20"
            min="1"
            value={purgeDays()}
            onChange={(event) =>
              setPurgeDays(Math.max(1, Number.parseInt(event.currentTarget.value, 10) || 1))
            }
          />
          <span class="text-[9px] font-mono text-text-dim">days</span>
          <button
            class="px-2 py-0.5 text-[10px] font-mono uppercase rounded border border-border/50 text-text-dim hover:text-text-primary transition-colors"
            onClick={() => purge({ olderThanDays: purgeDays() })}
          >
            Purge older
          </button>

          <Show when={purgeMessage()}>
            <span class="text-[9px] font-mono text-status-online ml-auto">
              {purgeMessage()}
            </span>
          </Show>
        </div>
      </div>

      {/* Storage stats */}
      <div class="space-y-3">
        <div class="flex items-center justify-between">
          <h3 class="text-[10px] font-mono uppercase tracking-wider text-text-dim border-b border-border/30 pb-1 flex-1">
            Storage summary
          </h3>
          <button
            class="ml-3 px-2 py-0.5 text-[10px] font-mono uppercase rounded border border-border/50 text-text-dim hover:text-text-primary transition-colors"
            onClick={() => adminStore.loadDecoders()}
          >
            Refresh
          </button>
        </div>

        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div class="border border-border/30 rounded-sm p-2">
            <div class="text-[9px] font-mono uppercase text-text-dim">Messages</div>
            <div class="text-sm font-mono text-text-primary">
              {summary()?.stats?.messages ?? summary()?.total ?? 0}
            </div>
          </div>
          <div class="border border-border/30 rounded-sm p-2">
            <div class="text-[9px] font-mono uppercase text-text-dim">Entities</div>
            <div class="text-sm font-mono text-text-primary">
              {summary()?.stats?.entities ?? 0}
            </div>
          </div>
          <div class="border border-border/30 rounded-sm p-2">
            <div class="text-[9px] font-mono uppercase text-text-dim">Database</div>
            <div class="text-sm font-mono text-text-primary">
              {formatBytes(summary()?.stats?.dbBytes)}
            </div>
          </div>
          <div class="border border-border/30 rounded-sm p-2">
            <div class="text-[9px] font-mono uppercase text-text-dim">Newest decode</div>
            <div class="text-[10px] font-mono text-text-primary">
              {formatTimestamp(summary()?.stats?.newestMs)}
            </div>
          </div>
        </div>

        <div class="overflow-x-auto border border-border/30 rounded-md">
          <table class="w-full text-[10px] font-mono">
            <thead class="bg-sdr-base/60 text-text-dim">
              <tr>
                <th class="text-left px-2 py-1">MODE</th>
                <th class="text-right px-2 py-1">DECODERS</th>
                <th class="text-right px-2 py-1">MESSAGES</th>
                <th class="text-left px-2 py-1">OLDEST</th>
                <th class="text-left px-2 py-1">NEWEST</th>
              </tr>
            </thead>
            <tbody>
              <For each={summary()?.modes ?? []}>
                {(entry) => (
                  <tr class="border-t border-border/20">
                    <td class="px-2 py-1 text-cyan uppercase">{entry.mode}</td>
                    <td class="px-2 py-1 text-right text-text-secondary">
                      {entry.decoders}
                    </td>
                    <td class="px-2 py-1 text-right text-text-primary">
                      {entry.count}
                    </td>
                    <td class="px-2 py-1 text-text-dim">
                      {formatTimestamp(entry.oldestMs)}
                    </td>
                    <td class="px-2 py-1 text-text-dim">
                      {formatTimestamp(entry.latestMs)}
                    </td>
                  </tr>
                )}
              </For>
              <Show when={(summary()?.modes ?? []).length === 0}>
                <tr>
                  <td colspan="5" class="px-2 py-3 text-center text-text-dim">
                    No stored decode history yet.
                  </td>
                </tr>
              </Show>
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent stored decodes */}
      <div class="space-y-3">
        <div class="flex items-center justify-between">
          <h3 class="text-[10px] font-mono uppercase tracking-wider text-text-dim border-b border-border/30 pb-1 flex-1">
            Recent stored decodes
          </h3>
          <button
            class="ml-3 px-2 py-0.5 text-[10px] font-mono uppercase rounded border border-border/50 text-text-dim hover:text-text-primary transition-colors"
            onClick={loadRecent}
          >
            {recentLoading() ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        <div class="overflow-x-auto border border-border/30 rounded-md max-h-80 overflow-y-auto">
          <table class="w-full text-[9px] font-mono">
            <thead class="sticky top-0 bg-sdr-surface text-text-dim">
              <tr>
                <th class="text-left px-2 py-1">TIME</th>
                <th class="text-left px-2 py-1">MODE</th>
                <th class="text-left px-2 py-1">DECODER</th>
                <th class="text-left px-2 py-1">MESSAGE</th>
                <th class="text-right px-2 py-1">RF</th>
                <th class="text-right px-2 py-1">SNR</th>
              </tr>
            </thead>
            <tbody>
              <For each={recent()}>
                {(message) => (
                  <tr class="border-t border-border/20">
                    <td class="px-2 py-0.5 text-text-dim whitespace-nowrap">
                      {formatTimestamp(message.receivedMs)}
                    </td>
                    <td class="px-2 py-0.5 text-cyan uppercase">{message.mode}</td>
                    <td class="px-2 py-0.5 text-text-muted truncate max-w-32">
                      {message.decoderId}
                    </td>
                    <td class="px-2 py-0.5 text-text-primary break-all">
                      {message.text}
                    </td>
                    <td class="px-2 py-0.5 text-right text-text-dim whitespace-nowrap">
                      {formatFrequency(message.frequencyHz)}
                    </td>
                    <td class="px-2 py-0.5 text-right text-text-dim">
                      {Math.round(message.snrDb)}
                    </td>
                  </tr>
                )}
              </For>
              <Show when={recent().length === 0}>
                <tr>
                  <td colspan="6" class="px-2 py-3 text-center text-text-dim">
                    No stored decodes yet.
                  </td>
                </tr>
              </Show>
            </tbody>
          </table>
        </div>
        <p class="text-[9px] font-mono text-text-muted">
          Decode history is also available per mode in the client Digital
          Decoders workspace via the History button.
        </p>
      </div>
    </div>
  );
};

export default DecodersSection;
