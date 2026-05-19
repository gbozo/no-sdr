package dsp

import "math"

const ncoTableSize = 4096
const ncoTableMask = ncoTableSize - 1

// NCOBlock shifts the frequency of complex IQ samples by mixing with a local oscillator.
// Uses a 4096-entry sin/cos lookup table with linear interpolation to eliminate
// phase truncation spurs that would otherwise degrade signal quality.
type NCOBlock struct {
	offsetHz   float64
	sampleRate float64
	phase      float64
	phaseInc   float64
	sinTable   [ncoTableSize]float32
	cosTable   [ncoTableSize]float32
}

// NewNCOBlock creates an NCO with the given frequency offset in Hz.
func NewNCOBlock(offsetHz float64) *NCOBlock {
	return &NCOBlock{offsetHz: offsetHz}
}

func (n *NCOBlock) Name() string                            { return "nco" }
func (n *NCOBlock) SampleRateOut(inputRate float64) float64 { return inputRate }

// Init pre-computes the lookup tables and phase increment.
func (n *NCOBlock) Init(ctx BlockContext) error {
	n.sampleRate = ctx.SampleRate
	n.phaseInc = 2.0 * math.Pi * n.offsetHz / n.sampleRate
	n.phase = 0

	for i := 0; i < ncoTableSize; i++ {
		angle := 2.0 * math.Pi * float64(i) / float64(ncoTableSize)
		n.sinTable[i] = float32(math.Sin(angle))
		n.cosTable[i] = float32(math.Cos(angle))
	}
	return nil
}

// ProcessComplex frequency-shifts each sample: out[i] = in[i] * exp(-j*phase).
// Uses lookup table with linear interpolation for higher precision.
func (n *NCOBlock) ProcessComplex(in []complex64, out []complex64) int {
	phase := n.phase
	phaseInc := n.phaseInc
	tableScale := float64(ncoTableSize) / (2.0 * math.Pi)

	for i, s := range in {
		phaseScaled := phase * tableScale
		idx := int(phaseScaled) & ncoTableMask
		frac := float32(phaseScaled - float64(int(phaseScaled)))

		cos0 := n.cosTable[idx]
		sin0 := n.sinTable[idx]
		nextIdx := (idx + 1) & ncoTableMask
		cos1 := n.cosTable[nextIdx]
		sin1 := n.sinTable[nextIdx]

		cosVal := cos0 + frac*(cos1-cos0)
		sinVal := sin0 + frac*(sin1-sin0)

		re := real(s)
		im := imag(s)
		out[i] = complex(re*cosVal+im*sinVal, im*cosVal-re*sinVal)

		phase += phaseInc
	}

	phase = math.Mod(phase, 2.0*math.Pi)
	if phase < 0 {
		phase += 2.0 * math.Pi
	}
	n.phase = phase

	return len(in)
}

// Reset resets the oscillator phase to zero.
func (n *NCOBlock) Reset() {
	n.phase = 0
}

// SetOffset updates the frequency offset at runtime (e.g. for tuning).
func (n *NCOBlock) SetOffset(hz float64) {
	n.offsetHz = hz
	if n.sampleRate > 0 {
		n.phaseInc = 2.0 * math.Pi * hz / n.sampleRate
	}
}
