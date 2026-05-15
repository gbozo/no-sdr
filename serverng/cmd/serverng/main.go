// Command serverng is the next-generation WebSDR backend.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/gbozo/no-sdr/serverng/internal/api"
	"github.com/gbozo/no-sdr/serverng/internal/codec"
	"github.com/gbozo/no-sdr/serverng/internal/config"
	"github.com/gbozo/no-sdr/serverng/internal/dongle"
	"github.com/gbozo/no-sdr/serverng/internal/ws"
)

// version is set by ldflags at build time.
var version = "dev"

// goamd64 is set by ldflags at build time to indicate the GOAMD64 level
// (v1, v2, v3, or v4) this binary was compiled for.
var goamd64 = ""

func main() {
	// --version flag
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println("serverng", version)
		os.Exit(0)
	}

	// Setup structured logger.
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	logger.Info("starting serverng", "version", version)

	// Determine config path.
	cfgPath := os.Getenv("CONFIG_PATH")
	if cfgPath == "" {
		cfgPath = "../config/config.yaml"
	}

	// Load configuration.
	cfg, err := config.Load(cfgPath)
	if err != nil {
		logger.Error("failed to load config", "path", cfgPath, "error", err)
		os.Exit(1)
	}

	logger.Info("configuration loaded",
		"port", cfg.Server.Port,
		"host", cfg.Server.Host,
		"dongles", len(cfg.Dongles),
	)

	// Strip Opus codecs if libopus is not compiled in.
	if !codec.OpusAvailable() {
		filtered := cfg.Server.AllowedIqCodecs[:0]
		for _, c := range cfg.Server.AllowedIqCodecs {
			if c != "opus" && c != "opus-hq" {
				filtered = append(filtered, c)
			}
		}
		cfg.Server.AllowedIqCodecs = filtered
		logger.Warn("opus not compiled in — opus/opus-hq removed from allowed IQ codecs")
	}
	logger.Info("allowed codecs",
		"fft", cfg.Server.AllowedFftCodecs,
		"iq", cfg.Server.AllowedIqCodecs,
	)

	// Determine static files directory.
	staticDir := os.Getenv("STATIC_DIR")
	if staticDir == "" {
		staticDir = "../client/dist"
	}

	// Create WebSocket manager.
	wsMgr := ws.NewManager(logger)
	wsMgr.SetAllowedCodecs(cfg.Server.AllowedFftCodecs, cfg.Server.AllowedIqCodecs)
	if cfg.Server.RealIPHeader != "" {
		wsMgr.SetRealIPHeader(cfg.Server.RealIPHeader)
	}

	// Size write channels to the highest FFT fps across all profiles so that
	// even fast-update profiles get ~3s of headroom before drop-oldest fires.
	maxFps := 30
	for _, d := range cfg.Dongles {
		for _, p := range d.Profiles {
			if p.FftFps > maxFps {
				maxFps = p.FftFps
			}
		}
	}
	wsMgr.SetMaxFftFps(maxFps)

	// Create dongle manager and start pipelines.
	dongleMgr := dongle.NewManager(cfg, wsMgr, logger)

	// Register profile switch callback for REST API
	api.ProfileSwitchFunc = dongleMgr.SwitchProfile
	api.DongleStartFunc = dongleMgr.StartDongleByID
	api.DongleStopFunc = dongleMgr.StopDongleByID
	api.DongleReinitFunc = dongleMgr.ReinitDongle
	api.HandleProfileRemovedFunc = dongleMgr.HandleProfileRemoved
	api.SetAllowedCodecsFunc = wsMgr.SetAllowedCodecs
	api.SetRealIPHeaderFunc = wsMgr.SetRealIPHeader
	api.EnumerateLocalDevicesFunc = func() []any {
		devs := dongle.EnumerateLocalDevices()
		out := make([]any, len(devs))
		for i, d := range devs {
			out[i] = d
		}
		return out
	}
	// IQ recording endpoints
	api.RecordStartFunc = dongleMgr.Recorder.Start
	api.RecordStopFunc  = dongleMgr.Recorder.Stop
	api.RecordStatusFunc = func() any { return dongleMgr.Recorder.Status() }

	// Music recognition: PCM is now snapshotted at token-issue time (handleIdentifyStart),
	// so GetOpusPCMFunc is no longer needed at POST time. Kept for compatibility.
	api.GetOpusPCMFunc = dongleMgr.CapturePCMForClient
	dongleMgr.SetIssueIdentifyTokenFunc(func(connClientID, persistentID string, pcmSnapshot []float32) struct {
		Token string
		Err   string
	} {
		r := api.IssueIdentifyToken(connClientID, persistentID, pcmSnapshot)
		return struct {
			Token string
			Err   string
		}{Token: r.Token, Err: r.Err}
	})

	// Wire config push notifications (Phase 3: real-time config push)
	api.NotifyDongleAddedFunc = dongleMgr.NotifyDongleAdded
	api.NotifyDongleUpdatedFunc = dongleMgr.NotifyDongleUpdated
	api.NotifyDongleRemovedFunc = dongleMgr.NotifyDongleRemoved
	api.NotifyDongleStartedFunc = dongleMgr.NotifyDongleStarted
	api.NotifyDongleStoppedFunc = dongleMgr.NotifyDongleStopped
	api.NotifyProfileAddedFunc = dongleMgr.NotifyProfileAdded
	api.NotifyProfileUpdatedFunc = dongleMgr.NotifyProfileUpdated
	api.NotifyProfileRemovedFunc = dongleMgr.NotifyProfileRemoved
	api.NotifyProfilesReorderedFunc = dongleMgr.NotifyProfilesReordered
	api.NotifyServerConfigUpdatedFunc = dongleMgr.NotifyServerConfigUpdated
	api.NotifyConfigSavedFunc = dongleMgr.NotifyConfigSaved

	// Config version counter for optimistic concurrency (Phase 2)
	cfgVersion := config.NewConfigVersion()
	api.GetConfigVersionFunc = cfgVersion.Get
	api.Version = version
	api.GoAMD64 = goamd64
	api.GetDongleStatesFunc = func() map[string]any {
		states := dongleMgr.GetAllDongleStates()
		result := make(map[string]any, len(states))
		for id, state := range states {
			result[id] = state
		}
		return result
	}
	dongleMgr.SetVersionFunc(cfgVersion.Get)

	// Graceful shutdown on SIGINT/SIGTERM.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Start all enabled dongles (non-fatal — server continues even if dongles fail).
	if err := dongleMgr.Start(ctx); err != nil {
		logger.Error("dongle manager start error (server will continue)", "error", err)
	}

	// Band plan service — ships embedded data, refreshes from upstream weekly.
	bandPlanSvc := api.NewBandPlanService(logger)
	bandPlanSvc.StartScheduler()
	api.BandPlanSvc = bandPlanSvc

	// Bookmarks directory — adjacent to the config file, or overridden via env.
	bookmarksDir := os.Getenv("BOOKMARKS_DIR")
	if bookmarksDir == "" {
		bookmarksDir = filepath.Join(filepath.Dir(cfgPath), "..", "bookmarks")
	}
	api.BookmarksDir = bookmarksDir
	logger.Info("bookmarks directory", "path", bookmarksDir)

	// Create chi router with all routes.
	router := api.NewRouterWithPath(wsMgr, cfg, logger, staticDir, cfgPath, cfgVersion)

	// Setup HTTP server.
	addr := fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port)
	srv := &http.Server{
		Addr:         addr,
		Handler:      router,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	go func() {
		logger.Info("starting HTTP server", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("HTTP server error", "error", err)
			os.Exit(1)
		}
	}()

	// Block until signal received.
	<-ctx.Done()
	logger.Info("shutting down gracefully...")

	shutdownStart := time.Now()

	// 1. Stop dongle pipelines first (stops IQ data flow + closes Opus encoders)
	dongleMgr.Stop()

	// 2. Stop any active IQ recordings cleanly
	for _, rec := range dongleMgr.Recorder.Status() {
		if path, err := dongleMgr.Recorder.Stop(rec.DongleID); err == nil {
			logger.Info("closed IQ recording on shutdown", "file", path)
		}
	}

	// 3. Drain WebSocket connections (5 second window)
	drainCtx, drainCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer drainCancel()
	wsMgr.Shutdown(drainCtx)
	if drainCtx.Err() != nil {
		logger.Warn("WebSocket drain timed out — some clients may have been dropped")
	}

	// 4. Shut down HTTP server (stops accepting, waits for in-flight requests)
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("HTTP shutdown error", "error", err)
		os.Exit(1)
	}

	logger.Info("server stopped", "version", version, "elapsed", time.Since(shutdownStart).Round(time.Millisecond))
}
