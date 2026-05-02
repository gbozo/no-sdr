// ============================================================
// Bookmarks Section — Frequency bookmarks CRUD
// ============================================================

import { Component, createSignal, For, Show } from 'solid-js';
import { adminStore, Bookmark } from '../admin-store';
import { DEMOD_MODES } from '../../shared/modes';
import { formatFrequency } from '../../shared/modes';

type DemodMode = keyof typeof DEMOD_MODES;

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
      <label class="text-[9px] font-mono uppercase tracking-wider text-text-dim">{props.label}</label>
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
        <span class="text-[9px] font-mono text-text-dim">MHz</span>
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
        <span class="text-[11px] font-mono text-text-primary truncate block">{props.bookmark.name}</span>
        <Show when={props.bookmark.description}>
          <span class="text-[9px] font-mono text-text-dim truncate block">{props.bookmark.description}</span>
        </Show>
      </div>

      {/* Mode badge */}
      <div class="w-12 shrink-0">
        <span class="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/20">
          {modeInfo()?.shortName || props.bookmark.mode}
        </span>
      </div>

      {/* Bandwidth */}
      <div class="w-16 shrink-0 text-right">
        <Show when={props.bookmark.bandwidth && props.bookmark.bandwidth > 0}>
          <span class="text-[9px] font-mono text-text-dim">
            {(props.bookmark.bandwidth! / 1000).toFixed(1)}k
          </span>
        </Show>
      </div>

      {/* Actions */}
      <div class="flex gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          class="px-2 py-0.5 text-[9px] font-mono uppercase rounded border border-border/50 text-text-dim hover:text-text-primary hover:border-accent/50 transition-colors"
          onClick={props.onEdit}
        >
          Edit
        </button>
        <button
          class="px-2 py-0.5 text-[9px] font-mono uppercase rounded border border-border/50 text-red-400/60 hover:text-red-400 hover:border-red-400/50 transition-colors"
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
        <span class="text-[9px] font-mono uppercase tracking-wider text-accent">
          {props.isNew ? 'Add Bookmark' : 'Edit Bookmark'}
        </span>
      </div>

      {/* Row 1: Name + Frequency */}
      <div class="grid grid-cols-2 gap-3">
        <div class="flex flex-col gap-1">
          <label class="text-[9px] font-mono uppercase tracking-wider text-text-dim">Name</label>
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
          <label class="text-[9px] font-mono uppercase tracking-wider text-text-dim">Mode</label>
          <select
            class="admin-input"
            value={form().mode}
            onChange={(e) => {
              const mode = e.currentTarget.value as DemodMode;
              update('mode', mode);
              // Auto-set default bandwidth for mode if not set
              const modeInfo = DEMOD_MODES[mode];
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
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-[9px] font-mono uppercase tracking-wider text-text-dim">Bandwidth (Hz)</label>
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
        <label class="text-[9px] font-mono uppercase tracking-wider text-text-dim">Description</label>
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
          class="mil-btn text-[9px] px-3 py-1"
          onClick={handleSave}
          disabled={!form().name.trim() || form().frequency <= 0}
        >
          {props.isNew ? 'Add' : 'Save'}
        </button>
        <button
          class="px-3 py-1 text-[9px] font-mono uppercase rounded border border-border/50 text-text-dim hover:text-text-primary transition-colors"
          onClick={props.onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
};

// ---- Main Section ----
const BookmarksSection: Component = () => {
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [adding, setAdding] = createSignal(false);

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
          <p class="text-[9px] font-mono text-text-dim">
            Frequency bookmarks — quick access to saved stations
          </p>
        </div>
        <Show when={!adding()}>
          <button
            class="mil-btn text-[9px] px-3 py-1"
            onClick={() => setAdding(true)}
          >
            + Add Bookmark
          </button>
        </Show>
      </div>

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
          <span class="text-[9px] font-mono text-text-dim uppercase animate-pulse">Loading bookmarks...</span>
        </div>
      </Show>

      {/* Empty state */}
      <Show when={!adminStore.bookmarksLoading() && adminStore.bookmarks().length === 0}>
        <div class="flex flex-col items-center justify-center h-32 border border-border/30 rounded-md bg-sdr-base/30">
          <svg class="w-6 h-6 text-text-dim/30 mb-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
          </svg>
          <span class="text-[9px] font-mono text-text-dim uppercase">No bookmarks configured</span>
          <span class="text-[9px] font-mono text-text-dim/60 mt-0.5">Click "Add Bookmark" to save a frequency</span>
        </div>
      </Show>

      {/* Bookmark List */}
      <Show when={!adminStore.bookmarksLoading() && adminStore.bookmarks().length > 0}>
        <div class="space-y-1.5">
          {/* Header row */}
          <div class="flex items-center gap-3 px-2.5 py-1 text-[8px] font-mono uppercase tracking-wider text-text-dim/60">
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
        <div class="mt-3 text-[8px] font-mono text-text-dim/50 uppercase text-right">
          {adminStore.bookmarks().length} bookmark{adminStore.bookmarks().length !== 1 ? 's' : ''}
        </div>
      </Show>
    </div>
  );
};

export default BookmarksSection;
