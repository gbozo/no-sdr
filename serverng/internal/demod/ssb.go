package demod

import (
	"github.com/gbozo/no-sdr/serverng/internal/dsp"
)

// SsbDemod implements Single Sideband demodulation.
// Since the IQ extraction stage already places the desired sideband at baseband,
// SSB demodulation simply extracts the real component.
type SsbDemod struct {
	mode string // "usb" or "lsb"
}

func NewSsbDemod(mode string) *SsbDemod {
	return &SsbDemod{mode: mode}
}

func (s *SsbDemod) Name() string                            { return "ssb_" + s.mode }
func (s *SsbDemod) SampleRateOut(inputRate float64) float64 { return inputRate }
func (s *SsbDemod) Init(ctx dsp.BlockContext) error         { return nil }

func (s *SsbDemod) Process(in []complex64, out []float32) int {
	n := len(in)
	if len(out) < n {
		n = len(out)
	}
	for i := 0; i < n; i++ {
		out[i] = real(in[i])
	}
	return n
}

func (s *SsbDemod) Reset() {}
