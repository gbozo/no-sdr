//go:build !rtlsdr

package dongle

import (
	"context"
	"errors"
	"log/slog"
)

// LocalDeviceInfo describes a locally-attached RTL-SDR dongle.
type LocalDeviceInfo struct {
	Index    int    `json:"index"`
	Name     string `json:"name"`
	Serial   string `json:"serial"`
	Product  string `json:"product"`
	Manufact string `json:"manufact"`
}

// EnumerateLocalDevices returns an empty slice when rtlsdr support is not compiled in.
func EnumerateLocalDevices() []LocalDeviceInfo { return nil }

// RtlSdrSource is a stub when compiled without the rtlsdr build tag.
type RtlSdrSource struct{}

// RtlSdrConfig configures a local RTL-SDR source.
type RtlSdrConfig struct {
	DeviceIndex int
	Serial      string
	Logger      *slog.Logger
}

// NewRtlSdrSource returns a stub (build with -tags rtlsdr for real hardware support).
func NewRtlSdrSource(cfg RtlSdrConfig) *RtlSdrSource { return &RtlSdrSource{} }

// Open returns an error indicating rtlsdr support is not compiled in.
func (r *RtlSdrSource) Open() error {
	return errors.New("rtlsdr support not compiled (build with -tags rtlsdr)")
}

// Run is a no-op in the stub.
func (r *RtlSdrSource) Run(ctx context.Context, out chan<- []byte) {}

// Close is a no-op in the stub.
func (r *RtlSdrSource) Close() error { return nil }

// SetFrequency is a no-op in the stub.
func (r *RtlSdrSource) SetFrequency(hz uint32) error { return nil }

// SetSampleRate is a no-op in the stub.
func (r *RtlSdrSource) SetSampleRate(hz uint32) error { return nil }

// SetGain is a no-op in the stub.
func (r *RtlSdrSource) SetGain(tenthsDb uint32) error { return nil }

// SetGainMode is a no-op in the stub.
func (r *RtlSdrSource) SetGainMode(mode uint32) error { return nil }

// SetDirectSampling is a no-op in the stub.
func (r *RtlSdrSource) SetDirectSampling(mode uint32) error { return nil }

// SetBiasT is a no-op in the stub.
func (r *RtlSdrSource) SetBiasT(enabled uint32) error { return nil }

// SetAgcMode is a no-op in the stub.
func (r *RtlSdrSource) SetAgcMode(mode uint32) error { return nil }

// SetOffsetTuning is a no-op in the stub.
func (r *RtlSdrSource) SetOffsetTuning(mode uint32) error { return nil }

// SetFrequencyCorrection is a no-op in the stub.
func (r *RtlSdrSource) SetFrequencyCorrection(ppm uint32) error { return nil }
