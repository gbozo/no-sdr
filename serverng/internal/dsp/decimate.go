package dsp

import (
	"math"
	"unsafe"
)

// maxFirTapsFactorScale controls the FIR tap cap per decimation factor.
// Actual cap = maxFirTapsFactorScale * factor / 10, giving:
//   factor=10 (WFM, 240kHz): max 256 taps → 33% Pi4, 49dB @alias
//   factor=50  (AMS/NFM):    max 1280 → uncapped for standard bandwidths
//   factor=100 (SSB/CW):     max 2560 → uncapped for standard bandwidths
// Narrow-bandwidth modes (low output rate) need many taps to represent the
// cutoff; their CPU cost is low regardless (fewer output samples/sec).
const maxFirTapsFactorScale = 256

// DecimateBlock performs decimation with proper anti-aliasing FIR filtering
// using a polyphase decomposition. The prototype lowpass filter is split into
// M sub-filters (where M = decimation factor), each of length P = ceil(N/M).
// Input samples are commutated across sub-filters; every M-th input produces
// one output by summing all M sub-filter dot products.
//
// Polyphase gives each sub-filter a small, cache-local delay line (~11 taps
// for typical configurations). The dot product over each sub-filter walks
// sequential memory, which is SIMD-friendly and avoids the strided access
// pattern of the equivalent direct-form FIR.
type DecimateBlock struct {
	factor       int
	subTaps      []float32   // flat row-major: [h_0[0]..h_0[P-1], h_1[0]..h_1[P-1], ...]
	subBufs      []complex64 // flat row-major delay lines, same layout
	subPos       []int       // write position within each sub-filter's delay line
	tapsPerSub   int         // P = ceil(prototypeLen / factor)
	prototypeLen int         // length of the ORIGINAL prototype (before zero-pad)
	firstOut     int64       // totalIn threshold for first output
	inputRate    float64
	bandwidthHz  int // 0 = default (outputRate / 2)
	totalIn      int64
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
		d.subTaps = nil
		return nil
	}
	d.inputRate = ctx.SampleRate
	d.initFromPrototype(d.estimateTapCount(d.bandwidthHz), d.bandwidthHz, true)
	return nil
}

// initFromPrototype designs a prototype filter of origNTaps, zero-pads it to a
// multiple of d.factor, splits into polyphase sub-filters, allocates delay
// lines, and computes the first-output index. If allocBufs is false, only
// recomputes coefficients (used during SetBandwidth when the buffer may
// already be large enough).
func (d *DecimateBlock) initFromPrototype(origNTaps int, bandwidthHz int, allocBufs bool) {
	d.prototypeLen = origNTaps
	P := (origNTaps + d.factor - 1) / d.factor // ceil(origNTaps / factor)
	d.tapsPerSub = P
	proto := d.designAntiAliasFir(origNTaps, bandwidthHz)
	padded := zeroPadFilter(proto, d.factor)
	d.splitPolyphase(padded)

	// firstOut = (P-1)*factor + (prototypeLen-1)%factor
	// Ensures all sub-filters have enough non-zero samples for their
	// first dot product, matching the direct-form output schedule.
	d.firstOut = int64((P-1)*d.factor + (origNTaps-1)%d.factor)

	if allocBufs {
		d.allocDelayLines()
		d.Reset()
	}
}

// zeroPadFilter appends zeros to make the filter length a multiple of factor.
// This ensures all polyphase sub-filters have the same length P.
func zeroPadFilter(taps []float32, factor int) []float32 {
	N := len(taps)
	rem := N % factor
	if rem == 0 {
		return taps
	}
	padded := make([]float32, N+factor-rem)
	copy(padded, taps)
	return padded
}

// splitPolyphase decomposes the prototype filter into M sub-filters
// and stores them in row-major flat array d.subTaps.
func (d *DecimateBlock) splitPolyphase(prototype []float32) {
	M := d.factor
	P := d.tapsPerSub
	N := len(prototype) // zero-padded, guaranteed multiple of M
	d.subTaps = make([]float32, M*P)
	for p := 0; p < M; p++ {
		for k := 0; k < P; k++ {
			idx := p + k*M
			if idx < N {
				d.subTaps[p*P+k] = prototype[idx]
			}
		}
	}
}

// allocDelayLines creates M delay lines, each of length P.
func (d *DecimateBlock) allocDelayLines() {
	M := d.factor
	P := d.tapsPerSub
	d.subBufs = make([]complex64, M*P)
	d.subPos = make([]int, M)
}

// ProcessComplex filters through the polyphase decimator.
//
// Each input sample is routed to the sub-filter corresponding to its phase
// (sample index modulo factor). When the commutator completes one rotation
// (every factor-th sample), all sub-filter dot products are summed to produce
// one output sample.
//
// The totalIn counter maintains correct commutator phase across chunk
// boundaries. First output is produced after P*factor input samples (enough
// to populate all sub-filter delay lines).
func (d *DecimateBlock) ProcessComplex(in []complex64, out []complex64) int {
	if d.factor <= 1 || d.subTaps == nil {
		copy(out, in)
		return len(in)
	}

	f := d.factor
	P := d.tapsPerSub
	n := len(in)
	outIdx := 0
	firstOut := d.firstOut

	// Pre-fetch pointer base for unsafe inner loops
	tapsBase := unsafe.Pointer(unsafe.SliceData(d.subTaps))
	bufBase := unsafe.Pointer(unsafe.SliceData(d.subBufs))

	for i := 0; i < n; i++ {
		phase := int(d.totalIn+int64(i)) % f
		wpos := d.subPos[phase]
		d.subBufs[phase*P+wpos] = in[i]
		d.subPos[phase] = (wpos + 1) % P

		totalIdx := d.totalIn + int64(i)
		if totalIdx >= firstOut {
			rem := (totalIdx - firstOut) % int64(f)
			if rem == 0 {
				var sumRe, sumIm float32
				for q := 0; q < f; q++ {
					qOff := q * P
					rpos := d.subPos[q]
					idx := rpos - 1
					// Unrolled sub-filter dot product (re + im in one pass)
					for k := 0; k < P; k++ {
						coeff := *(*float32)(unsafe.Add(tapsBase, uintptr(qOff+k)*4))
						v := *(*complex64)(unsafe.Add(bufBase, uintptr(qOff+idx)*8))
						sumRe += real(v) * coeff
						sumIm += imag(v) * coeff
						idx--
						if idx < 0 {
							idx = P - 1
						}
					}
				}
				out[outIdx] = complex(sumRe, sumIm)
				outIdx++
			}
		}
	}

	d.totalIn += int64(n)
	return outIdx
}

func (d *DecimateBlock) Reset() {
	if d.subBufs != nil {
		for i := range d.subBufs {
			d.subBufs[i] = 0
		}
	}
	for i := range d.subPos {
		d.subPos[i] = 0
	}
	d.totalIn = 0
}

// SetBandwidth redesigns the FIR taps for a narrower passband.
// See DecimateBlock doc for details. Resets filter state after redesign.
func (d *DecimateBlock) SetBandwidth(hz int) {
	d.bandwidthHz = hz
	if d.factor <= 1 || d.subTaps == nil {
		return
	}
	origTaps := d.estimateTapCount(hz)
	d.prototypeLen = origTaps
	P := (origTaps + d.factor - 1) / d.factor
	d.tapsPerSub = P
	d.firstOut = int64((P-1)*d.factor + (origTaps-1)%d.factor)
	proto := d.designAntiAliasFir(origTaps, hz)
	padded := zeroPadFilter(proto, d.factor)
	d.splitPolyphase(padded)

	// Reallocate delay lines if sub-filter length grew
	needBufs := d.factor * d.tapsPerSub
	if needBufs > cap(d.subBufs) {
		d.allocDelayLines()
	}
	d.Reset()
}

// PrototypeTaps returns the original prototype filter taps.
// Used by tests to verify filter characteristics.
func (d *DecimateBlock) PrototypeTaps() []float32 {
	if d.subTaps == nil || d.factor <= 1 {
		return nil
	}
	// Reconstruct prototype from polyphase sub-filters
	P := d.tapsPerSub
	n := d.prototypeLen
	proto := make([]float32, n)
	for p := 0; p < d.factor; p++ {
		for k := 0; k < P; k++ {
			idx := p + k*d.factor
			if idx < n {
				proto[idx] = d.subTaps[p*P+k]
			}
		}
	}
	return proto
}

func (d *DecimateBlock) estimateTapCount(bandwidthHz int) int {
	n := d.factor*5 + 1
	if n < 31 {
		n = 31
	}
	if bandwidthHz > 0 && d.inputRate > 0 {
		outputNyquist := d.inputRate / float64(d.factor) / 2.0
		passbandHz := float64(bandwidthHz) / 2.0
		if passbandHz < outputNyquist {
			transitionHz := outputNyquist - passbandHz
			minTaps := int(4.0 * d.inputRate / transitionHz)
			if minTaps > n {
				n = minTaps
			}
		}
	}
	capTaps := (maxFirTapsFactorScale * d.factor + 9) / 10
	if n > capTaps {
		n = capTaps
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
