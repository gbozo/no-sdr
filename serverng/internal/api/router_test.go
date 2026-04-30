package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gbozo/no-sdr/serverng/internal/config"
	"github.com/gbozo/no-sdr/serverng/internal/ws"
)

func TestHealthEndpoint(t *testing.T) {
	logger := slog.Default()
	wsMgr := ws.NewManager(logger)
	router := NewRouter(wsMgr, &config.Config{}, logger, "")

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if body["status"] != "ok" {
		t.Fatalf("expected status=ok, got %q", body["status"])
	}
}

func TestStatusEndpoint(t *testing.T) {
	logger := slog.Default()
	wsMgr := ws.NewManager(logger)
	router := NewRouter(wsMgr, &config.Config{}, logger, "")

	req := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if body["status"] != "ok" {
		t.Fatalf("expected status=ok, got %v", body["status"])
	}
	if _, ok := body["clients"]; !ok {
		t.Fatal("expected clients field")
	}
	if _, ok := body["uptime"]; !ok {
		t.Fatal("expected uptime field")
	}
}

func TestDonglesEndpoint(t *testing.T) {
	logger := slog.Default()
	wsMgr := ws.NewManager(logger)
	router := NewRouter(wsMgr, &config.Config{}, logger, "")

	req := httptest.NewRequest(http.MethodGet, "/api/dongles", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var body []any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if len(body) != 0 {
		t.Fatalf("expected empty array, got %v", body)
	}
}

func TestCORSHeaders(t *testing.T) {
	logger := slog.Default()
	wsMgr := ws.NewManager(logger)
	router := NewRouter(wsMgr, &config.Config{}, logger, "")

	req := httptest.NewRequest(http.MethodOptions, "/api/status", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204 for OPTIONS, got %d", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("expected CORS origin *, got %q", got)
	}
}
