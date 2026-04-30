package dsp

import (
	"errors"
	"math"
)

// BlackmanHarris generates a 4-term Blackman-Harris window of the given size.
// Coefficients: a0=0.35875, a1=0.48829, a2=0.14128, a3=0.01168
func BlackmanHarris(size int) []float32 {
	w := make([]float32, size)
	if size == 1 {
		w[0] = 1.0
		return w
	}
	const (
		a0 = 0.35875
		a1 = 0.48829
		a2 = 0.14128
		a3 = 0.01168
	)
	nm1 := float64(size - 1)
	for i := 0; i < size; i++ {
		x := 2.0 * math.Pi * float64(i) / nm1
		w[i] = float32(a0 - a1*math.Cos(x) + a2*math.Cos(2.0*x) - a3*math.Cos(3.0*x))
	}
	return w
}

// Hann generates a Hann (raised cosine) window of the given size.
// w[i] = 0.5 * (1 - cos(2πi/(N-1)))
func Hann(size int) []float32 {
	w := make([]float32, size)
	if size == 1 {
		w[0] = 1.0
		return w
	}
	nm1 := float64(size - 1)
	for i := 0; i < size; i++ {
		w[i] = float32(0.5 * (1.0 - math.Cos(2.0*math.Pi*float64(i)/nm1)))
	}
	return w
}

// Hamming generates a Hamming window of the given size.
// w[i] = 0.54 - 0.46*cos(2πi/(N-1))
func Hamming(size int) []float32 {
	w := make([]float32, size)
	if size == 1 {
		w[0] = 1.0
		return w
	}
	nm1 := float64(size - 1)
	for i := 0; i < size; i++ {
		w[i] = float32(0.54 - 0.46*math.Cos(2.0*math.Pi*float64(i)/nm1))
	}
	return w
}

// Kaiser generates a Kaiser window of the given size with parameter beta.
// w[i] = I0(β * sqrt(1 - ((2i/(N-1)) - 1)²)) / I0(β)
// When beta=0, this produces a rectangular window (all ones).
func Kaiser(size int, beta float64) []float32 {
	w := make([]float32, size)
	if size == 1 {
		w[0] = 1.0
		return w
	}
	denom := besselI0(beta)
	nm1 := float64(size - 1)
	for i := 0; i < size; i++ {
		t := (2.0*float64(i)/nm1 - 1.0)
		arg := beta * math.Sqrt(1.0-t*t)
		w[i] = float32(besselI0(arg) / denom)
	}
	return w
}

// besselI0 computes the modified Bessel function of the first kind, order 0.
// Uses power series expansion with convergence check.
func besselI0(x float64) float64 {
	sum := 1.0
	term := 1.0
	for k := 1; k < 25; k++ {
		factor := x / float64(2*k)
		term *= factor * factor
		sum += term
		if term < 1e-12*sum {
			break
		}
	}
	return sum
}

// NewWindow creates a window function by name. Supported names:
// "blackman-harris", "hann", "hamming", "kaiser" (uses default beta=8.6).
func NewWindow(name string, size int) ([]float32, error) {
	if size < 1 {
		return nil, errors.New("window: size must be >= 1")
	}
	switch name {
	case "blackman-harris":
		return BlackmanHarris(size), nil
	case "hann":
		return Hann(size), nil
	case "hamming":
		return Hamming(size), nil
	case "kaiser":
		return Kaiser(size, 8.6), nil
	default:
		return nil, errors.New("window: unknown window type: " + name)
	}
}
