package demod

import (
	"math"

	"github.com/gbozo/no-sdr/serverng/internal/dsp"
)

// CwDemod implements CW (Morse code) demodulation by mixing the IQ signal
// with a local BFO (Beat Frequency Oscillator) to produce an audible tone,
// followed by a low-pass filter to define the audio passband.
type CwDemod struct {
	bfoHz      float64 // beat frequency offset (default 700Hz)
	sampleRate float64
	phase      float64
	phaseInc   float64

	// Audio LPF — limits bandwidth after BFO mix.
	// Node.js CwDemodulator default: 127-tap FIR at 500/inputRate.
	// SetBandwidth: cutoff = max(50, hz) Hz.
	audioLpf *simpleFir
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
	// Default 500Hz audio LPF (matching Node.js 127-tap FIR at 500/inputRate)
	norm := 500.0 / c.sampleRate
	if c.audioLpf == nil {
		c.audioLpf = newSimpleFir(127, norm)
	} else {
		c.audioLpf.design(norm, 127)
		c.audioLpf.reset()
	}
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

	// Apply audio LPF
	if c.audioLpf != nil {
		for i := 0; i < n; i++ {
			out[i] = c.audioLpf.process(out[i])
		}
	}

	return n
}

func (c *CwDemod) Reset() {
	c.phase = 0
	if c.audioLpf != nil {
		c.audioLpf.reset()
	}
}

// SetBandwidth sets the audio LPF cutoff.
// Matches Node.js CwDemodulator.setBandwidth: cutoff = max(50, hz) Hz.
func (c *CwDemod) SetBandwidth(hz float64) {
	if c.sampleRate <= 0 {
		return
	}
	cutoffHz := hz
	if cutoffHz < 50 {
		cutoffHz = 50
	}
	norm := cutoffHz / c.sampleRate
	if norm >= 0.5 {
		norm = 0.499
	}
	if c.audioLpf == nil {
		c.audioLpf = newSimpleFir(127, norm)
	} else {
		c.audioLpf.design(norm, 127)
		c.audioLpf.reset()
	}
}
