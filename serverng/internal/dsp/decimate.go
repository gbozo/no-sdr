package dsp

import "math"

// DecimateBlock performs decimation with proper anti-aliasing FIR filtering.
// Uses a Blackman-Harris windowed-sinc lowpass filter designed for each
// decimation ratio, with a circular delay line for correct sample alignment.
// The FIR doubles as a bandwidth-limiting filter — call SetBandwidth to
// narrow the passband below the default Nyquist of outputRate/2.
type DecimateBlock struct {
	factor       int
	taps         []float32
	buf          []complex64
	pos          int
	bufMask      int
	inputRate    float64
	bandwidthHz  int // 0 = default (outputRate / 2)

	// Total samples processed across all calls. Needed to maintain correct
	// decimation phase across chunk boundaries — without this, the condition
	// check resets on every ProcessComplex call, dropping output samples.
	totalIn int64
}

func NewDecimateBlock(factor int) *DecimateBlock {
	return &DecimateBlock{factor: factor}
}

func (d *DecimateBlock) Name() string { return "decimate" }

func (d *DecimateBlock) SampleRateOut(inputRate float64) float64 {
	return inputRate / float64(d.factor)
}

func (d *DecimateBlock) Init(ctx BlockContext) error {
	if d.factor <= 1 {
		d.taps = nil
		return nil
	}

	d.inputRate = ctx.SampleRate
	numTaps := d.estimateTapCount()
	d.taps = d.designAntiAliasFir(numTaps, 0)

	bufSize := 1
	for bufSize < numTaps {
		bufSize <<= 1
	}
	d.buf = make([]complex64, bufSize)
	d.bufMask = bufSize - 1
	d.pos = 0
	d.totalIn = 0

	return nil
}

// ProcessComplex filters through the FIR anti-aliasing filter and decimates.
// Uses a persistent totalIn counter so decimation phase is correct across
// chunk boundaries. The FIR output y[t] = sum_{k=0}^{numTaps-1} h[k] * x[t-k]
// is evaluated at every factor-th sample index t.
//
// Reads the delay line DURING the write phase so the circular buffer always
// contains the most recent numTaps samples at each position.
func (d *DecimateBlock) ProcessComplex(in []complex64, out []complex64) int {
	if d.factor <= 1 || d.taps == nil {
		copy(out, in)
		return len(in)
	}

	f := d.factor
	n := len(in)
	taps := d.taps
	numTaps := len(taps)
	buf := d.buf
	mask := d.bufMask
	pos := d.pos

	outIdx := 0
	firstOut := int64(numTaps - 1)

	for i := 0; i < n; i++ {
		buf[pos] = in[i]

		totalIdx := d.totalIn + int64(i)
		if totalIdx >= firstOut {
			rem := (totalIdx - firstOut) % int64(f)
			if rem == 0 {
				var sum complex64
				idx := pos
				for k := 0; k < numTaps; k++ {
					coeff := taps[k]
					sum += complex(real(buf[idx])*coeff, imag(buf[idx])*coeff)
					idx = (idx - 1) & mask
				}
				out[outIdx] = sum
				outIdx++
			}
		}

		pos = (pos + 1) & mask
	}

	d.pos = pos
	d.totalIn += int64(n)

	return outIdx
}

func (d *DecimateBlock) Reset() {
	if d.buf != nil {
		for i := range d.buf {
			d.buf[i] = 0
		}
	}
	d.pos = 0
	d.totalIn = 0
}

// SetBandwidth redesigns the FIR taps for a narrower passband. When hz > 0
// and less than outputRate/2, the FIR's -6 dB point moves to hz/2 instead
// of the default outputRate/2. Call with hz=0 to revert to Nyquist.
// Resets filter state (buffer + phase) after redesign.
func (d *DecimateBlock) SetBandwidth(hz int) {
	d.bandwidthHz = hz
	if d.factor <= 1 || d.taps == nil {
		return
	}
	numTaps := len(d.taps)
	d.taps = d.designAntiAliasFir(numTaps, hz)
	d.Reset()
}

func (d *DecimateBlock) estimateTapCount() int {
	n := d.factor*5 + 1
	if n < 31 {
		n = 31
	}
	if n%2 == 0 {
		n++
	}
	return n
}

func (d *DecimateBlock) designAntiAliasFir(numTaps int, bandwidthHz int) []float32 {
	cutoff := 0.5 / float64(d.factor)
	if bandwidthHz > 0 && d.inputRate > 0 {
		c := float64(bandwidthHz) / 2.0 / d.inputRate
		if c > 0 && c < cutoff {
			cutoff = c
		}
	}
	taps := make([]float32, numTaps)
	m := float64(numTaps - 1) / 2.0
	var sum float64
	for i := 0; i < numTaps; i++ {
		x := float64(i) - m
		var sinc float64
		if math.Abs(x) < 1e-12 {
			sinc = 2 * math.Pi * cutoff
		} else {
			sinc = math.Sin(2*math.Pi*cutoff*x) / x
		}
		fi := float64(i)
		fn := float64(numTaps - 1)
		w := 0.35875 - 0.48829*math.Cos(2*math.Pi*fi/fn) +
			0.14128*math.Cos(4*math.Pi*fi/fn) - 0.01168*math.Cos(6*math.Pi*fi/fn)
		taps[i] = float32(sinc * w)
		sum += float64(taps[i])
	}
	for i := range taps {
		taps[i] = float32(float64(taps[i]) / sum)
	}
	return taps
}
