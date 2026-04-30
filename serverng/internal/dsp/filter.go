package dsp

import "math"

// ButterworthBlock is a 4th-order Butterworth low-pass IIR filter
// implemented as 2 cascaded biquad sections.
// I and Q channels are filtered independently.
type ButterworthBlock struct {
	cutoffHz   float64
	sampleRate float64
	sections   [2]biquadCoeffs
	stateI     [2]biquadState
	stateQ     [2]biquadState
}

type biquadCoeffs struct {
	b0, b1, b2 float64
	a1, a2     float64
}

type biquadState struct {
	z1, z2 float64 // Direct Form II transposed state variables
}

// NewButterworthBlock creates a 4th-order Butterworth LPF with the given cutoff.
func NewButterworthBlock(cutoffHz float64) *ButterworthBlock {
	return &ButterworthBlock{cutoffHz: cutoffHz}
}

func (b *ButterworthBlock) Name() string                            { return "butterworth_lpf" }
func (b *ButterworthBlock) SampleRateOut(inputRate float64) float64 { return inputRate }

// Init computes biquad coefficients using bilinear transform with pre-warping.
func (b *ButterworthBlock) Init(ctx BlockContext) error {
	b.sampleRate = ctx.SampleRate
	b.computeCoeffs()
	return nil
}

// computeCoeffs calculates biquad coefficients for both sections.
// 4th-order Butterworth = 2 biquad sections with specific Q values.
func (b *ButterworthBlock) computeCoeffs() {
	// Q values for 4th-order Butterworth (poles at pi/8 and 3*pi/8)
	q1 := 1.0 / (2.0 * math.Cos(math.Pi/8.0))   // ≈ 0.5412
	q2 := 1.0 / (2.0 * math.Cos(3.0*math.Pi/8.0)) // ≈ 1.3066

	b.sections[0] = computeBiquad(b.cutoffHz, b.sampleRate, q1)
	b.sections[1] = computeBiquad(b.cutoffHz, b.sampleRate, q2)
}

// computeBiquad computes coefficients for a single 2nd-order section.
// Uses bilinear transform with frequency pre-warping.
func computeBiquad(cutoffHz, sampleRate, q float64) biquadCoeffs {
	// Pre-warp the cutoff frequency
	K := math.Tan(math.Pi * cutoffHz / sampleRate)
	K2 := K * K

	// Normalize
	norm := 1.0 + K/q + K2

	b0 := K2 / norm
	b1 := 2.0 * K2 / norm
	b2 := K2 / norm
	a1 := 2.0 * (K2 - 1.0) / norm
	a2 := (1.0 - K/q + K2) / norm

	return biquadCoeffs{b0: b0, b1: b1, b2: b2, a1: a1, a2: a2}
}

// ProcessComplex filters I and Q channels independently through both biquad sections.
func (b *ButterworthBlock) ProcessComplex(in []complex64, out []complex64) int {
	for i, s := range in {
		reIn := float64(real(s))
		imIn := float64(imag(s))

		// Filter I channel through both sections
		reOut := b.filterSample(reIn, &b.stateI)
		// Filter Q channel through both sections
		imOut := b.filterSample(imIn, &b.stateQ)

		out[i] = complex(float32(reOut), float32(imOut))
	}
	return len(in)
}

// filterSample processes a single real sample through both biquad sections.
// Direct Form II Transposed:
//   y = b0*x + z1
//   z1 = b1*x - a1*y + z2
//   z2 = b2*x - a2*y
func (b *ButterworthBlock) filterSample(x float64, states *[2]biquadState) float64 {
	val := x
	for sec := 0; sec < 2; sec++ {
		c := &b.sections[sec]
		st := &states[sec]

		y := c.b0*val + st.z1
		st.z1 = c.b1*val - c.a1*y + st.z2
		st.z2 = c.b2*val - c.a2*y

		val = y
	}
	return val
}

// Reset zeroes all filter state (removes transient history).
func (b *ButterworthBlock) Reset() {
	b.stateI = [2]biquadState{}
	b.stateQ = [2]biquadState{}
}

// SetCutoff recomputes coefficients for a new cutoff frequency.
func (b *ButterworthBlock) SetCutoff(hz float64) {
	b.cutoffHz = hz
	if b.sampleRate > 0 {
		b.computeCoeffs()
	}
}
