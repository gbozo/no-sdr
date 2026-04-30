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
	"syscall"
	"time"

	"github.com/gbozo/no-sdr/serverng/internal/api"
	"github.com/gbozo/no-sdr/serverng/internal/config"
	"github.com/gbozo/no-sdr/serverng/internal/dongle"
	"github.com/gbozo/no-sdr/serverng/internal/ws"
)

// version is set by ldflags at build time.
var version = "dev"

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

	// Determine static files directory.
	staticDir := os.Getenv("STATIC_DIR")
	if staticDir == "" {
		staticDir = "../client/dist"
	}

	// Create WebSocket manager.
	wsMgr := ws.NewManager(logger)

	// Create dongle manager and start pipelines.
	dongleMgr := dongle.NewManager(cfg, wsMgr, logger)

	// Graceful shutdown on SIGINT/SIGTERM.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Start all enabled dongles.
	if err := dongleMgr.Start(ctx); err != nil {
		logger.Error("failed to start dongle manager", "error", err)
		os.Exit(1)
	}

	// Create chi router with all routes.
	router := api.NewRouterWithPath(wsMgr, cfg, logger, staticDir, cfgPath)

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

	// 1. Stop accepting new connections (server shutdown starts)
	// 2. Drain WebSocket connections (5 second window)
	drainCtx, drainCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer drainCancel()

	// Stop dongle pipelines first (stops IQ data flow)
	dongleMgr.Stop()

	// Drain WebSocket connections
	wsMgr.Shutdown(drainCtx)

	// Shut down HTTP server (stops accepting, waits for in-flight)
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("shutdown error", "error", err)
		os.Exit(1)
	}

	logger.Info("server stopped", "version", version)
}
