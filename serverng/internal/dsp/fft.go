package dsp

import (
	"errors"
	"math"
)

// FFT performs forward FFT on interleaved complex float32 data.
// Uses Cooley-Tukey DIT with merged radix-2 stages (radix-4 optimization)
// for reduced memory access. Data format: [re0, im0, re1, im1, ...] length 2*N.
type FFT struct {
	size     int
	twiddles []float32 // pre-computed W_N^k = (cos, sin) pairs, angle = -2*pi*k/N
	bitrev   []int     // bit-reversal permutation table
	log2size int
}

// NewFFT creates an FFT instance for the given size (must be power of 2, >= 4).
func NewFFT(size int) (*FFT, error) {
	if size < 4 || size&(size-1) != 0 {
		return nil, errors.New("fft: size must be a power of 2 and >= 4")
	}

	log2n := 0
	for s := size; s > 1; s >>= 1 {
		log2n++
	}

	f := &FFT{
		size:     size,
		log2size: log2n,
	}

	f.bitrev = computeBitReversal(size, log2n)
	f.twiddles = computeTwiddles(size)

	return f, nil
}

// Size returns the FFT size.
func (f *FFT) Size() int {
	return f.size
}

// Transform performs in-place forward FFT on interleaved complex float32 data.
// data must have length 2*size. Zero allocations after FFT initialization.
func (f *FFT) Transform(data []float32) {
	n := f.size
	tw := f.twiddles

	// Step 1: Bit-reversal permutation
	bitReversalPermute(data, f.bitrev, n)

	// Step 2: Cooley-Tukey DIT stages, merged in pairs (radix-4) where possible.
	s := 0

	// If log2(N) is odd, do one radix-2 stage first
	if f.log2size&1 == 1 {
		for i := 0; i < n*2; i += 4 {
			r0, i0 := data[i], data[i+1]
			r1, i1 := data[i+2], data[i+3]
			data[i] = r0 + r1
			data[i+1] = i0 + i1
			data[i+2] = r0 - r1
			data[i+3] = i0 - i1
		}
		s = 1
	}

	// Merged radix-2 stages (equivalent to radix-4 but using correct DIT structure).
	// Each iteration processes two consecutive radix-2 stages.
	for ; s+1 < f.log2size; s += 2 {
		// First sub-stage: butterfly span = 2^s (halfm1 = 2^(s-1) for indexing)
		// Second sub-stage: butterfly span = 2^(s+1)
		halfm1 := 1 << s       // half-span of first radix-2 sub-stage
		m1 := halfm1 << 1      // full span of first sub-stage = 2^(s+1)
		halfm2 := m1           // half-span of second sub-stage = 2^(s+1)
		m2 := halfm2 << 1     // full span of second sub-stage = 2^(s+2)

		twBase1 := n >> (s + 1) // twiddle step for first sub-stage: N / 2^(s+1)
		twBase2 := n >> (s + 2) // twiddle step for second sub-stage: N / 2^(s+2)

		// Process the two stages in a single pass over groups of m2
		for k := 0; k < n; k += m2 {
			// First sub-stage on this group (butterflies of span halfm1)
			for j := 0; j < halfm1; j++ {
				twIdx := (j * twBase1) * 2
				wr := tw[twIdx]
				wi := tw[twIdx+1]

				// Process 4 butterflies in this sub-stage within the m2 group
				for off := 0; off < m2; off += m1 {
					p := (k + off + j) * 2
					q := p + halfm1*2

					er, ei := data[p], data[p+1]
					or, oi := data[q], data[q+1]

					tr := or*wr - oi*wi
					ti := or*wi + oi*wr

					data[p] = er + tr
					data[p+1] = ei + ti
					data[q] = er - tr
					data[q+1] = ei - ti
				}
			}

			// Second sub-stage on this group (butterflies of span halfm2)
			for j := 0; j < halfm2; j++ {
				twIdx := (j * twBase2) * 2
				wr := tw[twIdx]
				wi := tw[twIdx+1]

				p := (k + j) * 2
				q := p + halfm2*2

				er, ei := data[p], data[p+1]
				or, oi := data[q], data[q+1]

				tr := or*wr - oi*wi
				ti := or*wi + oi*wr

				data[p] = er + tr
				data[p+1] = ei + ti
				data[q] = er - tr
				data[q+1] = ei - ti
			}
		}
	}
}

// computeBitReversal generates the bit-reversal permutation table.
func computeBitReversal(n, log2n int) []int {
	perm := make([]int, n)
	for i := 0; i < n; i++ {
		perm[i] = reverseBits(i, log2n)
	}
	return perm
}

// reverseBits reverses the bottom `bits` bits of val.
func reverseBits(val, bits int) int {
	result := 0
	for i := 0; i < bits; i++ {
		result = (result << 1) | (val & 1)
		val >>= 1
	}
	return result
}

// computeTwiddles pre-computes twiddle factors W_N^k = exp(-j*2*pi*k/N)
// stored as interleaved [cos(angle), sin(angle)] pairs for k = 0..N-1.
func computeTwiddles(n int) []float32 {
	tw := make([]float32, 2*n)
	for k := 0; k < n; k++ {
		angle := -2.0 * math.Pi * float64(k) / float64(n)
		tw[2*k] = float32(math.Cos(angle))
		tw[2*k+1] = float32(math.Sin(angle))
	}
	return tw
}

// bitReversalPermute performs in-place bit-reversal permutation on interleaved complex data.
func bitReversalPermute(data []float32, perm []int, n int) {
	for i := 0; i < n; i++ {
		j := perm[i]
		if i < j {
			i2 := i * 2
			j2 := j * 2
			data[i2], data[j2] = data[j2], data[i2]
			data[i2+1], data[j2+1] = data[j2+1], data[i2+1]
		}
	}
}
