package demod

import (
	"github.com/gbozo/no-sdr/serverng/internal/dsp"
)

// SsbDemod implements Single Sideband demodulation with DC blocking and AGC.
// Since the IQ extraction stage already places the desired sideband at baseband,
// SSB demodulation simply extracts the real component, then applies DC block + AGC.
// Matches Node.js SsbMonoDemod behaviour.
type SsbDemod struct {
	mode string // "usb" or "lsb"

	// DC blocking filter
	dcPrev    float32
	dcPrevOut float32

	// AGC — slower attack than AM for SSB
	agcGain   float32
	agcTarget float32
	agcAttack float32
	agcDecay  float32
	agcMax    float32
}

func NewSsbDemod(mode string) *SsbDemod {
	return &SsbDemod{
		mode:      mode,
		agcGain:   1.0,
		agcTarget: 0.3,
		agcAttack: 0.005,  // slower attack for SSB speech naturalness
		agcDecay:  0.0001,
		agcMax:    200.0,
	}
}

func (s *SsbDemod) Name() string                            { return "ssb_" + s.mode }
func (s *SsbDemod) SampleRateOut(inputRate float64) float64 { return inputRate }

func (s *SsbDemod) Init(ctx dsp.BlockContext) error {
	s.dcPrev = 0
	s.dcPrevOut = 0
	s.agcGain = 1.0
	return nil
}

func (s *SsbDemod) Process(in []complex64, out []float32) int {
	n := len(in)
	if len(out) < n {
		n = len(out)
	}

	target := s.agcTarget
	attack := s.agcAttack
	decay := s.agcDecay
	maxGain := s.agcMax
	gain := s.agcGain
	dcPrev := s.dcPrev
	dcPrevOut := s.dcPrevOut

	for i := 0; i < n; i++ {
		x := real(in[i])

		// DC block
		dcOut := x - dcPrev + 0.995*dcPrevOut
		dcPrev = x
		dcPrevOut = dcOut

		// AGC
		absVal := dcOut * gain
		if absVal < 0 {
			absVal = -absVal
		}
		if absVal > target {
			gain *= (1 - attack)
		} else {
			gain *= (1 + decay)
		}
		if gain > maxGain {
			gain = maxGain
		} else if gain < 0.001 {
			gain = 0.001
		}
		out[i] = dcOut * gain
	}

	s.agcGain = gain
	s.dcPrev = dcPrev
	s.dcPrevOut = dcPrevOut
	return n
}

func (s *SsbDemod) Reset() {
	s.dcPrev = 0
	s.dcPrevOut = 0
	s.agcGain = 1.0
}
