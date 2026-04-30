package config

import (
	"os"
	"path/filepath"
	"testing"
)

const validYAML = `
server:
  port: 8080
  host: "127.0.0.1"
  adminPassword: "secret"
dongles:
  - id: "dongle-0"
    name: "Test SDR"
    enabled: true
    autoStart: true
    source:
      type: "demo"
    profiles:
      - id: "fm-broadcast"
        name: "FM Broadcast"
        centerFrequency: 100000000
        sampleRate: 2400000
        defaultBandwidth: 200000
        defaultMode: "wfm"
        gain: 49.6
        fftSize: 4096
        fftFps: 30
        defaultTuneOffset: 0
`

func TestLoadValidYAML(t *testing.T) {
	path := writeTempFile(t, "config-valid-*.yaml", validYAML)

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if cfg.Server.Port != 8080 {
		t.Errorf("expected port 8080, got %d", cfg.Server.Port)
	}
	if cfg.Server.Host != "127.0.0.1" {
		t.Errorf("expected host 127.0.0.1, got %s", cfg.Server.Host)
	}
	if len(cfg.Dongles) != 1 {
		t.Fatalf("expected 1 dongle, got %d", len(cfg.Dongles))
	}
	if cfg.Dongles[0].Profiles[0].Mode != "wfm" {
		t.Errorf("expected mode wfm, got %s", cfg.Dongles[0].Profiles[0].Mode)
	}
}

func TestDefaultValues(t *testing.T) {
	yaml := `
dongles:
  - id: "d1"
    name: "D1"
    enabled: true
    source:
      type: "demo"
    profiles:
      - id: "p1"
        name: "P1"
        centerFrequency: 100000000
        sampleRate: 2400000
        defaultBandwidth: 200000
`
	path := writeTempFile(t, "config-defaults-*.yaml", yaml)

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if cfg.Server.Port != 3000 {
		t.Errorf("expected default port 3000, got %d", cfg.Server.Port)
	}
	if cfg.Server.Host != "0.0.0.0" {
		t.Errorf("expected default host 0.0.0.0, got %s", cfg.Server.Host)
	}

	p := cfg.Dongles[0].Profiles[0]
	if p.FftFps != 30 {
		t.Errorf("expected default fftFps 30, got %d", p.FftFps)
	}
	if p.FftSize != 4096 {
		t.Errorf("expected default fftSize 4096, got %d", p.FftSize)
	}
	if p.Mode != "wfm" {
		t.Errorf("expected default mode wfm, got %s", p.Mode)
	}
}

func TestInvalidFftSize(t *testing.T) {
	yaml := `
dongles:
  - id: "d1"
    name: "D1"
    enabled: true
    source:
      type: "demo"
    profiles:
      - id: "p1"
        name: "P1"
        centerFrequency: 100000000
        sampleRate: 2400000
        defaultBandwidth: 200000
        defaultMode: "am"
        fftSize: 3000
`
	path := writeTempFile(t, "config-badfft-*.yaml", yaml)

	_, err := Load(path)
	if err == nil {
		t.Fatal("expected error for invalid fftSize, got nil")
	}
}

func TestMissingFileReturnsDefaults(t *testing.T) {
	cfg, err := Load("/nonexistent/path/config.yaml")
	if err != nil {
		t.Fatalf("unexpected error for missing file: %v", err)
	}

	if cfg.Server.Port != 3000 {
		t.Errorf("expected default port 3000, got %d", cfg.Server.Port)
	}
	if len(cfg.Dongles) != 0 {
		t.Errorf("expected empty dongles, got %d", len(cfg.Dongles))
	}
}

func TestInvalidMode(t *testing.T) {
	yaml := `
dongles:
  - id: "d1"
    name: "D1"
    enabled: true
    source:
      type: "demo"
    profiles:
      - id: "p1"
        name: "P1"
        centerFrequency: 100000000
        sampleRate: 2400000
        defaultBandwidth: 200000
        defaultMode: "invalid-mode"
        fftSize: 4096
`
	path := writeTempFile(t, "config-badmode-*.yaml", yaml)

	_, err := Load(path)
	if err == nil {
		t.Fatal("expected error for invalid mode, got nil")
	}
}

func writeTempFile(t *testing.T, pattern, content string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, pattern)
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("failed to write temp file: %v", err)
	}
	return path
}
