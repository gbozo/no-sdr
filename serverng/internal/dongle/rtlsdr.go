//go:build rtlsdr

package dongle

import (
	"context"
	"fmt"
	"log/slog"

	rtl "github.com/jpoirier/gortlsdr"
)

// LocalDeviceInfo describes a locally-attached RTL-SDR dongle.
type LocalDeviceInfo struct {
	Index   int    `json:"index"`
	Name    string `json:"name"`
	Serial  string `json:"serial"`
	Product string `json:"product"`
	Manufact string `json:"manufact"`
}

// EnumerateLocalDevices returns info about every RTL-SDR visible to librtlsdr.
// Returns an empty slice (not an error) when no devices are found.
func EnumerateLocalDevices() []LocalDeviceInfo {
	count := rtl.GetDeviceCount()
	out := make([]LocalDeviceInfo, 0, count)
	for i := 0; i < count; i++ {
		manufact, product, serial, err := rtl.GetDeviceUsbStrings(i)
		if err != nil {
			manufact, product, serial = "", "", ""
		}
		out = append(out, LocalDeviceInfo{
			Index:    i,
			Name:     rtl.GetDeviceName(i),
			Serial:   serial,
			Product:  product,
			Manufact: manufact,
		})
	}
	return out
}

// RtlSdrSource reads IQ directly from a local USB RTL-SDR dongle.
// Build with: go build -tags rtlsdr
type RtlSdrSource struct {
	device    *rtl.Context
	deviceIdx int
	logger    *slog.Logger
}

// RtlSdrConfig configures a local RTL-SDR source.
type RtlSdrConfig struct {
	// DeviceIndex is used when Serial is empty.
	DeviceIndex int
	// Serial selects the dongle by EEPROM serial string; takes precedence over DeviceIndex.
	Serial string
	Logger *slog.Logger
}

// NewRtlSdrSource creates a new local RTL-SDR source.
func NewRtlSdrSource(cfg RtlSdrConfig) *RtlSdrSource {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	idx := cfg.DeviceIndex
	if cfg.Serial != "" {
		if resolved, err := rtl.GetIndexBySerial(cfg.Serial); err == nil {
			idx = resolved
		} else {
			cfg.Logger.Warn("rtlsdr: serial not found, falling back to device index",
				"serial", cfg.Serial, "fallback", cfg.DeviceIndex, "error", err)
		}
	}
	return &RtlSdrSource{
		deviceIdx: idx,
		logger:    cfg.Logger,
	}
}

// Open opens the RTL-SDR device.
func (r *RtlSdrSource) Open() error {
	dev, err := rtl.Open(r.deviceIdx)
	if err != nil {
		return fmt.Errorf("rtlsdr open device %d: %w", r.deviceIdx, err)
	}
	r.device = dev
	r.logger.Info("rtlsdr device opened", "index", r.deviceIdx)
	return nil
}

// Run starts async reading from the RTL-SDR and sends IQ chunks to out.
// Blocks until context is cancelled or a read error occurs.
func (r *RtlSdrSource) Run(ctx context.Context, out chan<- []byte) {
	if r.device == nil {
		r.logger.Error("rtlsdr Run called without Open")
		return
	}

	// Reset the endpoint before streaming
	if err := r.device.ResetBuffer(); err != nil {
		r.logger.Error("rtlsdr reset buffer", "error", err)
		return
	}

	const chunkSize = 16384 // ~3.4ms at 2.4 MSPS

	// Use synchronous read in a loop (simpler than async callback)
	buf := make([]byte, chunkSize)
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		n, err := r.device.ReadSync(buf, chunkSize)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			r.logger.Error("rtlsdr read error", "error", err)
			return
		}
		if n == 0 {
			continue
		}

		chunk := make([]byte, n)
		copy(chunk, buf[:n])

		select {
		case out <- chunk:
		case <-ctx.Done():
			return
		}
	}
}

// Close closes the RTL-SDR device.
func (r *RtlSdrSource) Close() error {
	if r.device == nil {
		return nil
	}
	err := r.device.Close()
	r.device = nil
	return err
}

// SetFrequency sets the center frequency (Hz).
func (r *RtlSdrSource) SetFrequency(hz uint32) error {
	if r.device == nil {
		return fmt.Errorf("rtlsdr not open")
	}
	return r.device.SetCenterFreq(int(hz))
}

// SetSampleRate sets the sample rate (Hz).
func (r *RtlSdrSource) SetSampleRate(hz uint32) error {
	if r.device == nil {
		return fmt.Errorf("rtlsdr not open")
	}
	return r.device.SetSampleRate(int(hz))
}

// SetGain sets the tuner gain (in tenths of dB).
func (r *RtlSdrSource) SetGain(tenthsDb int) error {
	if r.device == nil {
		return fmt.Errorf("rtlsdr not open")
	}
	return r.device.SetTunerGain(tenthsDb)
}

// SetGainMode sets manual (true) or automatic (false) gain control.
func (r *RtlSdrSource) SetGainMode(manual bool) error {
	if r.device == nil {
		return fmt.Errorf("rtlsdr not open")
	}
	mode := 0
	if manual {
		mode = 1
	}
	return r.device.SetTunerGainMode(mode)
}

// SetDirectSampling sets direct sampling mode (0=off, 1=I-ADC, 2=Q-ADC).
func (r *RtlSdrSource) SetDirectSampling(mode int) error {
	if r.device == nil {
		return fmt.Errorf("rtlsdr not open")
	}
	return r.device.SetDirectSampling(mode)
}

// SetBiasT enables or disables the bias-T voltage on the antenna port.
func (r *RtlSdrSource) SetBiasT(enabled bool) error {
	if r.device == nil {
		return fmt.Errorf("rtlsdr not open")
	}
	val := 0
	if enabled {
		val = 1
	}
	return r.device.SetBiasTee(val)
}

// SetAgc enables or disables the RTL2832U internal AGC.
func (r *RtlSdrSource) SetAgc(enabled bool) error {
	if r.device == nil {
		return fmt.Errorf("rtlsdr not open")
	}
	val := 0
	if enabled {
		val = 1
	}
	return r.device.SetAgcMode(val)
}
