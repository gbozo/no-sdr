//go:build !rtlsdr

package dongle

import (
	"context"
	"errors"
	"log/slog"
)

// RtlSdrSource is a stub when compiled without the rtlsdr build tag.
type RtlSdrSource struct{}

// RtlSdrConfig configures a local RTL-SDR source.
type RtlSdrConfig struct {
	DeviceIndex int
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
func (r *RtlSdrSource) SetGain(tenthsDb int) error { return nil }

// SetGainMode is a no-op in the stub.
func (r *RtlSdrSource) SetGainMode(manual bool) error { return nil }

// SetDirectSampling is a no-op in the stub.
func (r *RtlSdrSource) SetDirectSampling(mode int) error { return nil }

// SetBiasT is a no-op in the stub.
func (r *RtlSdrSource) SetBiasT(enabled bool) error { return nil }

// SetAgc is a no-op in the stub.
func (r *RtlSdrSource) SetAgc(enabled bool) error { return nil }
