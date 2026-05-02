package api

import (
	"net/http"
	"runtime"
	"time"

	"github.com/gbozo/no-sdr/serverng/internal/codec"
	"github.com/gbozo/no-sdr/serverng/internal/config"
	"github.com/gbozo/no-sdr/serverng/internal/ws"
)

// Version is set by main.go at startup from ldflags.
var Version = "dev"

// GetDongleStatesFunc returns current lifecycle states for all dongles.
// Set by main.go to dongle.Manager.GetAllDongleStates.
var GetDongleStatesFunc func() map[string]any

// systemInfoHandler returns build info, supported features, and server runtime info.
// GET /api/admin/system-info
func systemInfoHandler(cfg *config.Config, wsMgr *ws.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var mem runtime.MemStats
		runtime.ReadMemStats(&mem)

		resp := map[string]any{
			"version":   Version,
			"goVersion": runtime.Version(),
			"os":        runtime.GOOS,
			"arch":      runtime.GOARCH,
			"uptime":    int64(time.Since(startTime).Seconds()),
			"memory": map[string]any{
				"allocMB":   float64(mem.Alloc) / 1024 / 1024,
				"sysMB":     float64(mem.Sys) / 1024 / 1024,
				"numGC":     mem.NumGC,
				"goroutines": runtime.NumGoroutine(),
			},
			"features": map[string]any{
				"opusSupport":     codec.OpusAvailable(),
				"rtlsdrNative":    rtlsdrAvailable(),
				"allowedFftCodecs": cfg.Server.AllowedFftCodecs,
				"allowedIqCodecs":  cfg.Server.AllowedIqCodecs,
				"supportedSources": []string{
					"demo", "rtl_tcp", "airspy_tcp", "hfp_tcp", "rsp_tcp", "local",
				},
				"supportedModes": []string{
					"wfm", "nfm", "am", "am-stereo", "usb", "lsb", "cw", "raw", "sam",
				},
				"supportedFftCodecs": config.DefaultFftCodecs,
				"supportedIqCodecs":  config.DefaultIqCodecs,
			},
			"dongles": map[string]any{
				"configured": len(cfg.Dongles),
				"clients":    wsMgr.ClientCount(),
			},
		}

		// Include dongle states if available
		if GetDongleStatesFunc != nil {
			resp["dongleStates"] = GetDongleStatesFunc()
		}

		writeJSON(w, http.StatusOK, resp)
	}
}

// clientsHandler returns the list of connected WebSocket clients with their state.
// GET /api/admin/clients
func clientsHandler(cfg *config.Config, wsMgr *ws.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		clients := wsMgr.GetAllClients()
		resp := make([]map[string]any, 0, len(clients))

		for _, info := range clients {
			entry := map[string]any{
				"id":           info.ID,
				"persistentId": info.PersistentID,
				"connIndex":    info.ConnIndex,
				"ip":           info.IP,
				"dongleId":     info.DongleID,
				"profileId":    info.ProfileID,
				"fftCodec":     info.FftCodec,
				"iqCodec":      info.IqCodec,
				"mode":         info.Mode,
				"tuneOffset":   info.TuneOffset,
				"bandwidth":    info.Bandwidth,
				"audioEnabled": info.AudioEnabled,
				"connectedAt":  info.ConnectedAt,
			}

			// Resolve dongle name and profile details from config
			if info.DongleID != "" {
				for i := range cfg.Dongles {
					if cfg.Dongles[i].ID == info.DongleID {
						entry["dongleName"] = cfg.Dongles[i].Name
						// Resolve profile name and frequency
						if info.ProfileID != "" {
							for j := range cfg.Dongles[i].Profiles {
								if cfg.Dongles[i].Profiles[j].ID == info.ProfileID {
									entry["profileName"] = cfg.Dongles[i].Profiles[j].Name
									entry["centerFrequency"] = cfg.Dongles[i].Profiles[j].CenterFrequency
									break
								}
							}
						}
						break
					}
				}
			}

			resp = append(resp, entry)
		}

		writeJSON(w, http.StatusOK, resp)
	}
}

// rtlsdrAvailable reports whether native RTL-SDR support is compiled in.
// Determined by checking if the build included the rtlsdr tag.
func rtlsdrAvailable() bool {
	return rtlsdrCompiled
}
