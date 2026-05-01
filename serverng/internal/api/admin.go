package api

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net/http"
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
func createDongleHandler(cfg *config.Config) http.HandlerFunc {
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
		writeJSON(w, http.StatusCreated, d)
	}
}

// updateDongleHandler updates an existing dongle.
func updateDongleHandler(cfg *config.Config) http.HandlerFunc {
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
				cfg.Dongles[i] = updated
				writeJSON(w, http.StatusOK, updated)
				return
			}
		}
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "dongle not found"})
	}
}

// deleteDongleHandler removes a dongle from the config.
func deleteDongleHandler(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		for i, d := range cfg.Dongles {
			if d.ID == id {
				cfg.Dongles = append(cfg.Dongles[:i], cfg.Dongles[i+1:]...)
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

// EnumerateLocalDevicesFunc returns info about locally-attached RTL-SDR USB devices.
// Set by main.go; nil when rtlsdr support is not compiled in.
var EnumerateLocalDevicesFunc func() []any

// SetAllowedCodecsFunc updates the WS manager's allowed codec sets at runtime.
// Set by main.go so the admin handler can propagate changes without a restart.
var SetAllowedCodecsFunc func(fft, iq []string)

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
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "dongleId": dongleID})
	}
}

func createProfileHandler(cfg *config.Config) http.HandlerFunc {
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
				writeJSON(w, http.StatusCreated, p)
				return
			}
		}
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "dongle not found"})
	}
}

// updateProfileHandler updates a profile within a dongle.
func updateProfileHandler(cfg *config.Config) http.HandlerFunc {
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
func deleteProfileHandler(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dongleID := chi.URLParam(r, "id")
		profileID := chi.URLParam(r, "profileId")

		for i, d := range cfg.Dongles {
			if d.ID == dongleID {
				for j, p := range d.Profiles {
					if p.ID == profileID {
						cfg.Dongles[i].Profiles = append(cfg.Dongles[i].Profiles[:j], cfg.Dongles[i].Profiles[j+1:]...)
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
func reorderProfilesHandler(cfg *config.Config) http.HandlerFunc {
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
				writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
				return
			}
		}
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "dongle not found"})
	}
}

// saveConfigHandler writes the current config to the YAML file.
func saveConfigHandler(cfg *config.Config, cfgPath string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, err := yaml.Marshal(cfg)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to marshal config"})
			return
		}

		if err := os.WriteFile(cfgPath, data, 0644); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to write config file"})
			return
		}

		writeJSON(w, http.StatusOK, map[string]string{"status": "saved"})
	}
}

// serverConfigHandler returns the server configuration section.
func serverConfigHandler(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"port":             cfg.Server.Port,
			"host":             cfg.Server.Host,
			"callsign":         cfg.Server.Callsign,
			"description":      cfg.Server.Description,
			"location":         cfg.Server.Location,
			"adminPassword":    cfg.Server.AdminPassword,
			"allowedFftCodecs": cfg.Server.AllowedFftCodecs,
			"allowedIqCodecs":  cfg.Server.AllowedIqCodecs,
		})
	}
}

// updateServerConfigHandler updates the server configuration section.
func updateServerConfigHandler(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Callsign         *string  `json:"callsign"`
			Description      *string  `json:"description"`
			Location         *string  `json:"location"`
			Port             *int     `json:"port"`
			Host             *string  `json:"host"`
			AllowedFftCodecs []string `json:"allowedFftCodecs"`
			AllowedIqCodecs  []string `json:"allowedIqCodecs"`
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
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}
