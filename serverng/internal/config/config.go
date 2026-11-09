// Package config loads and validates the node-sdr YAML configuration.
package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"

	"gopkg.in/yaml.v3"
)

// ConfigVersion tracks the in-memory config revision number.
// It increments on every mutation (dongle/profile/server CRUD).
// Used for optimistic concurrency: clients send the version they loaded,
// and the server rejects saves if the version has advanced (409 Conflict).
type ConfigVersion struct {
	v atomic.Uint64
}

// NewConfigVersion creates a new version counter starting at 1.
func NewConfigVersion() *ConfigVersion {
	cv := &ConfigVersion{}
	cv.v.Store(1)
	return cv
}

// Get returns the current version number.
func (cv *ConfigVersion) Get() uint64 {
	return cv.v.Load()
}

// Increment bumps the version and returns the new value.
func (cv *ConfigVersion) Increment() uint64 {
	return cv.v.Add(1)
}

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
	Server    ServerConfig   `yaml:"server"`
	Dongles   []DongleConfig `yaml:"dongles"`
	Bookmarks []Bookmark     `yaml:"bookmarks"`
}

// Bookmark is a user-defined frequency/mode preset for quick navigation.
type Bookmark struct {
	ID          string `yaml:"id"          json:"id"`
	Name        string `yaml:"name"        json:"name"`
	Frequency   int64  `yaml:"frequency"   json:"frequency"`
	Mode        string `yaml:"mode"        json:"mode"`
	Bandwidth   int    `yaml:"bandwidth"   json:"bandwidth,omitempty"`
	Description string `yaml:"description" json:"description,omitempty"`
}

// ServerConfig holds HTTP server and admin settings.
type ServerConfig struct {
	Port                  int    `yaml:"port"                  json:"port"`
	Host                  string `yaml:"host"                  json:"host"`
	AdminPassword         string `yaml:"adminPassword"         json:"adminPassword"`
	Callsign              string `yaml:"callsign"              json:"callsign"`
	Description           string `yaml:"description"           json:"description"`
	Location              string `yaml:"location"              json:"location"`
	DemoMode              bool   `yaml:"demoMode"              json:"demoMode"`
	FftHistoryFftSize     int    `yaml:"fftHistoryFftSize"     json:"fftHistoryFftSize"`
	FftHistoryCompression string `yaml:"fftHistoryCompression" json:"fftHistoryCompression"`
	// AllowedFftCodecs lists the FFT codecs the server will accept from clients.
	// Defaults to all supported codecs. Admin can restrict or re-enable at runtime.
	AllowedFftCodecs []string `yaml:"allowedFftCodecs" json:"allowedFftCodecs"`
	// AllowedIqCodecs lists the IQ/audio codecs the server will accept.
	// Opus variants are automatically removed if the binary was built without libopus.
	AllowedIqCodecs []string `yaml:"allowedIqCodecs" json:"allowedIqCodecs"`
	// OpusComplexity sets the libopus encoder complexity for all Opus pipelines.
	// Range: 0 (fastest, lowest quality) to 10 (slowest, highest quality).
	// Default: 5. At 32kbps this is perceptually transparent for radio audio
	// and cuts encode CPU by ~30% compared to the libopus default of 10.
	OpusComplexity int `yaml:"opusComplexity" json:"opusComplexity"`

	// RealIPHeader is the HTTP header to read the client's real IP from when the
	// server sits behind a reverse proxy or tunnel (e.g. Cloudflare, nginx).
	// Common values: "CF-Connecting-IP", "X-Real-IP", "X-Forwarded-For".
	// A custom header name is also accepted.
	// When empty (default) the TCP RemoteAddr is used as-is.
	RealIPHeader string `yaml:"realIPHeader" json:"realIPHeader"`

	// Music recognition API keys (optional).
	// AudD is the primary service; ACRCloud is the fallback for higher coverage.
	AuddAPIKey           string `yaml:"auddApiKey"           json:"-"` // https://audd.io
	ACRCloudHost         string `yaml:"acrcloudHost"         json:"-"` // e.g. identify-eu-west-1.acrcloud.com
	ACRCloudAccessKey    string `yaml:"acrcloudAccessKey"    json:"-"`
	ACRCloudAccessSecret string `yaml:"acrcloudAccessSecret" json:"-"`
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
	Type        string `yaml:"type"        json:"type"`
	Host        string `yaml:"host"        json:"host"`
	Port        int    `yaml:"port"        json:"port"`
	DeviceIndex int    `yaml:"deviceIndex" json:"deviceIndex"`
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
	// DCOffsetRemoval enables the IIR high-pass DC offset blocker on raw IQ input.
	// Removes the center-frequency DC spike common on RTL-SDR hardware. Default: true.
	// Use a pointer so YAML explicit false is preserved (zero-value bool is ambiguous).
	DCOffsetRemoval *bool `yaml:"dcOffsetRemoval"      json:"dcOffsetRemoval"`
}

// Load reads the config file at path and returns a validated Config.
// If the file does not exist, creates a default config file and returns it.
func Load(path string) (*Config, error) {
	cfg := &Config{}
	applyDefaults(cfg)

	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			// First boot: write default config to disk so admin can edit it
			if writeErr := writeDefaultConfig(path, cfg); writeErr != nil {
				// Non-fatal: log but continue with in-memory defaults
				fmt.Fprintf(os.Stderr, "config: warning: could not write default config to %s: %v\n", path, writeErr)
			}
			return cfg, nil
		}
		return nil, fmt.Errorf("config: read file: %w", err)
	}

	// YAML `enabled`/`autoStart` default to true when absent, but an
	// explicit `false` must be preserved.
	if patched, err := applyYAMLPresenceDefaults(data); err == nil {
		data = patched
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

// writeDefaultConfig writes a minimal default config file to disk.
func writeDefaultConfig(path string, cfg *Config) error {
	// Ensure the directory exists
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}

	// Set a default admin password for first boot
	if cfg.Server.AdminPassword == "" {
		cfg.Server.AdminPassword = "admin"
	}

	data, err := yaml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("marshal default config: %w", err)
	}

	header := []byte("# node-sdr configuration (auto-generated on first boot)\n# See AGENTS.md for configuration reference.\n\n")
	content := append(header, data...)

	if err := os.WriteFile(path, content, 0644); err != nil {
		return fmt.Errorf("write config file: %w", err)
	}

	return nil
}

// DefaultFftCodecs lists all FFT codecs supported by the server.
var DefaultFftCodecs = []string{"none", "adpcm", "deflate", "deflate-floor"}

// DefaultIqCodecs lists all IQ/audio codecs supported by the server.
var DefaultIqCodecs = []string{"none", "adpcm", "opus-lo", "opus", "opus-hq"}

// applyYAMLPresenceDefaults injects enabled/autoStart=true for dongles that
// omit them, so an explicit `false` is meaningful.
func applyYAMLPresenceDefaults(data []byte) ([]byte, error) {
	var root yaml.Node
	if err := yaml.Unmarshal(data, &root); err != nil {
		return nil, err
	}
	if len(root.Content) == 0 {
		return data, nil
	}
	doc := root.Content[0]
	if doc.Kind != yaml.MappingNode {
		return data, nil
	}
	for i := 0; i+1 < len(doc.Content); i += 2 {
		if doc.Content[i].Value != "dongles" {
			continue
		}
		seq := doc.Content[i+1]
		if seq.Kind != yaml.SequenceNode {
			continue
		}
		for _, dongle := range seq.Content {
			if dongle.Kind != yaml.MappingNode {
				continue
			}
			setMappingDefault(dongle, "enabled", "true")
			setMappingDefault(dongle, "autoStart", "true")
		}
	}
	return yaml.Marshal(&root)
}

func setMappingDefault(node *yaml.Node, key, value string) {
	for i := 0; i+1 < len(node.Content); i += 2 {
		if node.Content[i].Value == key {
			return
		}
	}
	node.Content = append(node.Content,
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key},
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: value},
	)
}

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
	// OpusComplexity: default to 5 (balanced CPU vs quality for radio audio).
	// Use -1 as sentinel for "not configured"; 0 is a valid libopus complexity level.
	if cfg.Server.OpusComplexity < 0 {
		cfg.Server.OpusComplexity = 5
	}
	// Dongles default to enabled + autoStart in applyYAMLPresenceDefaults;
	// do not force them here so explicit false survives a reload.
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
			// DCOffsetRemoval defaults to true when not explicitly set in YAML.
			if p.DCOffsetRemoval == nil {
				t := true
				p.DCOffsetRemoval = &t
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
