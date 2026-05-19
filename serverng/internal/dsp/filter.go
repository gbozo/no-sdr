package dsp

import "math"

// ButterworthBlock is an 8th-order Butterworth low-pass IIR filter
// implemented as 4 cascaded biquad sections (up from 2 in older versions).
// I and Q channels are filtered independently.
// The steeper rolloff (48 dB/oct vs 24 dB/oct for 4th-order) provides
// significantly better anti-aliasing protection before decimation.
type ButterworthBlock struct {
	cutoffHz   float64
	sampleRate float64
	sections   [4]biquadCoeffs
	stateI     [4]biquadState
	stateQ     [4]biquadState
}

type biquadCoeffs struct {
	b0, b1, b2 float64
	a1, a2     float64
}

type biquadState struct {
	z1, z2 float64
}

// NewButterworthBlock creates an 8th-order Butterworth LPF with the given cutoff.
func NewButterworthBlock(cutoffHz float64) *ButterworthBlock {
	return &ButterworthBlock{cutoffHz: cutoffHz}
}

func (b *ButterworthBlock) Name() string                            { return "butterworth_lpf" }
func (b *ButterworthBlock) SampleRateOut(inputRate float64) float64 { return inputRate }

func (b *ButterworthBlock) Init(ctx BlockContext) error {
	b.sampleRate = ctx.SampleRate
	b.computeCoeffs()
	return nil
}

// computeCoeffs calculates biquad coefficients for all 4 sections.
// 8th-order Butterworth = 4 biquad sections with Q values derived from
// pole positions at angles (2k+1)*pi/16 for k = 0..3.
func (b *ButterworthBlock) computeCoeffs() {
	for k := 0; k < 4; k++ {
		theta := (2.0*float64(k) + 1.0) * math.Pi / 16.0
		q := 1.0 / (2.0 * math.Cos(theta))
		b.sections[k] = computeBiquad(b.cutoffHz, b.sampleRate, q)
	}
}

// computeBiquad computes coefficients for a single 2nd-order section.
// Uses bilinear transform with frequency pre-warping.
func computeBiquad(cutoffHz, sampleRate, q float64) biquadCoeffs {
	K := math.Tan(math.Pi * cutoffHz / sampleRate)
	K2 := K * K
	norm := 1.0 + K/q + K2

	return biquadCoeffs{
		b0: K2 / norm,
		b1: 2.0 * K2 / norm,
		b2: K2 / norm,
		a1: 2.0 * (K2 - 1.0) / norm,
		a2: (1.0 - K/q + K2) / norm,
	}
}

// ProcessComplex filters I and Q channels independently through all 4 biquad sections.
func (b *ButterworthBlock) ProcessComplex(in []complex64, out []complex64) int {
	for i, s := range in {
		reIn := float64(real(s))
		imIn := float64(imag(s))

		reOut := b.filterSample(reIn, &b.stateI)
		imOut := b.filterSample(imIn, &b.stateQ)

		out[i] = complex(float32(reOut), float32(imOut))
	}
	return len(in)
}

// filterSample processes a single real sample through all 4 biquad sections.
func (b *ButterworthBlock) filterSample(x float64, states *[4]biquadState) float64 {
	val := x
	for sec := 0; sec < 4; sec++ {
		c := &b.sections[sec]
		st := &states[sec]

		y := c.b0*val + st.z1
		st.z1 = c.b1*val - c.a1*y + st.z2
		st.z2 = c.b2*val - c.a2*y

		val = y
	}
	return val
}

func (b *ButterworthBlock) Reset() {
	b.stateI = [4]biquadState{}
	b.stateQ = [4]biquadState{}
}

// SetCutoff recomputes coefficients for a new cutoff frequency and resets state.
func (b *ButterworthBlock) SetCutoff(hz float64) {
	b.cutoffHz = hz
	if b.sampleRate > 0 {
		b.computeCoeffs()
	}
}
