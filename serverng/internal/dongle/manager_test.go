package dongle

import (
	"context"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/gbozo/no-sdr/serverng/internal/config"
	"github.com/gbozo/no-sdr/serverng/internal/ws"
)

func TestManagerStartStop(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))

	cfg := &config.Config{
		Dongles: []config.DongleConfig{
			{
				ID:        "test-dongle",
				Enabled:   true,
				AutoStart: true,
				Profiles: []config.DongleProfile{
					{
						ID:              "test-profile",
						SampleRate:      2400000,
						CenterFrequency: 100000000,
						FftSize:         4096,
						FftFps:          30,
						Mode:            "wfm",
						Bandwidth:       200000,
					},
				},
			},
		},
	}

	wsMgr := ws.NewManager(logger)
	mgr := NewManager(cfg, wsMgr, logger)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	err := mgr.Start(ctx)
	if err != nil {
		t.Fatalf("Start() error: %v", err)
	}

	// Let the pipeline run briefly
	time.Sleep(100 * time.Millisecond)

	// Verify the dongle is registered
	mgr.mu.Lock()
	_, ok := mgr.dongles["test-dongle"]
	mgr.mu.Unlock()
	if !ok {
		t.Fatal("expected test-dongle to be in active dongles map")
	}

	mgr.Stop()

	// Verify cleanup
	mgr.mu.Lock()
	count := len(mgr.dongles)
	mgr.mu.Unlock()
	if count != 0 {
		t.Fatalf("expected 0 active dongles after Stop(), got %d", count)
	}
}

func TestManagerSkipsDisabledDongle(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))

	cfg := &config.Config{
		Dongles: []config.DongleConfig{
			{
				ID:        "disabled-dongle",
				Enabled:   false,
				AutoStart: true,
				Profiles: []config.DongleProfile{
					{
						ID:         "p1",
						SampleRate: 2400000,
						FftSize:    4096,
						FftFps:     30,
						Mode:       "wfm",
					},
				},
			},
		},
	}

	wsMgr := ws.NewManager(logger)
	mgr := NewManager(cfg, wsMgr, logger)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	err := mgr.Start(ctx)
	if err != nil {
		t.Fatalf("Start() error: %v", err)
	}

	mgr.mu.Lock()
	count := len(mgr.dongles)
	mgr.mu.Unlock()
	if count != 0 {
		t.Fatalf("expected 0 active dongles for disabled dongle, got %d", count)
	}

	mgr.Stop()
}

func TestManagerNoDongles(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))

	cfg := &config.Config{
		Dongles: []config.DongleConfig{},
	}

	wsMgr := ws.NewManager(logger)
	mgr := NewManager(cfg, wsMgr, logger)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	err := mgr.Start(ctx)
	if err != nil {
		t.Fatalf("Start() error: %v", err)
	}

	mgr.Stop()
}
