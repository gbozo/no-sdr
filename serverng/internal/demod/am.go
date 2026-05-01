package demod

import (
	"math"

	"github.com/gbozo/no-sdr/serverng/internal/dsp"
)

// AmDemod implements AM envelope detection with DC blocking, AGC, and an optional audio LPF.
// Matches the Node.js AmMonoDemod behaviour: sqrt(I²+Q²) → DC block → AGC → audio LPF.
type AmDemod struct {
	sampleRate float64

	// DC blocking filter: y = x - x_prev + 0.995 * y_prev
	dcPrev    float32
	dcPrevOut float32

	// Simple AGC: gain tracks target amplitude
	agcGain   float32
	agcTarget float32
	agcAttack float32
	agcDecay  float32
	agcMax    float32

	// Audio LPF (post-AGC, bandwidth-limiting).
	// Node.js AM.setBandwidth: cutoff = min(hz/2, 5000)
	audioLpf        *simpleFir
	audioLpfEnabled bool
}

func NewAmDemod() *AmDemod {
	return &AmDemod{
		agcGain:   1.0,
		agcTarget: 0.3,
		agcAttack: 0.01,
		agcDecay:  0.0001,
		agcMax:    100.0,
	}
}

func (a *AmDemod) Name() string                            { return "am" }
func (a *AmDemod) SampleRateOut(inputRate float64) float64 { return inputRate }

func (a *AmDemod) Init(ctx dsp.BlockContext) error {
	a.sampleRate = ctx.SampleRate
	a.dcPrev = 0
	a.dcPrevOut = 0
	a.agcGain = 1.0
	return nil
}

func (a *AmDemod) Process(in []complex64, out []float32) int {
	n := len(in)
	if len(out) < n {
		n = len(out)
	}
	target := a.agcTarget
	attack := a.agcAttack
	decay := a.agcDecay
	maxGain := a.agcMax
	gain := a.agcGain
	dcPrev := a.dcPrev
	dcPrevOut := a.dcPrevOut

	for i := 0; i < n; i++ {
		re := real(in[i])
		im := imag(in[i])
		// Envelope detection
		env := float32(math.Sqrt(float64(re*re + im*im)))

		// DC block: y = x - x_prev + 0.995*y_prev
		dcOut := env - dcPrev + 0.995*dcPrevOut
		dcPrev = env
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

	a.agcGain = gain
	a.dcPrev = dcPrev
	a.dcPrevOut = dcPrevOut

	// Apply post-AGC audio LPF if enabled
	if a.audioLpfEnabled && a.audioLpf != nil {
		for i := 0; i < n; i++ {
			out[i] = a.audioLpf.process(out[i])
		}
	}

	return n
}

func (a *AmDemod) Reset() {
	a.dcPrev = 0
	a.dcPrevOut = 0
	a.agcGain = 1.0
	if a.audioLpf != nil {
		a.audioLpf.reset()
	}
}

// SetBandwidth sets the post-AGC audio low-pass filter cutoff.
// Matches Node.js AmMonoDemod.setBandwidth: cutoff = min(hz/2, 5000) Hz.
func (a *AmDemod) SetBandwidth(hz float64) {
	if hz <= 0 || a.sampleRate <= 0 {
		a.audioLpfEnabled = false
		return
	}
	cutoffHz := hz / 2.0
	if cutoffHz > 5000 {
		cutoffHz = 5000
	}
	norm := cutoffHz / a.sampleRate
	if norm >= 0.5 {
		a.audioLpfEnabled = false
		return
	}
	if a.audioLpf == nil {
		a.audioLpf = newSimpleFir(31, norm)
	} else {
		a.audioLpf.design(norm, 31)
		a.audioLpf.reset()
	}
	a.audioLpfEnabled = true
}
