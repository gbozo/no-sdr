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
	Port                  int      `yaml:"port"                  json:"port"`
	Host                  string   `yaml:"host"                  json:"host"`
	AdminPassword         string   `yaml:"adminPassword"         json:"adminPassword"`
	Callsign              string   `yaml:"callsign"              json:"callsign"`
	Description           string   `yaml:"description"           json:"description"`
	Location              string   `yaml:"location"              json:"location"`
	DemoMode              bool     `yaml:"demoMode"              json:"demoMode"`
	FftHistoryFftSize     int      `yaml:"fftHistoryFftSize"     json:"fftHistoryFftSize"`
	FftHistoryCompression string   `yaml:"fftHistoryCompression" json:"fftHistoryCompression"`
	// AllowedFftCodecs lists the FFT codecs the server will accept from clients.
	// Defaults to all supported codecs. Admin can restrict or re-enable at runtime.
	AllowedFftCodecs []string `yaml:"allowedFftCodecs" json:"allowedFftCodecs"`
	// AllowedIqCodecs lists the IQ/audio codecs the server will accept.
	// Opus variants are automatically removed if the binary was built without libopus.
	AllowedIqCodecs []string `yaml:"allowedIqCodecs" json:"allowedIqCodecs"`
}

// DongleConfig describes an SDR dongle and its profiles.
type DongleConfig struct {
	ID             string          `yaml:"id"             json:"id"`
	Name           string          `yaml:"name"           json:"name"`
	Enabled        bool            `yaml:"enabled"        json:"enabled"`
	AutoStart      bool            `yaml:"autoStart"      json:"autoStart"`
	Source         SourceConfig    `yaml:"source"         json:"source"`
	SampleRate     int             `yaml:"sampleRate"     json:"sampleRate"`
	Gain           float64         `yaml:"gain"           json:"gain"`
	PPM            int             `yaml:"ppmCorrection"  json:"ppmCorrection"`
	DeviceIndex    int             `yaml:"deviceIndex"    json:"deviceIndex"`
	DirectSampling int             `yaml:"directSampling" json:"directSampling"`
	BiasT          bool            `yaml:"biasT"          json:"biasT"`
	DigitalAgc     bool            `yaml:"digitalAgc"     json:"digitalAgc"`
	OffsetTuning   bool            `yaml:"offsetTuning"   json:"offsetTuning"`
	Profiles       []DongleProfile `yaml:"profiles"       json:"profiles"`
}

// SourceConfig describes how to connect to the SDR hardware.
type SourceConfig struct {
	Type        string   `yaml:"type"        json:"type"`
	Host        string   `yaml:"host"        json:"host"`
	Port        int      `yaml:"port"        json:"port"`
	DeviceIndex int      `yaml:"deviceIndex" json:"deviceIndex"`
	// Serial is the EEPROM serial string of the local RTL-SDR dongle.
	// When set, the server resolves the device index at startup via librtlsdr
	// so that a specific stick is always opened regardless of USB enumeration order.
	// Takes precedence over DeviceIndex when both are set.
	Serial      string   `yaml:"serial"      json:"serial"`
	Binary      string   `yaml:"binary"      json:"binary"`
	ExtraArgs   []string `yaml:"extraArgs"   json:"extraArgs"`
	SpawnRtlTcp bool     `yaml:"spawnRtlTcp" json:"spawnRtlTcp"`
}

// DongleProfile is a frequency/mode preset for a dongle.
type DongleProfile struct {
	ID                   string  `yaml:"id"                   json:"id"`
	Name                 string  `yaml:"name"                 json:"name"`
	CenterFrequency      int64   `yaml:"centerFrequency"      json:"centerFrequency"`
	SampleRate           int     `yaml:"sampleRate"           json:"sampleRate"`
	Bandwidth            int     `yaml:"defaultBandwidth"     json:"bandwidth"`
	Mode                 string  `yaml:"defaultMode"          json:"mode"`
	Gain                 float64 `yaml:"gain"                 json:"gain"`
	FftSize              int     `yaml:"fftSize"              json:"fftSize"`
	FftFps               int     `yaml:"fftFps"               json:"fftFps"`
	TuneOffset           int     `yaml:"defaultTuneOffset"    json:"tuneOffset"`
	TuningStep           int     `yaml:"tuningStep"           json:"tuningStep"`
	SwapIQ               bool    `yaml:"swapIQ"               json:"swapIQ"`
	OscillatorOffset     int     `yaml:"oscillatorOffset"     json:"oscillatorOffset"`
	DirectSampling       int     `yaml:"directSampling"       json:"directSampling"`
	Description          string  `yaml:"description"          json:"description"`
	DongleID             string  `yaml:"dongleId"             json:"dongleId"`
	PreFilterNb          bool    `yaml:"preFilterNb"          json:"preFilterNb"`
	PreFilterNbThreshold int     `yaml:"preFilterNbThreshold" json:"preFilterNbThreshold"`
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

// DefaultFftCodecs lists all FFT codecs supported by the server.
var DefaultFftCodecs = []string{"none", "adpcm", "deflate", "deflate-floor"}

// DefaultIqCodecs lists all IQ/audio codecs supported by the server.
var DefaultIqCodecs = []string{"none", "adpcm", "opus", "opus-hq"}

func applyDefaults(cfg *Config) {
	if cfg.Server.Port == 0 {
		cfg.Server.Port = 3000
	}
	if cfg.Server.Host == "" {
		cfg.Server.Host = "0.0.0.0"
	}
	if len(cfg.Server.AllowedFftCodecs) == 0 {
		cfg.Server.AllowedFftCodecs = append([]string(nil), DefaultFftCodecs...)
	}
	if len(cfg.Server.AllowedIqCodecs) == 0 {
		cfg.Server.AllowedIqCodecs = append([]string(nil), DefaultIqCodecs...)
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
