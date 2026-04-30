//go:build integration

package test

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/gbozo/no-sdr/serverng/internal/api"
	"github.com/gbozo/no-sdr/serverng/internal/config"
	"github.com/gbozo/no-sdr/serverng/internal/dongle"
	"github.com/gbozo/no-sdr/serverng/internal/ws"
)

// TestFullPipeline starts the server in demo mode and verifies:
// 1. HTTP health endpoint responds
// 2. /api/dongles returns running dongle
// 3. WebSocket connects successfully
// 4. After subscribe, META message received
// 5. FFT frames arrive (correct type byte)
// 6. After audio_enabled + tune, IQ frames arrive
func TestFullPipeline(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelDebug,
	}))

	// Create config with demo dongle
	cfg := &config.Config{
		Server: config.ServerConfig{
			Port:          0, // unused with httptest
			Host:          "127.0.0.1",
			AdminPassword: "test",
		},
		Dongles: []config.DongleConfig{
			{
				ID:        "test-demo",
				Name:      "Test Demo Dongle",
				Enabled:   true,
				AutoStart: true,
				Source: config.SourceConfig{
					Type: "demo",
				},
				SampleRate: 2400000,
				Profiles: []config.DongleProfile{
					{
						ID:              "fm-test",
						Name:            "FM Test",
						CenterFrequency: 100000000, // 100 MHz
						SampleRate:      2400000,
						Bandwidth:       150000,
						Mode:            "wfm",
						FftSize:         4096,
						FftFps:          30,
					},
				},
			},
		},
	}

	// Create WS Manager + Dongle Manager + Router
	wsMgr := ws.NewManager(logger)
	dongleMgr := dongle.NewManager(cfg, wsMgr, logger)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := dongleMgr.Start(ctx); err != nil {
		t.Fatalf("failed to start dongle manager: %v", err)
	}
	defer dongleMgr.Stop()

	router := api.NewRouter(wsMgr, cfg, logger, "")

	// Start httptest.Server
	srv := httptest.NewServer(router)
	defer srv.Close()

	// --- Test 1: Health endpoint responds ---
	t.Run("health", func(t *testing.T) {
		resp, err := http.Get(srv.URL + "/health")
		if err != nil {
			t.Fatalf("health request failed: %v", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("expected 200, got %d", resp.StatusCode)
		}
	})

	// --- Test 2: /api/dongles returns running dongle ---
	t.Run("dongles_api", func(t *testing.T) {
		resp, err := http.Get(srv.URL + "/api/dongles")
		if err != nil {
			t.Fatalf("dongles request failed: %v", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("expected 200, got %d", resp.StatusCode)
		}
		var dongles []map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&dongles); err != nil {
			t.Fatalf("failed to decode dongles: %v", err)
		}
		if len(dongles) == 0 {
			t.Fatal("expected at least 1 dongle")
		}
		if dongles[0]["id"] != "test-demo" {
			t.Fatalf("expected dongle id 'test-demo', got %v", dongles[0]["id"])
		}
	})

	// --- Tests 3-7: WebSocket lifecycle ---
	t.Run("websocket_lifecycle", func(t *testing.T) {
		wsURL := "ws" + srv.URL[4:] + "/ws" // http:// → ws://

		wsCtx, wsCancel := context.WithTimeout(ctx, 10*time.Second)
		defer wsCancel()

		conn, _, err := websocket.Dial(wsCtx, wsURL, nil)
		if err != nil {
			t.Fatalf("websocket dial failed: %v", err)
		}
		defer conn.Close(websocket.StatusNormalClosure, "")

		// --- Test 4: Send subscribe → verify META (type 0x03) ---
		subscribeMsg := `{"cmd":"subscribe","dongleId":"test-demo"}`
		if err := conn.Write(wsCtx, websocket.MessageText, []byte(subscribeMsg)); err != nil {
			t.Fatalf("subscribe write failed: %v", err)
		}

		// Read messages until we get META
		metaReceived := false
		fftReceived := false
		iqReceived := false

		// Wait for META message (type 0x03)
		for i := 0; i < 50; i++ {
			_, data, err := conn.Read(wsCtx)
			if err != nil {
				t.Fatalf("read failed: %v", err)
			}
			if len(data) > 0 && data[0] == 0x03 {
				metaReceived = true
				// Verify META payload is valid JSON
				var meta map[string]any
				if err := json.Unmarshal(data[1:], &meta); err != nil {
					t.Fatalf("META payload is not valid JSON: %v", err)
				}
				if meta["dongleId"] != "test-demo" {
					t.Fatalf("expected dongleId 'test-demo', got %v", meta["dongleId"])
				}
				break
			}
		}
		if !metaReceived {
			t.Fatal("META message (0x03) not received within 50 reads")
		}

		// --- Test 5: Wait for FFT frame (type 0x04, 0x08, or 0x0B) ---
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			readCtx, readCancel := context.WithTimeout(wsCtx, 500*time.Millisecond)
			_, data, err := conn.Read(readCtx)
			readCancel()
			if err != nil {
				continue
			}
			if len(data) > 0 {
				switch data[0] {
				case 0x04, 0x08, 0x0B:
					fftReceived = true
				}
			}
			if fftReceived {
				break
			}
		}
		if !fftReceived {
			t.Fatal("FFT frame (0x04/0x08/0x0B) not received within 2 seconds")
		}

		// --- Test 6-7: Send audio_enabled → tune → verify IQ frame (type 0x09) ---
		audioEnableMsg := `{"cmd":"audio_enabled","enabled":true}`
		if err := conn.Write(wsCtx, websocket.MessageText, []byte(audioEnableMsg)); err != nil {
			t.Fatalf("audio_enabled write failed: %v", err)
		}

		// Small delay to let the pipeline initialize
		time.Sleep(50 * time.Millisecond)

		tuneMsg := `{"cmd":"tune","offset":100000}`
		if err := conn.Write(wsCtx, websocket.MessageText, []byte(tuneMsg)); err != nil {
			t.Fatalf("tune write failed: %v", err)
		}

		// Wait for IQ ADPCM frame (type 0x09)
		deadline = time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			readCtx, readCancel := context.WithTimeout(wsCtx, 500*time.Millisecond)
			_, data, err := conn.Read(readCtx)
			readCancel()
			if err != nil {
				continue
			}
			if len(data) > 0 {
				switch data[0] {
				case 0x02, 0x09, 0x0C:
					iqReceived = true
				}
			}
			if iqReceived {
				break
			}
		}
		if !iqReceived {
			t.Fatal("IQ frame (0x02/0x09/0x0C) not received within 3 seconds")
		}
	})
}
