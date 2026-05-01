//go:build integration

package test

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/gbozo/no-sdr/serverng/internal/api"
	"github.com/gbozo/no-sdr/serverng/internal/config"
	"github.com/gbozo/no-sdr/serverng/internal/dongle"
	"github.com/gbozo/no-sdr/serverng/internal/ws"
)

// setupIntegrationServer creates a test server with demo dongle for integration tests.
func setupIntegrationServer(t testing.TB) (*httptest.Server, *dongle.Manager) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelWarn,
	}))

	cfg := &config.Config{
		Server: config.ServerConfig{
			Port:                  0,
			Host:                  "127.0.0.1",
			AdminPassword:         "test",
			DemoMode:              true,
			FftHistoryFftSize:     1024,
			FftHistoryCompression: "none",
		},
		Dongles: []config.DongleConfig{
			{
				ID:        "test-dongle",
				Name:      "Test Demo",
				Enabled:   true,
				AutoStart: true,
				Source:    config.SourceConfig{Type: "demo"},
				SampleRate: 2400000,
				Profiles: []config.DongleProfile{
					{
						ID:              "test-profile",
						Name:            "Test FM",
						CenterFrequency: 100000000,
						SampleRate:      2400000,
						Bandwidth:       200000,
						Mode:            "wfm",
						FftSize:         4096,
						FftFps:          30,
					},
				},
			},
		},
	}

	wsMgr := ws.NewManager(logger)
	dongleMgr := dongle.NewManager(cfg, wsMgr, logger)
	api.ProfileSwitchFunc = dongleMgr.SwitchProfile
	api.DongleStartFunc = dongleMgr.StartDongleByID
	api.DongleStopFunc = dongleMgr.StopDongleByID

	router := api.NewRouter(wsMgr, cfg, logger, "")
	srv := httptest.NewServer(router)

	ctx := context.Background()
	if err := dongleMgr.Start(ctx); err != nil {
		t.Fatalf("failed to start dongle manager: %v", err)
	}

	t.Cleanup(func() {
		dongleMgr.Stop()
		wsMgr.Shutdown(ctx)
		srv.Close()
	})

	return srv, dongleMgr
}

func TestIntegration_FullPipeline(t *testing.T) {
	srv, _ := setupIntegrationServer(t)

	// 1. Health check
	resp, err := http.Get(srv.URL + "/health")
	if err != nil {
		t.Fatalf("health request failed: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("health: expected 200, got %d", resp.StatusCode)
	}

	// 2. Dongles API
	resp, err = http.Get(srv.URL + "/api/dongles")
	if err != nil {
		t.Fatalf("dongles request failed: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("dongles: expected 200, got %d", resp.StatusCode)
	}

	// 3. Connect WebSocket
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	wsURL := "ws" + srv.URL[4:] + "/ws"
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "done")

	// 4. Subscribe
	err = conn.Write(ctx, websocket.MessageText, []byte(`{"cmd":"subscribe","dongleId":"test-dongle"}`))
	if err != nil {
		t.Fatalf("subscribe write failed: %v", err)
	}

	// 5. Read META (subscribed)
	metaReceived := false
	for i := 0; i < 50; i++ {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read failed: %v", err)
		}
		if len(data) > 0 && data[0] == 0x03 {
			var meta map[string]any
			if err := json.Unmarshal(data[1:], &meta); err == nil {
				if meta["type"] == "subscribed" {
					metaReceived = true
					break
				}
			}
		}
	}
	if !metaReceived {
		t.Fatal("META 'subscribed' message not received")
	}

	// 6. Send codec preference
	conn.Write(ctx, websocket.MessageText, []byte(`{"cmd":"codec","fftCodec":"deflate","iqCodec":"adpcm"}`))

	// 7. Enable audio and tune to get IQ
	conn.Write(ctx, websocket.MessageText, []byte(`{"cmd":"audio_enabled","enabled":true}`))
	time.Sleep(50 * time.Millisecond)
	conn.Write(ctx, websocket.MessageText, []byte(`{"cmd":"tune","offset":100000}`))

	// 8. Wait for FFT and IQ frames
	fftReceived := false
	iqReceived := false
	deadline := time.After(5 * time.Second)

	for !fftReceived || !iqReceived {
		select {
		case <-deadline:
			if !fftReceived {
				t.Error("timeout waiting for FFT frame")
			}
			if !iqReceived {
				t.Error("timeout waiting for IQ frame")
			}
			return
		default:
		}

		readCtx, readCancel := context.WithTimeout(ctx, 500*time.Millisecond)
		_, data, err := conn.Read(readCtx)
		readCancel()
		if err != nil {
			continue
		}

		if len(data) == 0 {
			continue
		}

		msgType := data[0]
		switch msgType {
		case 0x0B: // MSG_FFT_DEFLATE
			if len(data) > 9 {
				binCount := binary.LittleEndian.Uint32(data[5:9])
				if binCount == 4096 {
					fftReceived = true
				}
			}
		case 0x04: // MSG_FFT_COMPRESSED
			fftReceived = true
		case 0x09: // MSG_IQ_ADPCM
			if len(data) > 5 {
				iqReceived = true
			}
		case 0x02: // MSG_IQ_RAW
			iqReceived = true
		}
	}

	t.Logf("Integration test passed: FFT=%v IQ=%v", fftReceived, iqReceived)
}

func TestIntegration_NoiseBlankerControl(t *testing.T) {
	srv, _ := setupIntegrationServer(t)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	wsURL := "ws" + srv.URL[4:] + "/ws"
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "done")

	// Subscribe
	conn.Write(ctx, websocket.MessageText, []byte(`{"cmd":"subscribe","dongleId":"test-dongle"}`))
	// Drain META messages
	for i := 0; i < 10; i++ {
		readCtx, readCancel := context.WithTimeout(ctx, 500*time.Millisecond)
		_, data, err := conn.Read(readCtx)
		readCancel()
		if err != nil {
			break
		}
		if len(data) > 0 && data[0] == 0x03 {
			break
		}
	}

	// Enable audio
	conn.Write(ctx, websocket.MessageText, []byte(`{"cmd":"audio_enabled","enabled":true}`))
	time.Sleep(100 * time.Millisecond)

	// Enable noise blanker
	conn.Write(ctx, websocket.MessageText, []byte(`{"cmd":"set_pre_filter_nb","enabled":true}`))
	conn.Write(ctx, websocket.MessageText, []byte(`{"cmd":"set_pre_filter_nb_threshold","level":8}`))

	// Should still receive IQ frames (NB doesn't block signal, just blanks impulses)
	conn.Write(ctx, websocket.MessageText, []byte(`{"cmd":"tune","offset":100000}`))

	iqReceived := false
	deadline := time.After(3 * time.Second)
	for !iqReceived {
		select {
		case <-deadline:
			t.Fatal("timeout waiting for IQ with NB enabled")
			return
		default:
		}

		readCtx, readCancel := context.WithTimeout(ctx, 500*time.Millisecond)
		_, data, err := conn.Read(readCtx)
		readCancel()
		if err != nil {
			continue
		}
		if len(data) > 0 && (data[0] == 0x09 || data[0] == 0x02) {
			iqReceived = true
		}
	}

	t.Log("NB control test passed: IQ received with NB enabled")
}

func BenchmarkLoad5Clients(b *testing.B) {
	srv, _ := setupIntegrationServer(b)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	wsURL := "ws" + srv.URL[4:] + "/ws"

	// Connect 5 clients, all subscribed and receiving FFT + IQ
	var totalFrames atomic.Int64
	conns := make([]*websocket.Conn, 5)

	for i := 0; i < 5; i++ {
		conn, _, err := websocket.Dial(ctx, wsURL, nil)
		if err != nil {
			b.Fatalf("client %d dial failed: %v", i, err)
		}
		conns[i] = conn

		// Drain welcome/server_stats
		readCtx, readCancel := context.WithTimeout(ctx, 2*time.Second)
		conn.Read(readCtx)
		readCancel()

		// Subscribe + enable audio
		conn.Write(ctx, websocket.MessageText, []byte(`{"cmd":"subscribe","dongleId":"test-dongle"}`))
		// Drain META
		readCtx, readCancel = context.WithTimeout(ctx, 2*time.Second)
		conn.Read(readCtx)
		readCancel()

		conn.Write(ctx, websocket.MessageText, []byte(`{"cmd":"codec","fftCodec":"deflate","iqCodec":"adpcm"}`))
		conn.Write(ctx, websocket.MessageText, []byte(`{"cmd":"audio_enabled","enabled":true}`))
		conn.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"cmd":"tune","offset":%d}`, i*50000)))

		// Reader goroutine — count frames
		go func(c *websocket.Conn) {
			for {
				_, _, err := c.Read(ctx)
				if err != nil {
					return
				}
				totalFrames.Add(1)
			}
		}(conn)
	}

	// Let it run for 5 seconds to measure throughput
	time.Sleep(5 * time.Second)

	frames := totalFrames.Load()
	b.ReportMetric(float64(frames)/5.0, "frames/sec")
	b.ReportMetric(float64(frames)/(5.0*5.0), "frames/sec/client")

	// Cleanup
	cancel()
	for _, c := range conns {
		if c != nil {
			c.Close(websocket.StatusNormalClosure, "")
		}
	}
}
