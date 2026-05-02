# Settings & Admin Panel Revamp

## Overview

Complete overhaul of the admin/configuration UX for container-first deployment. The server must boot gracefully with zero config, the admin panel becomes a full-page route (`/admin`), and the SDR client UI becomes fully WebSocket-driven (no REST polling for config state).

## Design Decisions

| Decision | Choice |
|----------|--------|
| Admin panel layout | Full-page route `/admin` |
| Feature report data source | Server API endpoint |
| Client monitoring | REST polling (5-10s) in admin only |
| Concurrent admin safety | Optimistic concurrency (ETag/version) |
| SDR client config delivery | WebSocket push only (no polling) |

---

## Architecture

### Admin Page Layout

```
┌─────────────────────────────────────────────────────────┐
│  /admin (full page, auth-gated)                         │
├──────────────┬──────────────────────────────────────────┤
│ Left Nav     │ Right Content                            │
│              │                                          │
│ ● General    │ [Breadcrumb: Admin > SDR Devices > RTL1] │
│ ● SDR        │                                          │
│   Devices    │ ┌─────────────────────────────────────┐  │
│ ● Bookmarks  │ │  Content area (forms/lists)         │  │
│ ● Features   │ │                                     │  │
│ ● System     │ │                                     │  │
│   Monitor    │ └─────────────────────────────────────┘  │
│              │                                          │
│              │ ┌─────────────────────────────────────┐  │
│              │ │ [● Unsaved changes]          [SAVE]  │  │
│              │ └─────────────────────────────────────┘  │
└──────────────┴──────────────────────────────────────────┘
```

### WebSocket META Protocol (Server → All Clients)

| META type | Trigger | Payload | Client action |
|-----------|---------|---------|---------------|
| `state_sync` | WS connect | Full dongle list + profiles + capabilities + bookmarks | Hydrate client store |
| `dongle_added` | Admin creates dongle | Full `DongleConfig` | Add to store |
| `dongle_removed` | Admin deletes dongle | `{dongleId}` | Remove. If subscribed → auto-switch or UNCONFIGURED |
| `dongle_updated` | Admin edits dongle HW | Full `DongleConfig` | Update. If subscribed → expect reinit |
| `dongle_started` | Dongle goes online | `{dongleId, status}` | Green LED |
| `dongle_stopped` | Dongle goes offline | `{dongleId, status}` | Red LED. If subscribed → NO_SIGNAL |
| `dongle_error` | Init retry failing | `{dongleId, status, retryCount, maxRetries}` | Show retry progress |
| `profiles_changed` | Profile CRUD/reorder | `{dongleId, profiles: [...]}` | Replace profiles in store |
| `profile_switched` | Active profile changed | Existing payload | Retune client |
| `bookmarks_changed` | Bookmark CRUD | `{bookmarks: [...]}` | Replace bookmarks |
| `server_config_changed` | Server settings changed | `{allowedFftCodecs, allowedIqCodecs, ...}` | Update capabilities |
| `codec_unavailable` | Codec removed from allowed | `{codec, fallbackCodec}` | Auto-switch, toast |

### Client States

```
CONNECTING    → WS handshake in progress
UNCONFIGURED  → Connected but no dongles exist
NO_SIGNAL     → Dongle exists but stopped/error/retrying
RECEIVING     → Normal operation
RECONNECTING  → WS dropped, attempting retry
```

### State Sync on Connect

```json
{
  "type": "state_sync",
  "dongles": [
    {
      "id": "rtl1",
      "name": "RTL-SDR #1",
      "enabled": true,
      "status": "running|stopped|error|retrying",
      "activeProfileId": "fm-band",
      "profiles": [...]
    }
  ],
  "bookmarks": [...],
  "capabilities": {
    "allowedFftCodecs": [...],
    "allowedIqCodecs": [...]
  },
  "serverVersion": "1.0.0"
}
```

---

## Backend Changes

### Phase 1 — Resilient Boot & Retry

- `Manager.Start()`: skip failing dongles (log error, continue) instead of fatal exit
- 5 retries with exponential backoff (1s, 2s, 4s, 8s, 16s) for auto-start dongles
- Server boots successfully with zero working dongles
- Same retry on runtime enable/disable

### Phase 2 — Config Versioning & Optimistic Concurrency

- `ConfigVersion uint64` in-memory (not persisted to YAML)
- Increment on every mutation
- All admin GET endpoints include `X-Config-Version` header
- `POST /api/admin/save-config` requires `If-Match: <version>` — returns 409 if stale

### Phase 3 — Real-time Config Push

- `state_sync` on WS connect (replaces REST polling)
- Broadcast META on all config mutations (dongle/profile CRUD)
- Full profile list sent on any profile change (not incremental)
- `dongle_started`/`dongle_stopped`/`dongle_error` for lifecycle
- `server_config_changed` for codec/settings changes
- `codec_unavailable` to clients using removed codecs

### Phase 4 — New API Endpoints

- `GET /api/admin/system-info` — build version, Go version, OS, codecs, sources, demodulators, CPU count
- `GET /api/admin/clients` — connected clients (IP, dongle, profile, frequency, codec, duration)
- Bookmarks CRUD: `GET/POST /api/admin/bookmarks`, `PUT/DELETE /api/admin/bookmarks/{id}`
- `GET /api/capabilities/full` — full feature report
- First-boot: write minimal config.yaml with defaults + default password when file missing

### Phase 5 — Dongle Lifecycle

- Enable/disable at runtime with 5-retry on re-enable
- Profile removal → notify clients → auto-switch to first profile
- Dongle hardware change → full restart → disconnect clients → reinit → clients auto-reconnect
- Dongle details change = reinitialise: all clients disconnected, renegotiate from scratch

---

## Frontend Changes

### Phase 6 — Admin Page Layout & Routing

- New route: `/admin` (full page, SolidJS router)
- Auth gate: login form if not authenticated (default password on first boot)
- Left sidebar navigation (sections)
- Right content pane with breadcrumb
- Footer: unsaved changes indicator + single SAVE button
- Remove old AdminModal.tsx

### Phase 7 — General Settings Section

- Station info: callsign, description, location
- Network: host, port (warn: requires restart)
- Security: admin password change
- Codecs: allowed FFT/IQ codec checkboxes
- Demo mode toggle

### Phase 8 — SDR Devices & Profiles Section

- Device list on right (cards, not dropdown)
- Breadcrumb navigation: `Admin > SDR Devices > [Name] > [Profile]`
- Click device → profiles shown as reorderable tabs
- Profile form:
  - Text inputs for frequencies (validate on blur, no spin buttons)
  - Show min/max frequency indicators based on sample rate
  - Min frequency + max frequency fields (in addition to center)
  - Dropdowns for mode/sample rate with manual override option
  - Preset dropdown to prefill from templates
- Add device → instant nav to config profiles
- Delete with confirmation

### Phase 9 — Bookmarks Section

- List: name, frequency (formatted), modulation, description
- Actions: edit, delete per row
- Add bookmark form
- Stored in config.yaml under `bookmarks:`

### Phase 10 — Feature Report Section

- Server: build version, Go version, compile date, OS/arch
- Client: Vite build hash, build date
- Codecs: list with availability status (compiled/not compiled)
- SDR sources: which are available (rtl_tcp, airspy, hfp, rsp, local, demo)
- Demodulators: FM, AM, SSB, CW, SAM, C-QUAM, WFM
- Data from `GET /api/capabilities/full`

### Phase 11 — System Monitor Section

- Active profiles table (dongle → profile → center freq → client count)
- Connected clients table (IP, profile, tuned freq, codec, connected duration)
- System: CPU usage, CPU temp (if available), network bandwidth out
- Polled every 5s via `GET /api/admin/clients` + `GET /api/admin/system-info`
- Pure read-only, no configuration changes here

### Phase 12 — Save UX & Concurrency

- Single "Save Configuration" button (footer, always visible)
- Dirty state tracking (deep compare current vs last-saved)
- Visual indicator: dot on save button, yellow highlight when dirty
- On save: include `If-Match: <version>` for optimistic concurrency
- On 409 Conflict: "Config changed by another admin" dialog with reload option
- On success: flash green, reset dirty state

---

## Client SDR UI Changes

### Phase 13 — Reactive State from WS Push

- Remove all REST calls for dongles/profiles/capabilities from SDR client
- `state_sync` on connect hydrates entire store
- All config mutations arrive via META messages → reactive SolidJS signals update
- Dongle list, profile list, bookmarks all derived from WS-pushed state
- No polling anywhere in SDR client

### Phase 14 — Connection Resilience & States

- **UNCONFIGURED state**: empty waterfall, "No SDR configured" message, prominent admin button
- **NO_SIGNAL state**: waterfall frozen with overlay, retry progress shown
- **RECONNECTING state**: exponential backoff (1s→30s max), auto-resubscribe on reconnect
- Recovery flows:
  - Dongle reinit → client waits → auto-resubscribe when `dongle_started` arrives
  - Profile removed → auto-switch to first profile (server-initiated)
  - Codec removed → auto-fallback + toast notification
  - New dongle added while UNCONFIGURED → auto-subscribe to first profile
  - WS reconnect → `state_sync` → reconcile → re-subscribe if needed

---

## Implementation Order

1. Phase 1 — Backend resilient boot + retry
2. Phase 3 — WS push system (`state_sync` + lifecycle META)
3. Phase 4 — New API endpoints (system-info, clients, bookmarks, capabilities)
4. Phase 2 — Config versioning
5. Phase 14 — Client connection resilience + states
6. Phase 13 — Client reactive store from WS
7. Phase 6 — Admin page layout/routing
8. Phase 7 + 8 — General Settings + SDR Devices
9. Phase 5 — Dongle lifecycle (retry on enable, cascade)
10. Phase 12 — Save UX + concurrency
11. Phase 9 + 10 + 11 — Bookmarks, Features, Monitor
