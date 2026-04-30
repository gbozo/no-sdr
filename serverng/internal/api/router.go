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
	r := chi.NewRouter()

	// Middleware
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(corsMiddleware)

	// WebSocket upgrade
	r.Get("/ws", wsMgr.HandleUpgrade)

	// API routes
	r.Route("/api", func(r chi.Router) {
		r.Get("/status", statusHandler(wsMgr))
		r.Get("/dongles", donglesHandler(cfg, wsMgr))
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
	ID              string            `json:"id"`
	Name            string            `json:"name"`
	Running         bool              `json:"running"`
	Enabled         bool              `json:"enabled"`
	ActiveProfileId string            `json:"activeProfileId"`
	ClientCount     int               `json:"clientCount"`
	Profiles        []profileResponse `json:"profiles"`
}

type profileResponse struct {
	ID              string  `json:"id"`
	Name            string  `json:"name"`
	CenterFrequency int64   `json:"centerFrequency"`
	SampleRate      int     `json:"sampleRate"`
	Bandwidth       int     `json:"bandwidth"`
	Mode            string  `json:"mode"`
	Gain            float64 `json:"gain"`
	FftSize         int     `json:"fftSize"`
	FftFps          int     `json:"fftFps"`
}

// donglesHandler returns the list of configured dongles with runtime state.
func donglesHandler(cfg *config.Config, wsMgr *ws.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var resp []dongleResponse
		for _, d := range cfg.Dongles {
			dr := dongleResponse{
				ID:      d.ID,
				Name:    d.Name,
				Running: d.Enabled && d.AutoStart,
				Enabled: d.Enabled,
			}
			if len(d.Profiles) > 0 {
				dr.ActiveProfileId = d.Profiles[0].ID
			}
			// Count clients subscribed to this dongle
			dr.ClientCount = len(wsMgr.SubscribedClients(d.ID))
			// Add profiles
			for _, p := range d.Profiles {
				dr.Profiles = append(dr.Profiles, profileResponse{
					ID:              p.ID,
					Name:            p.Name,
					CenterFrequency: p.CenterFrequency,
					SampleRate:      p.SampleRate,
					Bandwidth:       p.Bandwidth,
					Mode:            p.Mode,
					Gain:            p.Gain,
					FftSize:         p.FftSize,
					FftFps:          p.FftFps,
				})
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
