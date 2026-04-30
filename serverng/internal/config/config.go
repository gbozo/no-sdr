// Package config loads and validates the node-sdr YAML configuration.
package config

import (
	"errors"
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// Valid demodulation modes.
var validModes = map[string]bool{
	"wfm":       true,
	"nfm":       true,
	"am":        true,
	"am-stereo": true,
	"usb":       true,
	"lsb":       true,
	"cw":        true,
	"raw":       true,
	"sam":       true,
}

// Config is the top-level configuration.
type Config struct {
	Server  ServerConfig   `yaml:"server"`
	Dongles []DongleConfig `yaml:"dongles"`
}

// ServerConfig holds HTTP server and admin settings.
type ServerConfig struct {
	Port                  int    `yaml:"port"`
	Host                  string `yaml:"host"`
	AdminPassword         string `yaml:"adminPassword"`
	Callsign              string `yaml:"callsign"`
	Description           string `yaml:"description"`
	Location              string `yaml:"location"`
	DemoMode              bool   `yaml:"demoMode"`
	FftHistoryFftSize     int    `yaml:"fftHistoryFftSize"`
	FftHistoryCompression string `yaml:"fftHistoryCompression"`
}

// DongleConfig describes an SDR dongle and its profiles.
type DongleConfig struct {
	ID             string         `yaml:"id"`
	Name           string         `yaml:"name"`
	Enabled        bool           `yaml:"enabled"`
	AutoStart      bool           `yaml:"autoStart"`
	Source         SourceConfig   `yaml:"source"`
	SampleRate     int            `yaml:"sampleRate"`
	Gain           float64        `yaml:"gain"`
	PPM            int            `yaml:"ppmCorrection"`
	DeviceIndex    int            `yaml:"deviceIndex"`
	DirectSampling int            `yaml:"directSampling"`
	BiasT          bool           `yaml:"biasT"`
	DigitalAgc     bool           `yaml:"digitalAgc"`
	OffsetTuning   bool           `yaml:"offsetTuning"`
	Profiles       []DongleProfile `yaml:"profiles"`
}

// SourceConfig describes how to connect to the SDR hardware.
type SourceConfig struct {
	Type        string   `yaml:"type"`
	Host        string   `yaml:"host"`
	Port        int      `yaml:"port"`
	DeviceIndex int      `yaml:"deviceIndex"`
	Binary      string   `yaml:"binary"`
	ExtraArgs   []string `yaml:"extraArgs"`
}

// DongleProfile is a frequency/mode preset for a dongle.
type DongleProfile struct {
	ID                    string  `yaml:"id"`
	Name                  string  `yaml:"name"`
	CenterFrequency       int64   `yaml:"centerFrequency"`
	SampleRate            int     `yaml:"sampleRate"`
	Bandwidth             int     `yaml:"defaultBandwidth"`
	Mode                  string  `yaml:"defaultMode"`
	Gain                  float64 `yaml:"gain"`
	FftSize               int     `yaml:"fftSize"`
	FftFps                int     `yaml:"fftFps"`
	TuneOffset            int     `yaml:"defaultTuneOffset"`
	TuningStep            int     `yaml:"tuningStep"`
	SwapIQ                bool    `yaml:"swapIQ"`
	OscillatorOffset      int     `yaml:"oscillatorOffset"`
	DirectSampling        int     `yaml:"directSampling"`
	Description           string  `yaml:"description"`
	DongleID              string  `yaml:"dongleId"`
	PreFilterNb           bool    `yaml:"preFilterNb"`
	PreFilterNbThreshold  int     `yaml:"preFilterNbThreshold"`
}

// Load reads the config file at path and returns a validated Config.
// If the file does not exist, returns a Config with defaults and empty dongles.
func Load(path string) (*Config, error) {
	cfg := &Config{}
	applyDefaults(cfg)

	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return cfg, nil
		}
		return nil, fmt.Errorf("config: read file: %w", err)
	}

	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("config: parse yaml: %w", err)
	}

	applyDefaults(cfg)
	applyProfileDefaults(cfg)

	if err := validate(cfg); err != nil {
		return nil, err
	}

	return cfg, nil
}

func applyDefaults(cfg *Config) {
	if cfg.Server.Port == 0 {
		cfg.Server.Port = 3000
	}
	if cfg.Server.Host == "" {
		cfg.Server.Host = "0.0.0.0"
	}
	// Dongles default to enabled + autoStart (matches Node.js behavior)
	for i := range cfg.Dongles {
		// If not explicitly set in YAML, default to true
		// Go zero-value for bool is false, so we always default to true here
		// (the YAML can explicitly set enabled: false to disable)
		cfg.Dongles[i].Enabled = true
		cfg.Dongles[i].AutoStart = true
	}
}

func applyProfileDefaults(cfg *Config) {
	for i := range cfg.Dongles {
		for j := range cfg.Dongles[i].Profiles {
			p := &cfg.Dongles[i].Profiles[j]
			if p.FftFps == 0 {
				p.FftFps = 30
			}
			if p.FftSize == 0 {
				p.FftSize = 4096
			}
			if p.Mode == "" {
				p.Mode = "wfm"
			}
		}
	}
}

func validate(cfg *Config) error {
	for i, d := range cfg.Dongles {
		for j, p := range d.Profiles {
			if !isPowerOf2(p.FftSize) || p.FftSize < 256 || p.FftSize > 131072 {
				return fmt.Errorf("config: dongle[%d].profiles[%d] (%s): fftSize must be power of 2 in [256, 131072], got %d",
					i, j, p.ID, p.FftSize)
			}
			if p.SampleRate <= 0 {
				return fmt.Errorf("config: dongle[%d].profiles[%d] (%s): sampleRate must be > 0, got %d",
					i, j, p.ID, p.SampleRate)
			}
			if !validModes[p.Mode] {
				return fmt.Errorf("config: dongle[%d].profiles[%d] (%s): invalid mode %q", i, j, p.ID, p.Mode)
			}
		}
	}
	return nil
}

func isPowerOf2(n int) bool {
	return n > 0 && (n&(n-1)) == 0
}
