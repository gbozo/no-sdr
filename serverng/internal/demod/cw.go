package demod

import (
	"math"

	"github.com/gbozo/no-sdr/serverng/internal/dsp"
)

// CwDemod implements CW (Morse code) demodulation by mixing the IQ signal
// with a local BFO (Beat Frequency Oscillator) to produce an audible tone.
type CwDemod struct {
	bfoHz      float64 // beat frequency offset (default 700Hz)
	sampleRate float64
	phase      float64
	phaseInc   float64
}

// NewCwDemod creates a CW demodulator with the given BFO frequency in Hz.
// Typical values: 600-800 Hz.
func NewCwDemod(bfoHz float64) *CwDemod {
	return &CwDemod{bfoHz: bfoHz}
}

func (c *CwDemod) Name() string                            { return "cw" }
func (c *CwDemod) SampleRateOut(inputRate float64) float64 { return inputRate }

func (c *CwDemod) Init(ctx dsp.BlockContext) error {
	c.sampleRate = ctx.SampleRate
	c.phaseInc = 2.0 * math.Pi * c.bfoHz / c.sampleRate
	c.phase = 0
	return nil
}

func (c *CwDemod) Process(in []complex64, out []float32) int {
	n := len(in)
	if len(out) < n {
		n = len(out)
	}

	phase := c.phase
	phaseInc := c.phaseInc

	for i := 0; i < n; i++ {
		cosP := float32(math.Cos(phase))
		sinP := float32(math.Sin(phase))
		// Mix with BFO
		out[i] = real(in[i])*cosP + imag(in[i])*sinP
		phase += phaseInc
	}

	// Wrap phase to prevent float64 precision loss over time
	c.phase = math.Mod(phase, 2*math.Pi)
	return n
}

func (c *CwDemod) Reset() {
	c.phase = 0
}
