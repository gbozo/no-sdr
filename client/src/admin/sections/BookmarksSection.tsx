// ============================================================
// Bookmarks Section — Frequency bookmarks CRUD
// ============================================================

import { Component, createSignal, For, onMount, Show } from 'solid-js';
import { adminStore, Bookmark } from '../admin-store';
import { DEMOD_MODES, DECODER_MODE_IDS, DIGITAL_MODES } from '../../shared/modes';
import { formatFrequency } from '../../shared/modes';

type DemodMode = keyof typeof DEMOD_MODES;

/** Wideband modes need a wider bookmark filter than their decoder bandwidth. */
const DECODER_BOOKMARK_BW: Partial<Record<(typeof DECODER_MODE_IDS)[number], number>> = {
  adsb: 2_400_000,
  ism: 2_400_000,
};

/// Decoder modes a bookmark can restore. These are stored in the same `mode`
/// string as demod modes; the public bookmark API reports them implemented.
const DECODER_BOOKMARK_MODES = DECODER_MODE_IDS.map((id) => {
  const info = DIGITAL_MODES[id];
  return {
    id,
    label: `${info.name} — ${formatFrequency(info.typicalFrequency)}`,
    defaultBandwidth: DECODER_BOOKMARK_BW[id] ?? info.bandwidth,
  };
});

// ---- Helpers ----
function generateId(): string {
  return `bm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function emptyBookmark(): Bookmark {
  return { id: generateId(), name: '', frequency: 0, mode: 'nfm', bandwidth: 0, description: '' };
}

// ---- Sub-components ----

const FrequencyInput: Component<{
  value: number;
  onChange: (v: number) => void;
  label: string;
}> = (props) => {
  // Display in MHz for user convenience, store in Hz
  const [display, setDisplay] = createSignal(props.value ? (props.value / 1_000_000).toFixed(6) : '');

  return (
    <div class="flex flex-col gap-1">
      <label class="text-[10px] font-mono uppercase tracking-wider text-text-dim">{props.label}</label>
      <div class="flex items-center gap-1">
        <input
          type="text"
          class="admin-input flex-1"
          value={display()}
          onInput={(e) => {
            setDisplay(e.currentTarget.value);
            const mhz = parseFloat(e.currentTarget.value);
            if (!isNaN(mhz) && mhz > 0) {
              props.onChange(Math.round(mhz * 1_000_000));
            }
          }}
          placeholder="145.500000"
        />
        <span class="text-[10px] font-mono text-text-dim">MHz</span>
      </div>
    </div>
  );
};

// ---- Bookmark Row ----
const BookmarkRow: Component<{
  bookmark: Bookmark;
  onEdit: () => void;
  onDelete: () => void;
}> = (props) => {
  const modeInfo = () => DEMOD_MODES[props.bookmark.mode as DemodMode];
  return (
    <div class="flex items-center gap-3 p-2.5 border border-border/30 rounded-md bg-sdr-base/50 hover:bg-sdr-base/80 transition-colors group">
      {/* Frequency */}
      <div class="w-32 shrink-0">
        <span class="text-xs font-mono text-accent">{formatFrequency(props.bookmark.frequency)}</span>
      </div>

      {/* Name */}
      <div class="flex-1 min-w-0">
        <span class="text-[12px] font-mono text-text-primary truncate block">{props.bookmark.name}</span>
        <Show when={props.bookmark.description}>
          <span class="text-[10px] font-mono text-text-dim truncate block">{props.bookmark.description}</span>
        </Show>
      </div>

      {/* Mode badge */}
      <div class="w-12 shrink-0">
        <span class="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/20">
          {modeInfo()?.shortName || props.bookmark.mode}
        </span>
      </div>

      {/* Bandwidth */}
      <div class="w-16 shrink-0 text-right">
        <Show when={props.bookmark.bandwidth && props.bookmark.bandwidth > 0}>
          <span class="text-[10px] font-mono text-text-dim">
            {(props.bookmark.bandwidth! / 1000).toFixed(1)}k
          </span>
        </Show>
      </div>

      {/* Actions */}
      <div class="flex gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          class="px-2 py-0.5 text-[10px] font-mono uppercase rounded border border-border/50 text-text-dim hover:text-text-primary hover:border-accent/50 transition-colors"
          onClick={props.onEdit}
        >
          Edit
        </button>
        <button
          class="px-2 py-0.5 text-[10px] font-mono uppercase rounded border border-border/50 text-red-400/60 hover:text-red-400 hover:border-red-400/50 transition-colors"
          onClick={props.onDelete}
        >
          Del
        </button>
      </div>
    </div>
  );
};

// ---- Bookmark Form (Add/Edit) ----
const BookmarkForm: Component<{
  bookmark: Bookmark;
  isNew: boolean;
  onSave: (bm: Bookmark) => void;
  onCancel: () => void;
}> = (props) => {
  const [form, setForm] = createSignal<Bookmark>({ ...props.bookmark });

  const update = <K extends keyof Bookmark>(key: K, value: Bookmark[K]) => {
    setForm(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = () => {
    const bm = form();
    if (!bm.name.trim()) return;
    if (bm.frequency <= 0) return;
    props.onSave(bm);
  };

  return (
    <div class="p-3 border border-accent/30 rounded-md bg-sdr-surface/80 space-y-3">
      <div class="flex items-center gap-2 mb-2">
        <span class="text-[10px] font-mono uppercase tracking-wider text-accent">
          {props.isNew ? 'Add Bookmark' : 'Edit Bookmark'}
        </span>
      </div>

      {/* Row 1: Name + Frequency */}
      <div class="grid grid-cols-2 gap-3">
        <div class="flex flex-col gap-1">
          <label class="text-[10px] font-mono uppercase tracking-wider text-text-dim">Name</label>
          <input
            type="text"
            class="admin-input"
            value={form().name}
            onInput={(e) => update('name', e.currentTarget.value)}
            placeholder="Station name"
          />
        </div>
        <FrequencyInput
          value={form().frequency}
          onChange={(v) => update('frequency', v)}
          label="Frequency"
        />
      </div>

      {/* Row 2: Mode + Bandwidth */}
      <div class="grid grid-cols-2 gap-3">
        <div class="flex flex-col gap-1">
          <label class="text-[10px] font-mono uppercase tracking-wider text-text-dim">Mode</label>
          <select
            class="admin-input"
            value={form().mode}
            onChange={(e) => {
              const mode = e.currentTarget.value as DemodMode;
              update('mode', mode);
              // Auto-set default bandwidth for mode if not set
              const modeInfo =
                DEMOD_MODES[mode] ??
                DECODER_BOOKMARK_MODES.find((m) => m.id === e.currentTarget.value);
              if (modeInfo && (!form().bandwidth || form().bandwidth === 0)) {
                update('bandwidth', modeInfo.defaultBandwidth);
              }
            }}
          >
            <For each={Object.values(DEMOD_MODES)}>
              {(mode) => (
                <option value={mode.id}>{mode.shortName} — {mode.name}</option>
              )}
            </For>
            <optgroup label="Digital decoders">
              <For each={DECODER_BOOKMARK_MODES}>
                {(mode) => (
                  <option value={mode.id}>{mode.label}</option>
                )}
              </For>
            </optgroup>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-[10px] font-mono uppercase tracking-wider text-text-dim">Bandwidth (Hz)</label>
          <input
            type="number"
            class="admin-input"
            value={form().bandwidth || ''}
            onInput={(e) => update('bandwidth', parseInt(e.currentTarget.value) || 0)}
            placeholder={String(DEMOD_MODES[form().mode as DemodMode]?.defaultBandwidth || 12500)}
          />
        </div>
      </div>

      {/* Row 3: Description */}
      <div class="flex flex-col gap-1">
        <label class="text-[10px] font-mono uppercase tracking-wider text-text-dim">Description</label>
        <input
          type="text"
          class="admin-input"
          value={form().description || ''}
          onInput={(e) => update('description', e.currentTarget.value)}
          placeholder="Optional notes"
        />
      </div>

      {/* Actions */}
      <div class="flex gap-2 pt-1">
        <button
          class="mil-btn text-[10px] px-3 py-1"
          onClick={handleSave}
          disabled={!form().name.trim() || form().frequency <= 0}
        >
          {props.isNew ? 'Add' : 'Save'}
        </button>
        <button
          class="px-3 py-1 text-[10px] font-mono uppercase rounded border border-border/50 text-text-dim hover:text-text-primary transition-colors"
          onClick={props.onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
};

// ---- Region / Country Selection ----
const RegionPanel: Component = () => {
  const cfg = () => adminStore.serverConfig();
  const selected = () => cfg().bookmarkRegions;
  const allIds = () => adminStore.bookmarkRegionOptions().map((r) => r.id);

  const isChecked = (id: string) => {
    const sel = selected();
    return sel === null || sel.includes(id);
  };

  const toggle = (id: string) => {
    const base = selected() ?? allIds();
    const next = base.includes(id) ? base.filter((r) => r !== id) : [...base, id];
    adminStore.updateServerConfigField('bookmarkRegions', next);
  };

  const selectedCount = () => {
    const sel = selected();
    return sel === null ? adminStore.bookmarkRegionOptions().length : sel.length;
  };

  return (
    <div class="mb-5 p-3 border border-border/30 rounded-md bg-sdr-surface/40">
      <div class="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 class="text-[10px] font-mono uppercase tracking-wider text-accent">Regions &amp; Countries</h3>
          <p class="text-[10px] font-mono text-text-dim mt-1 leading-relaxed">
            Choose which bookmark folders are served to clients. Shared bookmark files in
            the bookmarks root are controlled by the "Shared / global" entry.
          </p>
        </div>
        <div class="flex gap-1 shrink-0">
          <button
            class="px-2 py-0.5 text-[10px] font-mono uppercase rounded border border-border/50 text-text-dim hover:text-text-primary hover:border-accent/50 transition-colors"
            onClick={() => adminStore.updateServerConfigField('bookmarkRegions', null)}
            title="Serve every region (including folders added later)"
          >
            All
          </button>
          <button
            class="px-2 py-0.5 text-[10px] font-mono uppercase rounded border border-border/50 text-text-dim hover:text-text-primary hover:border-accent/50 transition-colors"
            onClick={() => adminStore.updateServerConfigField('bookmarkRegions', [])}
            title="Serve no bookmark files (config bookmarks only)"
          >
            None
          </button>
        </div>
      </div>

      <Show when={adminStore.bookmarkRegionsLoading()}>
        <div class="text-[10px] font-mono text-text-dim uppercase animate-pulse py-2">
          Scanning bookmark folders...
        </div>
      </Show>

      <Show when={!adminStore.bookmarkRegionsLoading() && adminStore.bookmarkRegionOptions().length === 0}>
        <div class="text-[10px] font-mono text-text-dim py-2">
          No bookmark folders found in the bookmarks directory.
        </div>
      </Show>

      <Show when={!adminStore.bookmarkRegionsLoading() && adminStore.bookmarkRegionOptions().length > 0}>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          <For each={adminStore.bookmarkRegionOptions()}>
            {(region) => (
              <label class="flex items-center gap-2 px-2 py-1.5 rounded border border-border/30 bg-sdr-base/40 hover:bg-sdr-base/70 cursor-pointer transition-colors">
                <input
                  type="checkbox"
                  class="accent-cyan"
                  checked={isChecked(region.id)}
                  onChange={() => toggle(region.id)}
                />
                <span class="flex-1 min-w-0">
                  <span class="text-[11px] font-mono text-text-primary truncate block">{region.label}</span>
                  <span class="text-[9px] font-mono text-text-dim/70 uppercase">
                    {region.id} · {region.bookmarks} bookmark{region.bookmarks !== 1 ? 's' : ''}
                  </span>
                </span>
              </label>
            )}
          </For>
        </div>
        <div class="mt-2 text-[9px] font-mono text-text-dim/60 uppercase text-right">
          {selectedCount()} of {adminStore.bookmarkRegionOptions().length} groups served
          {selected() === null ? ' (all, including future folders)' : ''}
        </div>
      </Show>

      {/* Band plan region */}
      <div class="mt-4 pt-3 border-t border-border/30 flex flex-col sm:flex-row sm:items-center gap-2">
        <div class="flex-1">
          <label class="text-[10px] font-mono uppercase tracking-wider text-text-dim">Band plan region</label>
          <p class="text-[9px] font-mono text-text-dim/60 mt-0.5">
            Default band overlay served to clients by /api/bandplan.
          </p>
        </div>
        <select
          class="admin-input sm:w-64"
          value={cfg().bandplanRegion}
          onChange={(e) => adminStore.updateServerConfigField('bandplanRegion', e.currentTarget.value)}
        >
          <option value="">Worldwide (default)</option>
          <option value="r1">ITU Region 1 — Europe, Africa, Middle East</option>
          <option value="r2">ITU Region 2 — Americas</option>
          <option value="r3">ITU Region 3 — Asia-Pacific</option>
        </select>
      </div>
    </div>
  );
};

// ---- Read-only decoder calling-frequency catalogue ----
const DecoderCatalogPanel: Component = () => {
  const cfg = () => adminStore.serverConfig();
  const catalog = () => adminStore.decoderCatalog();

  onMount(() => {
    if (!adminStore.decoderCatalog()) adminStore.loadDecoderCatalog();
  });

  const lastUpdated = () => {
    const value = catalog()?.lastUpdated;
    if (!value) return 'embedded snapshot';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  };

  const modeTitle = (mode: {
    name: string;
    mode: string;
    frequencies: { label: string; hz: number }[];
  }) =>
    mode.frequencies
      .map((f) => `${f.label} ${(f.hz / 1e6).toFixed(4)} MHz`)
      .join(' · ');

  return (
    <div class="mb-5 p-3 border border-border/30 rounded-md bg-sdr-surface/40">
      <div class="flex items-start justify-between gap-3 mb-3">
        <div>
          <div class="flex items-center gap-2">
            <h3 class="text-[10px] font-mono uppercase tracking-wider text-accent">
              Decoder Calling Frequencies
            </h3>
            <span class="text-[8px] font-mono uppercase tracking-wider text-amber border border-amber/30 rounded px-1">
              Read-only
            </span>
          </div>
          <p class="text-[10px] font-mono text-text-dim mt-1 leading-relaxed">
            Server-owned catalogue used by the decoder hints, quick-tune links and
            bookmark ribbon. Entries cannot be edited or deleted here.
          </p>
        </div>
        <button
          class="px-2 py-0.5 text-[10px] font-mono uppercase rounded border border-border/50 text-text-dim hover:text-text-primary hover:border-accent/50 transition-colors disabled:opacity-40"
          disabled={adminStore.decoderCatalogRefreshing()}
          onClick={() => adminStore.refreshDecoderCatalog()}
          title="Fetch the configured upstream catalogue now"
        >
          {adminStore.decoderCatalogRefreshing() ? 'Refreshing…' : 'Refresh now'}
        </button>
      </div>

      <label class="flex items-center gap-2 px-2 py-1.5 mb-2 rounded border border-border/30 bg-sdr-base/40 cursor-pointer">
        <input
          type="checkbox"
          class="accent-cyan"
          checked={cfg().decoderBookmarksEnabled}
          onChange={(e) =>
            adminStore.updateServerConfigField('decoderBookmarksEnabled', e.currentTarget.checked)
          }
        />
        <span class="text-[10px] font-mono text-text-primary">
          Show decoder calling frequencies in the public bookmark feed and spectrum ribbon
        </span>
      </label>

      <div class="grid grid-cols-1 sm:grid-cols-[1fr_120px] gap-2 mb-2">
        <div class="flex flex-col gap-1">
          <label class="text-[9px] font-mono uppercase tracking-wider text-text-dim">
            Upstream catalogue URL
          </label>
          <input
            type="text"
            class="admin-input text-[10px]"
            value={cfg().decoderCatalogUrl}
            onChange={(e) =>
              adminStore.updateServerConfigField('decoderCatalogUrl', e.currentTarget.value)
            }
            placeholder="https://…/decoder-catalog.json"
          />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-[9px] font-mono uppercase tracking-wider text-text-dim">
            Refresh hours
          </label>
          <input
            type="number"
            min="1"
            class="admin-input text-[10px]"
            value={cfg().decoderCatalogRefreshHours}
            onChange={(e) =>
              adminStore.updateServerConfigField(
                'decoderCatalogRefreshHours',
                Math.max(1, parseInt(e.currentTarget.value) || 1),
              )
            }
          />
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] font-mono text-text-dim mb-2">
        <span>
          Revision <span class="text-text-secondary">{catalog()?.revision ?? '—'}</span>
        </span>
        <span>
          Modes <span class="text-text-secondary">{catalog()?.modeCount ?? 0}</span>
        </span>
        <span>
          Frequencies <span class="text-text-secondary">{catalog()?.frequencyCount ?? 0}</span>
        </span>
        <span>
          Updated <span class="text-text-secondary">{lastUpdated()}</span>
        </span>
      </div>

      <Show when={catalog()?.lastError}>
        <div class="mb-2 px-2 py-1 text-[9px] font-mono text-red-400 border border-red-400/30 bg-red-400/5 rounded-sm">
          Last refresh failed: {catalog()!.lastError}
        </div>
      </Show>

      <Show
        when={(catalog()?.modes.length ?? 0) > 0}
        fallback={
          <div class="text-[10px] font-mono text-text-dim uppercase animate-pulse py-2">
            {adminStore.decoderCatalogLoading() ? 'Loading catalogue…' : 'Catalogue unavailable'}
          </div>
        }
      >
        <div class="max-h-40 overflow-auto grid grid-cols-1 sm:grid-cols-2 gap-1">
          <For each={catalog()!.modes}>
            {(mode) => (
              <div
                class="border border-border/30 rounded-sm bg-sdr-base/40 px-2 py-1 min-w-0"
                title={modeTitle(mode)}
              >
                <div class="flex items-center justify-between gap-2">
                  <span class="text-[10px] font-mono uppercase tracking-wider text-text-primary truncate">
                    {mode.name || mode.mode.toUpperCase()}
                  </span>
                  <span class="text-[9px] font-mono text-cyan tabular-nums shrink-0">
                    {mode.frequencies.length}
                  </span>
                </div>
                <div class="text-[9px] font-mono text-text-dim/70 truncate">
                  {mode.frequencies.map((f) => f.label).join(' · ')}
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

// ---- Main Section ----
const BookmarksSection: Component = () => {
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [adding, setAdding] = createSignal(false);

  onMount(() => {
    if (adminStore.bookmarkRegionOptions().length === 0) adminStore.loadBookmarkRegions();
  });

  const handleAdd = async (bm: Bookmark) => {
    const ok = await adminStore.createBookmark(bm);
    if (ok) setAdding(false);
  };

  const handleUpdate = async (bm: Bookmark) => {
    const ok = await adminStore.updateBookmark(bm.id, bm);
    if (ok) setEditingId(null);
  };

  const handleDelete = async (id: string) => {
    await adminStore.deleteBookmark(id);
  };

  return (
    <div class="max-w-3xl">
      <div class="flex items-center justify-between mb-4">
        <div>
          <h2 class="text-sm font-mono uppercase tracking-wider text-text-primary mb-0.5">Bookmarks</h2>
          <p class="text-[10px] font-mono text-text-dim">
            Frequency bookmarks — quick access to saved stations
          </p>
        </div>
        <Show when={!adding()}>
          <button
            class="mil-btn text-[10px] px-3 py-1"
            onClick={() => setAdding(true)}
          >
            + Add Bookmark
          </button>
        </Show>
      </div>

      <RegionPanel />

      <DecoderCatalogPanel />

      {/* Add Form */}
      <Show when={adding()}>
        <div class="mb-4">
          <BookmarkForm
            bookmark={emptyBookmark()}
            isNew={true}
            onSave={handleAdd}
            onCancel={() => setAdding(false)}
          />
        </div>
      </Show>

      {/* Loading state */}
      <Show when={adminStore.bookmarksLoading()}>
        <div class="flex items-center justify-center h-24">
          <span class="text-[10px] font-mono text-text-dim uppercase animate-pulse">Loading bookmarks...</span>
        </div>
      </Show>

      {/* Empty state */}
      <Show when={!adminStore.bookmarksLoading() && adminStore.bookmarks().length === 0}>
        <div class="flex flex-col items-center justify-center h-32 border border-border/30 rounded-md bg-sdr-base/30">
          <svg class="w-6 h-6 text-text-dim/30 mb-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
          </svg>
          <span class="text-[10px] font-mono text-text-dim uppercase">No bookmarks configured</span>
          <span class="text-[10px] font-mono text-text-dim/60 mt-0.5">Click "Add Bookmark" to save a frequency</span>
        </div>
      </Show>

      {/* Bookmark List */}
      <Show when={!adminStore.bookmarksLoading() && adminStore.bookmarks().length > 0}>
        <div class="space-y-1.5">
          {/* Header row */}
          <div class="flex items-center gap-3 px-2.5 py-1 text-[9px] font-mono uppercase tracking-wider text-text-dim/60">
            <div class="w-32 shrink-0">Frequency</div>
            <div class="flex-1">Name</div>
            <div class="w-12 shrink-0">Mode</div>
            <div class="w-16 shrink-0 text-right">BW</div>
            <div class="w-[88px] shrink-0"></div>
          </div>

          <For each={adminStore.bookmarks()}>
            {(bm) => (
              <Show
                when={editingId() === bm.id}
                fallback={
                  <BookmarkRow
                    bookmark={bm}
                    onEdit={() => setEditingId(bm.id)}
                    onDelete={() => handleDelete(bm.id)}
                  />
                }
              >
                <BookmarkForm
                  bookmark={bm}
                  isNew={false}
                  onSave={handleUpdate}
                  onCancel={() => setEditingId(null)}
                />
              </Show>
            )}
          </For>
        </div>
      </Show>

      {/* Count */}
      <Show when={adminStore.bookmarks().length > 0}>
        <div class="mt-3 text-[9px] font-mono text-text-dim/50 uppercase text-right">
          {adminStore.bookmarks().length} bookmark{adminStore.bookmarks().length !== 1 ? 's' : ''}
        </div>
      </Show>
    </div>
  );
};

export default BookmarksSection;
