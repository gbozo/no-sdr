package api

import (
	"net"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gbozo/no-sdr/serverng/internal/codec"
	"github.com/gbozo/no-sdr/serverng/internal/config"
	"github.com/gbozo/no-sdr/serverng/internal/ws"
)

// Version is set by main.go at startup from ldflags.
var Version = "dev"

// GoAMD64 is set by main.go from ldflags — indicates the GOAMD64
// level (v1–v4) the binary was compiled for. Empty for non-amd64 builds.
var GoAMD64 = ""

// GetDongleStatesFunc returns current lifecycle states for all dongles.
// Set by main.go to dongle.Manager.GetAllDongleStates.
var GetDongleStatesFunc func() map[string]any

// SetGPUEnabledFunc is called when admin toggles GPU on/off at runtime.
// Set by main.go to dongle.Manager.SetGPUEnabled.
var SetGPUEnabledFunc func(enabled bool)

// GetGPUStatsFunc returns GPU pipeline stats (fft frames, iq dispatches, fm dispatches).
// Set by main.go to dongle.Manager.GetGPUStats.
var GetGPUStatsFunc func() map[string]any

// GPUCapability holds the result of gpu.Probe() for exposing in system-info.
// Set by main.go after probe. Each field is safe to read without the gpu package.
var GPUCapability struct {
	Available      bool
	Enabled        bool
	DeviceName     string
	DeviceType     string
	VRAM           uint64
	UnifiedMemory  bool
	VkFFTAvailable bool
}

// cpuTracker samples process CPU usage periodically.
var cpuTracker = &cpuUsageTracker{}

type cpuUsageTracker struct {
	mu          sync.Mutex
	lastTime    time.Time
	lastCPUNs   int64 // total CPU nanoseconds at last sample
	usagePerc   float64
	numCPU      int
}

func init() {
	cpuTracker.numCPU = runtime.NumCPU()
	cpuTracker.lastTime = time.Now()
	cpuTracker.lastCPUNs = readProcessCPUNs()
	// Background goroutine to sample every 2s
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		for range ticker.C {
			cpuTracker.sample()
		}
	}()
}

func (t *cpuUsageTracker) sample() {
	now := time.Now()
	cpuNs := readProcessCPUNs()
	t.mu.Lock()
	elapsed := now.Sub(t.lastTime)
	if elapsed > 0 {
		deltaCPU := cpuNs - t.lastCPUNs
		// % of total available CPU time (all cores)
		totalAvailNs := elapsed.Nanoseconds() * int64(t.numCPU)
		if totalAvailNs > 0 {
			t.usagePerc = float64(deltaCPU) / float64(totalAvailNs) * 100
		}
	}
	t.lastTime = now
	t.lastCPUNs = cpuNs
	t.mu.Unlock()
}

func (t *cpuUsageTracker) get() float64 {
	t.mu.Lock()
	v := t.usagePerc
	t.mu.Unlock()
	return v
}

// readProcessCPUNs returns cumulative process CPU time in nanoseconds.
// Uses /proc/self/stat on Linux, falls back to user-space timing on other platforms.
func readProcessCPUNs() int64 {
	data, err := os.ReadFile("/proc/self/stat")
	if err == nil {
		fields := strings.Fields(string(data))
		if len(fields) >= 15 {
			utime, _ := strconv.ParseInt(fields[13], 10, 64)
			stime, _ := strconv.ParseInt(fields[14], 10, 64)
			// clock ticks → nanoseconds (assume 100 Hz = 10ms per tick)
			return (utime + stime) * 10_000_000
		}
	}
	// Fallback: use Go's runtime scheduler metrics (less accurate but portable)
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	// PauseTotalNs is GC pause; not ideal but no process CPU available in pure Go.
	// Return wall time as rough estimate (adjusted by GOMAXPROCS utilization heuristic).
	return time.Since(startTime).Nanoseconds()
}

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
			"goamd64":  GoAMD64,
			"uptime":    int64(time.Since(startTime).Seconds()),
			"memory": map[string]any{
				"allocMB":   float64(mem.Alloc) / 1024 / 1024,
				"sysMB":     float64(mem.Sys) / 1024 / 1024,
				"numGC":     mem.NumGC,
				"goroutines": runtime.NumGoroutine(),
			},
			"cpu": map[string]any{
				"cores":      runtime.NumCPU(),
				"usagePerc":  cpuTracker.get(),
			},
		"features": map[string]any{
			"opusSupport":     codec.OpusAvailable(),
			"rtlsdrNative":    rtlsdrAvailable(),
			"gpuVulkan":       gpuVulkanCompiled,
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
		"gpu": map[string]any{
			"compiled":      gpuVulkanCompiled,
			"available":     GPUCapability.Available,
			"enabled":       cfg.GPU.Enabled,
			"deviceName":    GPUCapability.DeviceName,
			"deviceType":    GPUCapability.DeviceType,
			"vramMB":        GPUCapability.VRAM / 1024 / 1024,
			"unifiedMemory": GPUCapability.UnifiedMemory,
			"vkfft":         GPUCapability.VkFFTAvailable,
			"stats":         getGPUStats(),
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
			// Strip port from IP for display; keep full value as fallback.
			displayIP := info.IP
			if host, _, err := net.SplitHostPort(info.IP); err == nil {
				displayIP = host
			}

			entry := map[string]any{
				"id":            info.ID,
				"persistentId":  info.PersistentID,
				"connIndex":     info.ConnIndex,
				"ip":            displayIP,
				"dongleId":      info.DongleID,
				"profileId":     info.ProfileID,
				"fftCodec":      info.FftCodec,
				"iqCodec":       info.IqCodec,
				"mode":          info.Mode,
				"tuneOffset":    info.TuneOffset,
				"bandwidth":     info.Bandwidth,
				"audioEnabled":  info.AudioEnabled,
				"stereoEnabled": info.StereoEnabled,
				"connectedAt":   info.ConnectedAt,
			}

			// Include raw proxy header value when available (non-empty = behind proxy).
			if info.RealIP != "" {
				entry["realIp"] = info.RealIP
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

// getGPUStats returns GPU pipeline statistics if available.
func getGPUStats() map[string]any {
	if GetGPUStatsFunc != nil {
		return GetGPUStatsFunc()
	}
	return nil
}
