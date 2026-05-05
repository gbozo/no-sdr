package api

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gbozo/no-sdr/serverng/internal/config"
	"github.com/gbozo/no-sdr/serverng/internal/ws"
	"gopkg.in/yaml.v3"
	"os"
)

// AdminAuth manages cookie-based admin sessions.
type AdminAuth struct {
	password   string
	secret     string // per-boot random secret for cookie signing
	sessions   map[string]time.Time
	mu         sync.RWMutex
	cookieName string
	maxAge     time.Duration
}

// NewAdminAuth creates a new AdminAuth with per-boot random secret.
func NewAdminAuth(password string) *AdminAuth {
	secret := make([]byte, 32)
	rand.Read(secret)
	return &AdminAuth{
		password:   password,
		secret:     hex.EncodeToString(secret),
		sessions:   make(map[string]time.Time),
		cookieName: "sdr_session",
		maxAge:     7 * 24 * time.Hour,
	}
}

// Login validates password and sets httpOnly session cookie.
func (a *AdminAuth) Login(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if subtle.ConstantTimeCompare([]byte(body.Password), []byte(a.password)) != 1 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid password"})
		return
	}

	// Generate session token
	tokenBytes := make([]byte, 32)
	rand.Read(tokenBytes)
	token := hex.EncodeToString(tokenBytes)

	a.mu.Lock()
	a.sessions[token] = time.Now().Add(a.maxAge)
	a.mu.Unlock()

	http.SetCookie(w, &http.Cookie{
		Name:     a.cookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   int(a.maxAge.Seconds()),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// Logout clears the session cookie.
func (a *AdminAuth) Logout(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(a.cookieName)
	if err == nil {
		a.mu.Lock()
		delete(a.sessions, cookie.Value)
		a.mu.Unlock()
	}

	http.SetCookie(w, &http.Cookie{
		Name:     a.cookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// CheckAuth middleware validates session cookie OR Bearer token (password).
func (a *AdminAuth) CheckAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Try cookie first
		cookie, err := r.Cookie(a.cookieName)
		if err == nil {
			a.mu.RLock()
			expiry, ok := a.sessions[cookie.Value]
			a.mu.RUnlock()

			if ok && time.Now().Before(expiry) {
				next.ServeHTTP(w, r)
				return
			}
			if ok {
				a.mu.Lock()
				delete(a.sessions, cookie.Value)
				a.mu.Unlock()
			}
		}

		// Fall back to Authorization: Bearer <password>
		auth := r.Header.Get("Authorization")
		if strings.HasPrefix(auth, "Bearer ") {
			token := strings.TrimPrefix(auth, "Bearer ")
			if subtle.ConstantTimeCompare([]byte(token), []byte(a.password)) == 1 {
				next.ServeHTTP(w, r)
				return
			}
		}

		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "not authenticated"})
	})
}

// IsAuthenticated checks if the current request has valid session (for GET /api/admin/check).
func (a *AdminAuth) IsAuthenticated(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(a.cookieName)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "authenticated": false})
		return
	}

	a.mu.RLock()
	expiry, ok := a.sessions[cookie.Value]
	a.mu.RUnlock()

	if !ok || time.Now().After(expiry) {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "authenticated": false})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "authenticated": true})
}

// --- Admin dongle handlers ---

// adminDongleResponse is the admin version with hardware details.
type adminDongleResponse struct {
	ID             string                `json:"id"`
	Name           string                `json:"name"`
	Running        bool                  `json:"running"`
	Enabled        bool                  `json:"enabled"`
	AutoStart      bool                  `json:"autoStart"`
	ActiveProfileId string               `json:"activeProfileId"`
	ClientCount    int                   `json:"clientCount"`
	Source         config.SourceConfig   `json:"source"`
	SampleRate     int                   `json:"sampleRate"`
	Gain           float64               `json:"gain"`
	PPM            int                   `json:"ppmCorrection"`
	DeviceIndex    int                   `json:"deviceIndex"`
	DirectSampling int                   `json:"directSampling"`
	BiasT          bool                  `json:"biasT"`
	DigitalAgc     bool                  `json:"digitalAgc"`
	OffsetTuning   bool                  `json:"offsetTuning"`
	Profiles       []adminProfileResponse `json:"profiles"`
}

type adminProfileResponse struct {
	ID                   string  `json:"id"`
	Name                 string  `json:"name"`
	CenterFrequency      int64   `json:"centerFrequency"`
	SampleRate           int     `json:"sampleRate"`
	Bandwidth            int     `json:"bandwidth"`
	Mode                 string  `json:"mode"`
	Gain                 float64 `json:"gain"`
	FftSize              int     `json:"fftSize"`
	FftFps               int     `json:"fftFps"`
	TuneOffset           int     `json:"tuneOffset"`
	TuningStep           int     `json:"tuningStep"`
	SwapIQ               bool    `json:"swapIQ"`
	OscillatorOffset     int     `json:"oscillatorOffset"`
	DirectSampling       int     `json:"directSampling"`
	Description          string  `json:"description"`
	PreFilterNb          bool    `json:"preFilterNb"`
	PreFilterNbThreshold int     `json:"preFilterNbThreshold"`
}

// adminDonglesHandler returns all dongles with full hardware details.
func adminDonglesHandler(cfg *config.Config, wsMgr *ws.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var resp []adminDongleResponse
		for _, d := range cfg.Dongles {
			dr := adminDongleResponse{
				ID:             d.ID,
				Name:           d.Name,
				Running:        d.Enabled && d.AutoStart,
				Enabled:        d.Enabled,
				AutoStart:      d.AutoStart,
				Source:         d.Source,
				SampleRate:     d.SampleRate,
				Gain:           d.Gain,
				PPM:            d.PPM,
				DeviceIndex:    d.DeviceIndex,
				DirectSampling: d.DirectSampling,
				BiasT:          d.BiasT,
				DigitalAgc:     d.DigitalAgc,
				OffsetTuning:   d.OffsetTuning,
			}
			if len(d.Profiles) > 0 {
				dr.ActiveProfileId = d.Profiles[0].ID
			}
			dr.ClientCount = len(wsMgr.SubscribedClients(d.ID))
			for _, p := range d.Profiles {
				dr.Profiles = append(dr.Profiles, adminProfileResponse{
					ID:                   p.ID,
					Name:                 p.Name,
					CenterFrequency:      p.CenterFrequency,
					SampleRate:           p.SampleRate,
					Bandwidth:            p.Bandwidth,
					Mode:                 p.Mode,
					Gain:                 p.Gain,
					FftSize:              p.FftSize,
					FftFps:               p.FftFps,
					TuneOffset:           p.TuneOffset,
					TuningStep:           p.TuningStep,
					SwapIQ:               p.SwapIQ,
					OscillatorOffset:     p.OscillatorOffset,
					DirectSampling:       p.DirectSampling,
					Description:          p.Description,
					PreFilterNb:          p.PreFilterNb,
					PreFilterNbThreshold: p.PreFilterNbThreshold,
				})
			}
			resp = append(resp, dr)
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// createDongleHandler adds a new dongle to the config.
func createDongleHandler(cfg *config.Config, ver *config.ConfigVersion) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var d config.DongleConfig
		if err := json.NewDecoder(r.Body).Decode(&d); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
			return
		}
		if d.ID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "dongle id is required"})
			return
		}
		// Check for duplicate ID
		for _, existing := range cfg.Dongles {
			if existing.ID == d.ID {
				writeJSON(w, http.StatusConflict, map[string]string{"error": "dongle with this id already exists"})
				return
			}
		}
		cfg.Dongles = append(cfg.Dongles, d)

		// Bump config version
		newVer := bumpVersion(ver)

		// Notify all clients
		if NotifyDongleAddedFunc != nil {
			NotifyDongleAddedFunc(&cfg.Dongles[len(cfg.Dongles)-1])
		}

		setVersionHeader(w, newVer)
		writeJSON(w, http.StatusCreated, d)
	}
}

// updateDongleHandler updates an existing dongle.
func updateDongleHandler(cfg *config.Config, ver *config.ConfigVersion) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var updated config.DongleConfig
		if err := json.NewDecoder(r.Body).Decode(&updated); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
			return
		}

		for i, d := range cfg.Dongles {
			if d.ID == id {
				updated.ID = id // Ensure ID cannot be changed
				// Preserve existing profiles if the PUT body didn't include any
				// (the edit form only sends dongle-level fields, not profiles).
				if len(updated.Profiles) == 0 {
					updated.Profiles = d.Profiles
				}

				// Detect if hardware config changed (requires reinit)
				oldCfg := cfg.Dongles[i]
				cfg.Dongles[i] = updated

				// Bump config version
				newVer := bumpVersion(ver)

				// Notify all clients
				if NotifyDongleUpdatedFunc != nil {
					NotifyDongleUpdatedFunc(&cfg.Dongles[i])
				}

				// If hardware changed, reinit the dongle (stop + restart)
				if DongleReinitFunc != nil && needsReinit(&oldCfg, &updated) {
					go func() {
						if err := DongleReinitFunc(id); err != nil {
							// Log but don't fail the HTTP response
							_ = err
						}
					}()
				}

				setVersionHeader(w, newVer)
				writeJSON(w, http.StatusOK, updated)
				return
			}
		}
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "dongle not found"})
	}
}

// deleteDongleHandler removes a dongle from the config.
func deleteDongleHandler(cfg *config.Config, ver *config.ConfigVersion) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		for i, d := range cfg.Dongles {
			if d.ID == id {
				cfg.Dongles = append(cfg.Dongles[:i], cfg.Dongles[i+1:]...)

				// Stop the dongle if it's running
				if DongleStopFunc != nil {
					_ = DongleStopFunc(id) // Ignore "not running" error
				}

				// Bump config version
				newVer := bumpVersion(ver)

				// Notify all clients
				if NotifyDongleRemovedFunc != nil {
					NotifyDongleRemovedFunc(id)
				}

				setVersionHeader(w, newVer)
				writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
				return
			}
		}
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "dongle not found"})
	}
}

// ProfileSwitchFunc is called when admin switches a dongle profile via REST.
// Set by dongle.Manager after creation.
var ProfileSwitchFunc func(dongleID, profileID string) error

// DongleStartFunc starts a dongle. Set by dongle.Manager.
var DongleStartFunc func(dongleID string) error

// DongleStopFunc stops a dongle. Set by dongle.Manager.
var DongleStopFunc func(dongleID string) error

// DongleReinitFunc reinitialises a dongle (stop + start with retry).
// Called when hardware config changes. Set by dongle.Manager.
var DongleReinitFunc func(dongleID string) error

// HandleProfileRemovedFunc cascades profile removal to running dongles.
// If the active profile is removed, switches to next or stops.
var HandleProfileRemovedFunc func(dongleID, profileID string)

// EnumerateLocalDevicesFunc returns info about locally-attached RTL-SDR USB devices.
// Set by main.go; nil when rtlsdr support is not compiled in.
var EnumerateLocalDevicesFunc func() []any

// RecordStartFunc starts an IQ recording for a dongle. Set by main.go.
var RecordStartFunc func(dongleID string, centerFreq int64, sampleRate int) error

// RecordStopFunc stops an IQ recording and returns the output path. Set by main.go.
var RecordStopFunc func(dongleID string) (string, error)

// RecordStatusFunc returns active recordings. Set by main.go.
var RecordStatusFunc func() any

// SetAllowedCodecsFunc updates the WS manager's allowed codec sets at runtime.
// Set by main.go so the admin handler can propagate changes without a restart.
var SetAllowedCodecsFunc func(fft, iq []string)

// --- Notification callbacks (wired by main.go to dongle.Manager) ---

// NotifyDongleAddedFunc is called after a dongle is added to config.
var NotifyDongleAddedFunc func(dcfg *config.DongleConfig)

// NotifyDongleUpdatedFunc is called after a dongle config is modified.
var NotifyDongleUpdatedFunc func(dcfg *config.DongleConfig)

// NotifyDongleRemovedFunc is called after a dongle is removed from config.
var NotifyDongleRemovedFunc func(dongleID string)

// NotifyDongleStartedFunc is called after a dongle starts successfully.
var NotifyDongleStartedFunc func(dongleID string)

// NotifyDongleStoppedFunc is called after a dongle is stopped.
var NotifyDongleStoppedFunc func(dongleID string)

// NotifyProfileAddedFunc is called after a profile is added.
var NotifyProfileAddedFunc func(dongleID string, profile *config.DongleProfile)

// NotifyProfileUpdatedFunc is called after a profile is modified.
var NotifyProfileUpdatedFunc func(dongleID string, profile *config.DongleProfile)

// NotifyProfileRemovedFunc is called after a profile is removed.
var NotifyProfileRemovedFunc func(dongleID, profileID string)

// NotifyProfilesReorderedFunc is called after profiles are reordered.
var NotifyProfilesReorderedFunc func(dongleID string, profiles []config.DongleProfile)

// NotifyServerConfigUpdatedFunc is called after server config changes.
var NotifyServerConfigUpdatedFunc func()

// NotifyConfigSavedFunc is called after config is saved to disk.
var NotifyConfigSavedFunc func()

// localDevicesHandler returns a JSON array of locally-detected RTL-SDR dongles.
// GET /api/admin/devices
func localDevicesHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if EnumerateLocalDevicesFunc == nil {
			writeJSON(w, http.StatusOK, []any{})
			return
		}
		devs := EnumerateLocalDevicesFunc()
		if devs == nil {
			devs = []any{}
		}
		writeJSON(w, http.StatusOK, devs)
	}
}

// switchProfileHandler switches a dongle's active profile.
// POST /api/admin/dongles/{id}/profile  body: {"profileId": "..."}
func switchProfileHandler(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dongleID := chi.URLParam(r, "id")
		var body struct {
			ProfileId string `json:"profileId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ProfileId == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "profileId required"})
			return
		}

		if ProfileSwitchFunc == nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "profile switching not available"})
			return
		}

		if err := ProfileSwitchFunc(dongleID, body.ProfileId); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}

		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "dongleId": dongleID, "profileId": body.ProfileId})
	}
}

// createProfileHandler adds a profile to a dongle.
// dongleStartHandler starts a dongle.
func dongleStartHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dongleID := chi.URLParam(r, "id")
		if DongleStartFunc == nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "start not available"})
			return
		}
		if err := DongleStartFunc(dongleID); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}

		// Notify all clients
		if NotifyDongleStartedFunc != nil {
			NotifyDongleStartedFunc(dongleID)
		}

		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "dongleId": dongleID})
	}
}

// dongleStopHandler stops a dongle.
func dongleStopHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dongleID := chi.URLParam(r, "id")
		if DongleStopFunc == nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "stop not available"})
			return
		}
		if err := DongleStopFunc(dongleID); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}

		// Notify all clients
		if NotifyDongleStoppedFunc != nil {
			NotifyDongleStoppedFunc(dongleID)
		}

		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "dongleId": dongleID})
	}
}

func createProfileHandler(cfg *config.Config, ver *config.ConfigVersion) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dongleID := chi.URLParam(r, "id")
		var p config.DongleProfile
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
			return
		}
		if p.ID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "profile id is required"})
			return
		}

		for i, d := range cfg.Dongles {
			if d.ID == dongleID {
				// Check for duplicate profile ID
				for _, existing := range d.Profiles {
					if existing.ID == p.ID {
						writeJSON(w, http.StatusConflict, map[string]string{"error": "profile with this id already exists"})
						return
					}
				}
				cfg.Dongles[i].Profiles = append(cfg.Dongles[i].Profiles, p)

				// Bump config version
				newVer := bumpVersion(ver)

				// Notify all clients
				if NotifyProfileAddedFunc != nil {
					NotifyProfileAddedFunc(dongleID, &cfg.Dongles[i].Profiles[len(cfg.Dongles[i].Profiles)-1])
				}

				setVersionHeader(w, newVer)
				writeJSON(w, http.StatusCreated, p)
				return
			}
		}
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "dongle not found"})
	}
}

// updateProfileHandler updates a profile within a dongle.
func updateProfileHandler(cfg *config.Config, ver *config.ConfigVersion) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dongleID := chi.URLParam(r, "id")
		profileID := chi.URLParam(r, "profileId")

		var updated config.DongleProfile
		if err := json.NewDecoder(r.Body).Decode(&updated); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
			return
		}

		for i, d := range cfg.Dongles {
			if d.ID == dongleID {
				for j, p := range d.Profiles {
					if p.ID == profileID {
						updated.ID = profileID // Ensure ID cannot be changed
						cfg.Dongles[i].Profiles[j] = updated

						// Bump config version
						newVer := bumpVersion(ver)

						// Notify all clients
						if NotifyProfileUpdatedFunc != nil {
							NotifyProfileUpdatedFunc(dongleID, &cfg.Dongles[i].Profiles[j])
						}

						setVersionHeader(w, newVer)
						writeJSON(w, http.StatusOK, updated)
						return
					}
				}
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "profile not found"})
				return
			}
		}
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "dongle not found"})
	}
}

// deleteProfileHandler removes a profile from a dongle.
func deleteProfileHandler(cfg *config.Config, ver *config.ConfigVersion) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dongleID := chi.URLParam(r, "id")
		profileID := chi.URLParam(r, "profileId")

		for i, d := range cfg.Dongles {
			if d.ID == dongleID {
				for j, p := range d.Profiles {
					if p.ID == profileID {
						cfg.Dongles[i].Profiles = append(cfg.Dongles[i].Profiles[:j], cfg.Dongles[i].Profiles[j+1:]...)

						// Bump config version
						newVer := bumpVersion(ver)

						// Notify all clients
						if NotifyProfileRemovedFunc != nil {
							NotifyProfileRemovedFunc(dongleID, profileID)
						}

						// Cascade: if this was the active profile on a running dongle,
						// switch to next profile or stop
						if HandleProfileRemovedFunc != nil {
							go HandleProfileRemovedFunc(dongleID, profileID)
						}

						setVersionHeader(w, newVer)
						writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
						return
					}
				}
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "profile not found"})
				return
			}
		}
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "dongle not found"})
	}
}

// reorderProfilesHandler reorders profiles within a dongle.
func reorderProfilesHandler(cfg *config.Config, ver *config.ConfigVersion) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dongleID := chi.URLParam(r, "id")

		var body struct {
			Order []string `json:"order"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
			return
		}

		for i, d := range cfg.Dongles {
			if d.ID == dongleID {
				// Build a map of existing profiles
				profileMap := make(map[string]config.DongleProfile)
				for _, p := range d.Profiles {
					profileMap[p.ID] = p
				}

				// Reorder based on provided order
				reordered := make([]config.DongleProfile, 0, len(body.Order))
				for _, id := range body.Order {
					if p, ok := profileMap[id]; ok {
						reordered = append(reordered, p)
						delete(profileMap, id)
					}
				}
				// Append any profiles not in the order list at the end
				for _, p := range profileMap {
					reordered = append(reordered, p)
				}

				cfg.Dongles[i].Profiles = reordered

				// Bump config version
				newVer := bumpVersion(ver)

				// Notify all clients
				if NotifyProfilesReorderedFunc != nil {
					NotifyProfilesReorderedFunc(dongleID, reordered)
				}

				setVersionHeader(w, newVer)
				writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
				return
			}
		}
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "dongle not found"})
	}
}

// saveConfigHandler writes the current config to the YAML file.
// Supports optimistic concurrency via If-Match header or "version" in request body.
// Returns 409 Conflict if the client's version doesn't match the current server version.
func saveConfigHandler(cfg *config.Config, cfgPath string, ver *config.ConfigVersion) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Check optimistic concurrency: client must send the version it loaded
		// via If-Match header (preferred) or JSON body field.
		if ver != nil {
			currentVer := ver.Get()
			clientVer := uint64(0)

			// Try If-Match header first
			if ifMatch := r.Header.Get("If-Match"); ifMatch != "" {
				// Strip quotes if present (ETag format: "123")
				ifMatch = strings.Trim(ifMatch, "\"")
				if v, err := strconv.ParseUint(ifMatch, 10, 64); err == nil {
					clientVer = v
				}
			}

			// If no header, try to peek at body for version field
			if clientVer == 0 {
				// We need to read the body to check for version, but save-config
				// doesn't normally have a body. If a body is present, check it.
				var body struct {
					Version uint64 `json:"version"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err == nil && body.Version > 0 {
					clientVer = body.Version
				}
			}

			// If client provided a version, enforce concurrency check
			if clientVer > 0 && clientVer != currentVer {
				writeJSON(w, http.StatusConflict, map[string]any{
					"error":          "config has been modified by another session",
					"clientVersion":  clientVer,
					"currentVersion": currentVer,
				})
				return
			}
		}

		data, err := yaml.Marshal(cfg)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to marshal config"})
			return
		}

		if err := os.WriteFile(cfgPath, data, 0644); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to write config file"})
			return
		}

		// Notify all clients that config was saved
		if NotifyConfigSavedFunc != nil {
			NotifyConfigSavedFunc()
		}

		// Return current version in response
		currentVer := uint64(0)
		if ver != nil {
			currentVer = ver.Get()
		}
		setVersionHeader(w, currentVer)
		writeJSON(w, http.StatusOK, map[string]any{"status": "saved", "version": currentVer})
	}
}

// serverConfigHandler returns the server configuration section.
func serverConfigHandler(cfg *config.Config, ver *config.ConfigVersion) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		currentVer := uint64(0)
		if ver != nil {
			currentVer = ver.Get()
		}
		setVersionHeader(w, currentVer)
		writeJSON(w, http.StatusOK, map[string]any{
			"port":                  cfg.Server.Port,
			"host":                  cfg.Server.Host,
			"callsign":              cfg.Server.Callsign,
			"description":           cfg.Server.Description,
			"location":              cfg.Server.Location,
			"adminPassword":         cfg.Server.AdminPassword,
			"demoMode":              cfg.Server.DemoMode,
			"fftHistoryFftSize":     cfg.Server.FftHistoryFftSize,
			"fftHistoryCompression": cfg.Server.FftHistoryCompression,
			"allowedFftCodecs":      cfg.Server.AllowedFftCodecs,
			"allowedIqCodecs":       cfg.Server.AllowedIqCodecs,
			"opusComplexity":        cfg.Server.OpusComplexity,
			// Music identification API keys (never exposed in public meta, admin only)
			"auddApiKey":           cfg.Server.AuddAPIKey,
			"acrcloudHost":         cfg.Server.ACRCloudHost,
			"acrcloudAccessKey":    cfg.Server.ACRCloudAccessKey,
			"acrcloudAccessSecret": cfg.Server.ACRCloudAccessSecret,
			"version":              currentVer,
		})
	}
}

// updateServerConfigHandler updates the server configuration section.
func updateServerConfigHandler(cfg *config.Config, ver *config.ConfigVersion) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Callsign              *string  `json:"callsign"`
			Description           *string  `json:"description"`
			Location              *string  `json:"location"`
			Port                  *int     `json:"port"`
			Host                  *string  `json:"host"`
			AdminPassword         *string  `json:"adminPassword"`
			DemoMode              *bool    `json:"demoMode"`
			FftHistoryFftSize     *int     `json:"fftHistoryFftSize"`
			FftHistoryCompression *string  `json:"fftHistoryCompression"`
			AllowedFftCodecs      []string `json:"allowedFftCodecs"`
			AllowedIqCodecs       []string `json:"allowedIqCodecs"`
			OpusComplexity        *int     `json:"opusComplexity"`
			// Music identification
			AuddAPIKey           *string `json:"auddApiKey"`
			ACRCloudHost         *string `json:"acrcloudHost"`
			ACRCloudAccessKey    *string `json:"acrcloudAccessKey"`
			ACRCloudAccessSecret *string `json:"acrcloudAccessSecret"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
			return
		}
		if body.Callsign != nil {
			cfg.Server.Callsign = *body.Callsign
		}
		if body.Description != nil {
			cfg.Server.Description = *body.Description
		}
		if body.Location != nil {
			cfg.Server.Location = *body.Location
		}
		if body.Port != nil {
			cfg.Server.Port = *body.Port
		}
		if body.Host != nil {
			cfg.Server.Host = *body.Host
		}
		if body.AdminPassword != nil {
			cfg.Server.AdminPassword = *body.AdminPassword
		}
		if body.DemoMode != nil {
			cfg.Server.DemoMode = *body.DemoMode
		}
		if body.FftHistoryFftSize != nil {
			cfg.Server.FftHistoryFftSize = *body.FftHistoryFftSize
		}
		if body.FftHistoryCompression != nil {
			cfg.Server.FftHistoryCompression = *body.FftHistoryCompression
		}
		if body.AllowedFftCodecs != nil {
			cfg.Server.AllowedFftCodecs = body.AllowedFftCodecs
			if SetAllowedCodecsFunc != nil {
				SetAllowedCodecsFunc(cfg.Server.AllowedFftCodecs, cfg.Server.AllowedIqCodecs)
			}
		}
		if body.AllowedIqCodecs != nil {
			cfg.Server.AllowedIqCodecs = body.AllowedIqCodecs
			if SetAllowedCodecsFunc != nil {
				SetAllowedCodecsFunc(cfg.Server.AllowedFftCodecs, cfg.Server.AllowedIqCodecs)
			}
		}
		if body.OpusComplexity != nil {
			c := *body.OpusComplexity
			if c < 0 {
				c = 0
			} else if c > 10 {
				c = 10
			}
			cfg.Server.OpusComplexity = c
		}
		// Music identification API keys
		if body.AuddAPIKey != nil {
			cfg.Server.AuddAPIKey = *body.AuddAPIKey
		}
		if body.ACRCloudHost != nil {
			cfg.Server.ACRCloudHost = *body.ACRCloudHost
		}
		if body.ACRCloudAccessKey != nil {
			cfg.Server.ACRCloudAccessKey = *body.ACRCloudAccessKey
		}
		if body.ACRCloudAccessSecret != nil {
			cfg.Server.ACRCloudAccessSecret = *body.ACRCloudAccessSecret
		}

		// Bump config version
		newVer := bumpVersion(ver)

		// Notify all clients of server config change
		if NotifyServerConfigUpdatedFunc != nil {
			NotifyServerConfigUpdatedFunc()
		}

		setVersionHeader(w, newVer)
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "version": newVer})
	}
}

// --- Version helpers ---

// bumpVersion increments the config version counter. Safe to call with nil.
func bumpVersion(ver *config.ConfigVersion) uint64 {
	if ver == nil {
		return 0
	}
	return ver.Increment()
}

// setVersionHeader sets the X-Config-Version and ETag response headers.
func setVersionHeader(w http.ResponseWriter, version uint64) {
	if version > 0 {
		v := fmt.Sprintf("%d", version)
		w.Header().Set("X-Config-Version", v)
		w.Header().Set("ETag", fmt.Sprintf("\"%s\"", v))
	}
}

// GetConfigVersionFunc returns the current config version.
// Set by main.go to allow notifications to include the version.
var GetConfigVersionFunc func() uint64

// needsReinit checks if a dongle update includes hardware-level changes
// that require the dongle to be fully reinitialised (stop + start).
func needsReinit(old, new *config.DongleConfig) bool {
	if old.Source.Type != new.Source.Type {
		return true
	}
	if old.Source.Host != new.Source.Host || old.Source.Port != new.Source.Port {
		return true
	}
	if old.Source.DeviceIndex != new.Source.DeviceIndex || old.Source.Serial != new.Source.Serial {
		return true
	}
	if old.Source.Binary != new.Source.Binary || old.Source.SpawnRtlTcp != new.Source.SpawnRtlTcp {
		return true
	}
	if old.SampleRate != new.SampleRate {
		return true
	}
	return false
}

// recordStartHandler begins IQ recording for a dongle.
// POST /api/admin/dongles/{id}/record
func recordStartHandler(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dongleID := chi.URLParam(r, "id")
		if RecordStartFunc == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "recording not available"})
			return
		}
		// Find the dongle to get center frequency and sample rate
		var centerFreq int64
		var sampleRate int
		for _, d := range cfg.Dongles {
			if d.ID == dongleID && len(d.Profiles) > 0 {
				centerFreq = d.Profiles[0].CenterFrequency
				sampleRate = d.Profiles[0].SampleRate
				if sampleRate <= 0 {
					sampleRate = d.SampleRate
				}
				break
			}
		}
		if sampleRate <= 0 {
			sampleRate = 2400000
		}
		if err := RecordStartFunc(dongleID, centerFreq, sampleRate); err != nil {
			writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "recording", "dongleId": dongleID})
	}
}

// recordStopHandler stops IQ recording for a dongle and returns the file path.
// DELETE /api/admin/dongles/{id}/record
func recordStopHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dongleID := chi.URLParam(r, "id")
		if RecordStopFunc == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "recording not available"})
			return
		}
		path, err := RecordStopFunc(dongleID)
		if err != nil {
			writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"status": "stopped", "file": path})
	}
}

// recordStatusHandler returns all active recordings.
// GET /api/admin/recordings
func recordStatusHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if RecordStatusFunc == nil {
			writeJSON(w, http.StatusOK, []any{})
			return
		}
		writeJSON(w, http.StatusOK, RecordStatusFunc())
	}
}
