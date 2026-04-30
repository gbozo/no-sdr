package dsp

// DecimateBlock reduces sample rate by an integer factor.
// Outputs every Nth sample from the input.
type DecimateBlock struct {
	factor int
}

// NewDecimateBlock creates a decimation block with the given factor.
func NewDecimateBlock(factor int) *DecimateBlock {
	return &DecimateBlock{factor: factor}
}

func (d *DecimateBlock) Name() string { return "decimate" }

func (d *DecimateBlock) SampleRateOut(inputRate float64) float64 {
	return inputRate / float64(d.factor)
}

func (d *DecimateBlock) Init(ctx BlockContext) error { return nil }

// ProcessComplex outputs every Nth sample: out[j] = in[j*factor].
func (d *DecimateBlock) ProcessComplex(in []complex64, out []complex64) int {
	f := d.factor
	n := len(in) / f
	for j := 0; j < n; j++ {
		out[j] = in[j*f]
	}
	return n
}

func (d *DecimateBlock) Reset() {}
