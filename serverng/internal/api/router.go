// Package api provides the HTTP router and API handlers for the WebSDR server.
package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/gbozo/no-sdr/serverng/internal/config"
	"github.com/gbozo/no-sdr/serverng/internal/ws"
)

var startTime = time.Now()

// NewRouter creates the chi router with all routes.
func NewRouter(wsMgr *ws.Manager, cfg *config.Config, logger *slog.Logger, staticDir string) http.Handler {
	return NewRouterWithPath(wsMgr, cfg, logger, staticDir, "")
}

// NewRouterWithPath creates the chi router with all routes including admin config save support.
func NewRouterWithPath(wsMgr *ws.Manager, cfg *config.Config, logger *slog.Logger, staticDir string, cfgPath string) http.Handler {
	r := chi.NewRouter()

	// Middleware
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(corsMiddleware)

	// Rate limiter for WebSocket connections
	wsRateLimiter := ws.NewRateLimiter(10)
	wsMgr.SetRateLimiter(wsRateLimiter)

	// WebSocket upgrade with rate limiting
	r.Group(func(r chi.Router) {
		r.Use(wsRateLimiter.Middleware)
		r.Get("/ws", wsMgr.HandleUpgrade)
	})

	// API routes
	r.Route("/api", func(r chi.Router) {
		r.Get("/status", statusHandler(wsMgr))
		r.Get("/dongles", donglesHandler(cfg, wsMgr))
		r.Get("/dongles/{id}/profiles", dongleProfilesHandler(cfg))
	})

	// Admin routes
	adminAuth := NewAdminAuth(cfg.Server.AdminPassword)
	r.Route("/api/admin", func(r chi.Router) {
		r.Post("/login", adminAuth.Login)
		r.Post("/logout", adminAuth.Logout)
		r.Get("/check", adminAuth.IsAuthenticated)
		r.Get("/session", adminAuth.IsAuthenticated) // alias used by client

		// Protected routes
		r.Group(func(r chi.Router) {
			r.Use(adminAuth.CheckAuth)
			r.Get("/dongles", adminDonglesHandler(cfg, wsMgr))
			r.Post("/dongles", createDongleHandler(cfg))
			r.Put("/dongles/{id}", updateDongleHandler(cfg))
			r.Delete("/dongles/{id}", deleteDongleHandler(cfg))
			r.Post("/dongles/{id}/profile", switchProfileHandler(cfg))
			r.Post("/dongles/{id}/start", dongleStartHandler())
			r.Post("/dongles/{id}/stop", dongleStopHandler())
			r.Post("/dongles/{id}/profiles", createProfileHandler(cfg))
			r.Put("/dongles/{id}/profiles/{profileId}", updateProfileHandler(cfg))
			r.Delete("/dongles/{id}/profiles/{profileId}", deleteProfileHandler(cfg))
			r.Put("/dongles/{id}/profiles-order", reorderProfilesHandler(cfg))
			r.Post("/save-config", saveConfigHandler(cfg, cfgPath))
			r.Get("/server/config", serverConfigHandler(cfg))
			r.Put("/server/config", updateServerConfigHandler(cfg))
		})
	})

	// Health check
	r.Get("/health", healthHandler)

	// Static files with SPA fallback
	if staticDir != "" {
		r.Get("/*", SPAHandler(staticDir))
	}

	return r
}

// statusHandler returns server status information.
func statusHandler(wsMgr *ws.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uptime := time.Since(startTime).Seconds()
		resp := map[string]any{
			"status":  "ok",
			"clients": wsMgr.ClientCount(),
			"uptime":  int64(uptime),
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// dongleResponse matches what the SolidJS client expects from GET /api/dongles.
type dongleResponse struct {
	ID              string `json:"id"`
	DeviceIndex     int    `json:"deviceIndex"`
	Name            string `json:"name"`
	Serial          string `json:"serial"`
	Source          string `json:"source"`
	ActiveProfileId string `json:"activeProfileId"`
	PpmCorrection   int    `json:"ppmCorrection"`
	Running         bool   `json:"running"`
	ClientCount     int    `json:"clientCount"`
}

type profileResponse struct {
	ID                   string  `json:"id"`
	Name                 string  `json:"name"`
	CenterFrequency      int64   `json:"centerFrequency"`
	SampleRate           int     `json:"sampleRate"`
	FftSize              int     `json:"fftSize"`
	FftFps               int     `json:"fftFps"`
	DefaultMode          string  `json:"defaultMode"`
	DefaultTuneOffset    int     `json:"defaultTuneOffset"`
	DefaultBandwidth     int     `json:"defaultBandwidth"`
	TuningStep           int     `json:"tuningStep,omitempty"`
	Gain                 float64 `json:"gain"`
	Description          string  `json:"description,omitempty"`
	DirectSampling       int     `json:"directSampling,omitempty"`
	PreFilterNb          bool    `json:"preFilterNb,omitempty"`
	PreFilterNbThreshold int     `json:"preFilterNbThreshold,omitempty"`
	Decoders             []any   `json:"decoders"`
	DongleId             string  `json:"dongleId"`
}

// donglesHandler returns the list of configured dongles with runtime state.
func donglesHandler(cfg *config.Config, wsMgr *ws.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var resp []dongleResponse
		for _, d := range cfg.Dongles {
			dr := dongleResponse{
				ID:            d.ID,
				DeviceIndex:   d.DeviceIndex,
				Name:          d.Name,
				Serial:        "",
				Source:        d.Source.Type,
				PpmCorrection: d.PPM,
				Running:       d.Enabled && d.AutoStart,
				ClientCount:   len(wsMgr.SubscribedClients(d.ID)),
			}
			if len(d.Profiles) > 0 {
				dr.ActiveProfileId = d.Profiles[0].ID
			}
			resp = append(resp, dr)
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// healthHandler returns a simple health check response.
func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"ok"}`))
}

// dongleProfilesHandler returns profiles for a specific dongle.
func dongleProfilesHandler(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dongleID := chi.URLParam(r, "id")
		for _, d := range cfg.Dongles {
			if d.ID == dongleID {
				var profiles []profileResponse
				for _, p := range d.Profiles {
					profiles = append(profiles, profileResponse{
						ID:                   p.ID,
						Name:                 p.Name,
						CenterFrequency:      p.CenterFrequency,
						SampleRate:           p.SampleRate,
						FftSize:              p.FftSize,
						FftFps:               p.FftFps,
						DefaultMode:          p.Mode,
						DefaultTuneOffset:    p.TuneOffset,
						DefaultBandwidth:     p.Bandwidth,
						TuningStep:           p.TuningStep,
						Gain:                 p.Gain,
						Description:          p.Description,
						DirectSampling:       p.DirectSampling,
						PreFilterNb:          p.PreFilterNb,
						PreFilterNbThreshold: p.PreFilterNbThreshold,
						Decoders:             []any{},
						DongleId:             dongleID,
					})
				}
				writeJSON(w, http.StatusOK, profiles)
				return
			}
		}
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "dongle not found"})
	}
}

// corsMiddleware adds CORS headers for development.
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// writeJSON marshals v as JSON and writes it with the given status code.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
