# Tasks — Settings Revamp

## Phase 1: Backend Resilient Boot & Retry

- [ ] Modify `Manager.Start()` to skip failing dongles instead of returning fatal error
- [ ] Add retry loop (5 attempts, exponential backoff 1s/2s/4s/8s/16s) for auto-start dongles
- [ ] Add retry on runtime `StartDongleByID()` (same 5-attempt logic)
- [ ] Ensure server boots cleanly with zero dongles (already works, verify)
- [ ] Write minimal default config.yaml on first boot when file missing
- [ ] Add dongle status tracking: `running`, `stopped`, `error`, `retrying`
- [ ] Test: server with no config file → boots, serves HTTP, WS connectable
- [ ] Test: server with broken dongle config → skips, logs, continues

## Phase 2: Config Versioning & Optimistic Concurrency

- [ ] Add `configVersion uint64` to config manager (in-memory, atomic)
- [ ] Increment version on every config mutation (dongle/profile/server CRUD)
- [ ] Include `X-Config-Version` header in admin GET responses
- [ ] `POST /api/admin/save-config` checks `If-Match` header, returns 409 if stale
- [ ] Test: concurrent save from two sessions → second gets 409

## Phase 3: Real-time Config Push (WebSocket META)

- [ ] Implement `state_sync` META message sent on WS connect
- [ ] Add `dongle_added` broadcast on dongle creation
- [ ] Add `dongle_removed` broadcast on dongle deletion
- [ ] Add `dongle_updated` broadcast on dongle hardware edit
- [ ] Add `dongle_started` / `dongle_stopped` / `dongle_error` lifecycle broadcasts
- [ ] Add `profiles_changed` broadcast (full profile list per dongle)
- [ ] Add `bookmarks_changed` broadcast
- [ ] Add `server_config_changed` broadcast
- [ ] Add `codec_unavailable` targeted message to affected clients
- [ ] Remove REST-based config fetching from SDR client (dongles, profiles, capabilities)

## Phase 4: New API Endpoints

- [ ] `GET /api/admin/system-info` — build version, Go ver, OS, CPU count, uptime, available codecs/sources/demods
- [ ] `GET /api/admin/clients` — list connected WS clients (IP, dongle, profile, freq, codec, duration)
- [ ] `GET /api/admin/bookmarks` — list all bookmarks
- [ ] `POST /api/admin/bookmarks` — create bookmark
- [ ] `PUT /api/admin/bookmarks/{id}` — update bookmark
- [ ] `DELETE /api/admin/bookmarks/{id}` — delete bookmark
- [ ] `GET /api/capabilities/full` — full feature report (public, no auth)
- [ ] Add `bookmarks` section to config struct + YAML persistence

## Phase 5: Dongle Lifecycle

- [ ] Enable/disable at runtime with 5-retry on re-enable
- [ ] Profile removal → send `profiles_changed` + `profile_switched` to affected clients
- [ ] Dongle hardware change → full restart → disconnect subscribers → reinit → notify
- [ ] Auto-switch clients to first profile when their active profile is deleted
- [ ] Auto-fallback codec when codec removed from allowed list

## Phase 6: Admin Page — Layout & Routing

- [ ] Add SolidJS router (if not present) or simple hash-based routing
- [ ] Create `/admin` route component (AdminPage.tsx)
- [ ] Left sidebar with section navigation
- [ ] Right content pane with breadcrumb header
- [ ] Footer with single SAVE button
- [ ] Auth gate (login form, cookie-based session)
- [ ] Remove or deprecate old AdminModal.tsx

## Phase 7: General Settings Section

- [ ] Station info form (callsign, description, location)
- [ ] Network form (host, port — with restart warning)
- [ ] Security form (admin password)
- [ ] Codec checkboxes (allowed FFT + IQ codecs)
- [ ] Demo mode toggle

## Phase 8: SDR Devices & Profiles Section

- [ ] Device list (cards on right panel)
- [ ] Breadcrumb navigation
- [ ] Add device button → instant nav to new device config
- [ ] Profile tabs (reorderable via drag or arrows)
- [ ] Preset dropdown for profile templates
- [ ] Profile form: text input frequencies (no spinners), validate on blur
- [ ] Min/max frequency fields + indicator based on sample rate
- [ ] Dropdowns for mode/sample rate with manual override
- [ ] Delete device/profile with confirmation

## Phase 9: Bookmarks Section

- [ ] Bookmark list (name, freq, mode, description)
- [ ] Add bookmark form
- [ ] Edit/delete actions per row
- [ ] Validation (frequency format, required fields)

## Phase 10: Feature Report Section

- [ ] Display server build info from `GET /api/capabilities/full`
- [ ] Display client build info (injected at build time via Vite)
- [ ] Codec availability grid
- [ ] SDR source support list
- [ ] Demodulator list

## Phase 11: System Monitor Section

- [ ] Active profiles table (dongle, profile, freq, client count)
- [ ] Connected clients table (IP, profile, freq, codec, duration)
- [ ] System metrics (CPU, temp if available, bandwidth)
- [ ] Auto-refresh every 5s from admin REST endpoints

## Phase 12: Save UX & Concurrency

- [ ] Dirty state tracking (deep compare form state vs saved state)
- [ ] Visual indicator on save button when dirty
- [ ] Include `If-Match` version header on save
- [ ] Handle 409 Conflict (dialog: "Config changed by another admin")
- [ ] Success flash + reset dirty state

## Phase 13: Client SDR UI — Reactive WS State

- [ ] Remove REST calls for dongles/profiles/capabilities from SDR client
- [ ] Handle `state_sync` → hydrate store signals
- [ ] Handle `dongle_added/removed/updated` → update dongle list reactively
- [ ] Handle `profiles_changed` → update profile list
- [ ] Handle `bookmarks_changed` → update bookmarks
- [ ] Handle `server_config_changed` → update capabilities
- [ ] Handle `codec_unavailable` → auto-switch + toast

## Phase 14: Client Connection Resilience

- [ ] Define client states: CONNECTING, UNCONFIGURED, NO_SIGNAL, RECEIVING, RECONNECTING
- [ ] UNCONFIGURED state UI (no dongles: empty waterfall, admin prompt)
- [ ] NO_SIGNAL state UI (dongle stopped: frozen waterfall, overlay message)
- [ ] RECONNECTING state (exponential backoff 1s→30s, auto-resubscribe)
- [ ] Recovery: dongle reinit → wait → auto-resubscribe on `dongle_started`
- [ ] Recovery: profile removed → accept server's auto-switch
- [ ] Recovery: new dongle while UNCONFIGURED → auto-subscribe
- [ ] Recovery: WS reconnect → `state_sync` → reconcile → re-subscribe
