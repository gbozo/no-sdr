package demod

import (
	"math"

	"github.com/gbozo/no-sdr/serverng/internal/dsp"
)

// SamDemod implements Synchronous AM demodulation with a PLL-based carrier lock.
// It coherently detects the AM signal, providing better quality than envelope detection
// especially under selective fading.
type SamDemod struct {
	sampleRate float64
	pllPhase   float64
	pllFreq    float64
	pllOmega   float64
	g1, g2     float64 // loop filter coefficients (2nd-order, zeta=0.707, BW=150Hz)
	lockLevel  float32
	locked     bool
	lockAlpha  float32

	// DC blocker
	dcAlpha float32
	dcState float32

	// Low-pass filter
	lpAlpha float32
	lpState float32
}

func NewSamDemod() *SamDemod {
	return &SamDemod{}
}

func (s *SamDemod) Name() string                            { return "sam" }
func (s *SamDemod) SampleRateOut(inputRate float64) float64 { return inputRate }

func (s *SamDemod) Init(ctx dsp.BlockContext) error {
	s.sampleRate = ctx.SampleRate

	// 2nd-order PLL loop filter: BW=150Hz, zeta=0.707
	bw := 150.0
	omegaN := 2.0 * math.Pi * bw / s.sampleRate
	zeta := 0.707
	s.g1 = 2.0 * zeta * omegaN
	s.g2 = omegaN * omegaN

	s.pllPhase = 0
	s.pllFreq = 0
	s.pllOmega = 0
	s.lockLevel = 0
	s.locked = false
	s.lockAlpha = float32(1.0 - math.Exp(-1.0/(s.sampleRate*0.05))) // 50ms

	// DC blocker: high-pass with ~20Hz cutoff
	s.dcAlpha = float32(1.0 - math.Exp(-2.0*math.Pi*20.0/s.sampleRate))
	s.dcState = 0

	// LPF: ~5kHz cutoff for audio output
	lpCutoff := 5000.0
	if lpCutoff > s.sampleRate/2 {
		lpCutoff = s.sampleRate / 2 * 0.9
	}
	s.lpAlpha = float32(1.0 - math.Exp(-2.0*math.Pi*lpCutoff/s.sampleRate))
	s.lpState = 0

	return nil
}

func (s *SamDemod) Process(in []complex64, out []float32) int {
	n := len(in)
	if len(out) < n {
		n = len(out)
	}

	pllPhase := s.pllPhase
	pllOmega := s.pllOmega
	lockLevel := s.lockLevel
	lockAlpha := s.lockAlpha
	dcState := s.dcState
	dcAlpha := s.dcAlpha
	lpState := s.lpState
	lpAlpha := s.lpAlpha

	for i := 0; i < n; i++ {
		re := float64(real(in[i]))
		im := float64(imag(in[i]))

		cosP := math.Cos(pllPhase)
		sinP := math.Sin(pllPhase)

		// Coherent detection
		demod := re*cosP + im*sinP

		// Phase error
		err := -re*sinP + im*cosP

		// Loop filter (2nd-order)
		pllOmega += s.g2 * err
		pllFreq := pllOmega + s.g1*err
		pllPhase += pllFreq

		// Wrap phase
		if pllPhase > math.Pi {
			pllPhase -= 2 * math.Pi
		} else if pllPhase < -math.Pi {
			pllPhase += 2 * math.Pi
		}

		// Lock indicator: ratio of coherent power to total power
		totalPow := float32(re*re + im*im + 1e-20)
		coherentPow := float32(demod * demod)
		lockLevel = lockAlpha*(coherentPow/totalPow) + (1-lockAlpha)*lockLevel

		// DC blocker
		dcState = dcAlpha*float32(demod) + (1-dcAlpha)*dcState
		sample := float32(demod) - dcState

		// LPF
		lpState = lpAlpha*sample + (1-lpAlpha)*lpState
		out[i] = lpState
	}

	s.pllPhase = pllPhase
	s.pllOmega = pllOmega
	s.lockLevel = lockLevel
	s.dcState = dcState
	s.lpState = lpState
	s.locked = lockLevel > 0.5

	return n
}

func (s *SamDemod) Reset() {
	s.pllPhase = 0
	s.pllFreq = 0
	s.pllOmega = 0
	s.lockLevel = 0
	s.locked = false
	s.dcState = 0
	s.lpState = 0
}

// IsLocked returns true if the PLL has achieved carrier lock.
func (s *SamDemod) IsLocked() bool {
	return s.locked
}

// SetBandwidth adjusts the post-demod audio LPF cutoff.
// Matches Node.js SamDemodulator.setBandwidth: cutoff = min(hz/2, 8000) Hz.
func (s *SamDemod) SetBandwidth(hz float64) {
	if hz <= 0 || s.sampleRate <= 0 {
		return
	}
	cutoffHz := hz / 2.0
	if cutoffHz > 8000 {
		cutoffHz = 8000
	}
	if cutoffHz > s.sampleRate/2 {
		cutoffHz = s.sampleRate / 2 * 0.9
	}
	s.lpAlpha = float32(1.0 - math.Exp(-2.0*math.Pi*cutoffHz/s.sampleRate))
	s.lpState = 0 // reset to avoid transient
}
