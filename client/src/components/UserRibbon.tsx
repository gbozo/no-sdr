// ============================================================
// node-sdr — Users tuning ribbon
// ============================================================
// A compact full-width frequency axis. Nearby listeners are grouped into a
// range band with a ×N marker; clicking the group lists every actual tuned
// frequency. The cyan stem marks the current tuned frequency and starts below
// the marker banners so it never strikes through a label.

import { Component, For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { engine } from '../engine/sdr-engine.js';
import { store } from '../store/index.js';
import type { UserLocation } from '~/shared';

interface UserGroup {
  key: string;
  x: number;
  minX: number;
  maxX: number;
  frequencyHz: number;
  minHz: number;
  maxHz: number;
  users: UserLocation[];
}

const fmtMHz = (hz: number, digits = 4) => `${(hz / 1e6).toFixed(digits)} MHz`;

const UserRibbon: Component = () => {
  let barRef: HTMLDivElement | undefined;
  const [barWidth, setBarWidth] = createSignal(0);
  const [openKey, setOpenKey] = createSignal<string | null>(null);

  const mode = () => store.pushServerConfig()?.usersRibbon ?? 'users';
  const enabled = () => mode() !== 'off';

  const users = createMemo(() =>
    store
      .userLocations()
      .filter((user) => !user.profileId || user.profileId === store.activeProfileId())
      .sort((a, b) => a.frequencyHz - b.frequencyHz),
  );

  const isSelf = (user: UserLocation) =>
    user.clientId === store.clientId() && user.connIndex === store.connIndex();

  const xPctHz = (hz: number): number => {
    const sampleRate = store.sampleRate();
    if (!sampleRate) return -100;
    const [zoomStart, zoomEnd] = store.spectrumZoom();
    const span = zoomEnd - zoomStart;
    if (span <= 0) return -100;
    const center = store.centerFrequency();
    const norm = (hz - (center - sampleRate / 2)) / sampleRate;
    return ((norm - zoomStart) / span) * 100;
  };

  const visibleUsers = createMemo(() => users().filter((user) => {
    const x = xPctHz(user.frequencyHz);
    return x >= -1 && x <= 101;
  }));

  const groups = createMemo<UserGroup[]>(() => {
    const width = barWidth();
    const threshold = width > 0 ? (64 / width) * 100 : 3;
    const result: UserGroup[] = [];
    for (const user of visibleUsers()) {
      const x = xPctHz(user.frequencyHz);
      const match = result.find((group) => Math.abs(group.x - x) <= threshold);
      if (match) {
        match.users.push(user);
        match.x = match.users.reduce((sum, item) => sum + xPctHz(item.frequencyHz), 0) / match.users.length;
        match.minX = Math.min(match.minX, x);
        match.maxX = Math.max(match.maxX, x);
        match.minHz = Math.min(match.minHz, user.frequencyHz);
        match.maxHz = Math.max(match.maxHz, user.frequencyHz);
        match.frequencyHz = (match.minHz + match.maxHz) / 2;
      } else {
        result.push({
          key: `${user.clientId}:${user.connIndex}`,
          x,
          minX: x,
          maxX: x,
          frequencyHz: user.frequencyHz,
          minHz: user.frequencyHz,
          maxHz: user.frequencyHz,
          users: [user],
        });
      }
    }
    return result.sort((a, b) => a.x - b.x);
  });

  const openGroup = createMemo(() => groups().find((group) => group.key === openKey()));

  const tunedX = () => xPctHz(store.tunedFrequency());
  const tunedVisible = () => tunedX() >= -1 && tunedX() <= 101;

  const userLabel = (user: UserLocation) => {
    const who = isSelf(user)
      ? 'YOU'
      : mode() === 'ip' && user.ip
        ? user.ip
        : 'USER';
    return `${who} · ${fmtMHz(user.frequencyHz)}`;
  };

  const groupLabel = (group: UserGroup) =>
    group.users.length === 1 ? userLabel(group.users[0]) : `×${group.users.length}`;

  const groupTitle = (group: UserGroup) => {
    if (group.users.length === 1) return userTitle(group.users[0]);
    return group.users
      .map((user) => userTitle(user).replace(' · click to tune', ''))
      .join('\n') + '\nclick for details';
  };

  const userTitle = (user: UserLocation) => {
    const parts = [
      fmtMHz(user.frequencyHz, 6),
      user.mode.toUpperCase(),
      `${(user.bandwidth / 1000).toFixed(1)} kHz`,
    ];
    if (isSelf(user)) parts.push('you');
    else if (mode() === 'ip' && user.ip) parts.push(user.ip);
    parts.push('click to tune');
    return parts.join(' · ');
  };

  const toggleGroup = (group: UserGroup) => {
    if (group.users.length === 1) {
      engine.tune(group.users[0].frequencyHz - store.centerFrequency());
      setOpenKey(null);
      return;
    }
    setOpenKey((current) => (current === group.key ? null : group.key));
  };

  const tuneTo = (user: UserLocation) => {
    engine.tune(user.frequencyHz - store.centerFrequency());
    setOpenKey(null);
  };

  onMount(() => {
    if (!barRef) return;
    const observer = new ResizeObserver((entries) => {
      setBarWidth(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(barRef);
    setBarWidth(barRef.clientWidth);
    onCleanup(() => observer.disconnect());
  });

  return (
    <Show when={enabled() && users().length > 0}>
      <div class={`relative z-20 px-2 ${openGroup() ? '' : '-mb-2'}`}>
        <Show
          when={store.usersRibbonVisible()}
          fallback={
            <button
              onClick={() => store.setUsersRibbonVisible(true)}
              class="text-[8px] font-mono uppercase tracking-wider text-text-dim hover:text-cyan leading-4"
              title="Show the users tuning ribbon"
            >
              Users {users().length} ▸
            </button>
          }
        >
          <div ref={barRef} class="relative w-full h-4">
            {/* Compact toggle, overlaid so the frequency axis uses the full width. */}
            <button
              onClick={() => store.setUsersRibbonVisible(false)}
              class="absolute left-0 top-0 z-30 h-3.5 px-1 bg-sdr-base/85 text-[7px] font-mono uppercase tracking-wider text-text-dim hover:text-cyan"
              title="Hide the users tuning ribbon"
            >
              Users {users().length} ▾
            </button>

            {/* Range band for clustered listeners. */}
            <For each={groups()}>
              {(group) => (
                <Show when={group.users.length > 1}>
                  <div
                    class="absolute bottom-0 h-1 rounded-sm bg-cyan/25 border border-cyan/30 pointer-events-none z-0"
                    style={{
                      left: `${Math.max(0, Math.min(100, group.minX))}%`,
                      width: `${Math.max(0.15, group.maxX - group.minX)}%`,
                      'min-width': '4px',
                    }}
                    title={groupTitle(group)}
                  />
                </Show>
              )}
            </For>

            {/* Tuned-frequency stem: starts below the banners, extends into the waterfall. */}
            <Show when={tunedVisible()}>
              <div
                class="absolute w-px bg-cyan/70 pointer-events-none z-0"
                style={{
                  left: `${Math.max(0, Math.min(100, tunedX()))}%`,
                  top: '14px',
                  height: 'calc(100% - 14px + 9px)',
                }}
                title={`Tuned ${fmtMHz(store.tunedFrequency(), 6)}`}
              >
                <div class="absolute left-1/2 -translate-x-1/2 -bottom-1 w-0 h-0 border-l-[3px] border-r-[3px] border-t-[4px] border-l-transparent border-r-transparent border-t-cyan" />
              </div>
            </Show>

            <For each={groups()}>
              {(group) => (
                <button
                  onClick={() => toggleGroup(group)}
                  class={`absolute top-0 -translate-x-1/2 h-3.5 px-1 rounded-sm border text-[7px] font-mono leading-[14px] whitespace-nowrap tabular-nums z-10 ${
                    group.users.some(isSelf)
                      ? 'border-cyan/70 bg-cyan/15 text-cyan'
                      : 'border-border/70 bg-sdr-surface/90 text-text-secondary hover:text-text-primary hover:border-cyan/50'
                  }`}
                  style={{ left: `${Math.max(0, Math.min(100, group.x))}%` }}
                  title={groupTitle(group)}
                >
                  {groupLabel(group)}
                </button>
              )}
            </For>
          </div>

          <Show when={openGroup()}>
            {(group) => (
              <div class="mt-1 border border-cyan/30 bg-sdr-surface/95 rounded-sm p-1.5 shadow-lg relative z-30">
                <div class="flex items-center gap-2 mb-1">
                  <span class="text-[8px] font-mono uppercase tracking-wider text-text-dim">
                    {group().users.length} users · {fmtMHz(group().minHz, 6)}
                    {group().minHz !== group().maxHz ? ` – ${fmtMHz(group().maxHz, 6)}` : ''}
                  </span>
                  <button
                    onClick={() => setOpenKey(null)}
                    class="ml-auto text-[9px] font-mono text-text-dim hover:text-amber px-1"
                    title="Close"
                  >
                    ✕
                  </button>
                </div>
                <div class="max-h-40 overflow-y-auto">
                  <For each={group().users}>
                    {(user) => (
                      <button
                        onClick={() => tuneTo(user)}
                        class="flex items-center gap-2 w-full text-left px-1 py-0.5 rounded-sm hover:bg-white/5"
                        title={userTitle(user)}
                      >
                        <span class={`text-[8px] font-mono tabular-nums w-24 truncate ${
                          isSelf(user) ? 'text-cyan' : 'text-text-secondary'
                        }`}>
                          {isSelf(user)
                            ? 'YOU'
                            : mode() === 'ip' && user.ip
                              ? user.ip
                              : 'USER'}
                        </span>
                        <span class="text-[8px] font-mono tabular-nums text-text-primary">
                          {fmtMHz(user.frequencyHz, 6)}
                        </span>
                        <span class="text-[8px] font-mono uppercase text-text-dim">
                          {user.mode}
                        </span>
                        <span class="ml-auto text-[7px] font-mono text-text-muted">Tune</span>
                      </button>
                    )}
                  </For>
                </div>
              </div>
            )}
          </Show>
        </Show>
      </div>
    </Show>
  );
};

export default UserRibbon;
