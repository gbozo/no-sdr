package demod

import (
	"math"

	"github.com/gbozo/no-sdr/serverng/internal/dsp"
)

// AmDemod implements AM envelope detection.
// Output is the magnitude (envelope) of the complex input signal.
type AmDemod struct {
	sampleRate float64
}

func NewAmDemod() *AmDemod {
	return &AmDemod{}
}

func (a *AmDemod) Name() string                            { return "am" }
func (a *AmDemod) SampleRateOut(inputRate float64) float64 { return inputRate }

func (a *AmDemod) Init(ctx dsp.BlockContext) error {
	a.sampleRate = ctx.SampleRate
	return nil
}

func (a *AmDemod) Process(in []complex64, out []float32) int {
	n := len(in)
	if len(out) < n {
		n = len(out)
	}
	for i := 0; i < n; i++ {
		re := real(in[i])
		im := imag(in[i])
		out[i] = float32(math.Sqrt(float64(re*re + im*im)))
	}
	return n
}

func (a *AmDemod) Reset() {}
