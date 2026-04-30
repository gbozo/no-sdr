package dsp

import (
	"math"
	"testing"
)

func TestBlackmanHarris_EdgeAndCenter(t *testing.T) {
	n := 1024
	w := BlackmanHarris(n)

	// Edge values should be near zero
	if w[0] > 1e-3 {
		t.Errorf("w[0] = %f, expected near zero (< 1e-3)", w[0])
	}
	if w[n-1] > 1e-3 {
		t.Errorf("w[N-1] = %f, expected near zero (< 1e-3)", w[n-1])
	}

	// Center value should be ~1.0
	center := w[n/2]
	if math.Abs(float64(center)-1.0) > 0.01 {
		t.Errorf("w[N/2] = %f, expected ~1.0", center)
	}
}

func TestHann_EdgeAndCenter(t *testing.T) {
	n := 512
	w := Hann(n)

	// Hann window: w[0] = 0, w[N-1] = 0
	if math.Abs(float64(w[0])) > 1e-6 {
		t.Errorf("w[0] = %f, expected 0", w[0])
	}
	if math.Abs(float64(w[n-1])) > 1e-6 {
		t.Errorf("w[N-1] = %f, expected 0", w[n-1])
	}

	// Center should be 1.0
	center := w[n/2]
	if math.Abs(float64(center)-1.0) > 0.01 {
		t.Errorf("w[N/2] = %f, expected ~1.0", center)
	}
}

func TestHamming_Values(t *testing.T) {
	n := 256
	w := Hamming(n)

	// Hamming window: w[0] = 0.08 (not zero!)
	if math.Abs(float64(w[0])-0.08) > 0.01 {
		t.Errorf("w[0] = %f, expected ~0.08", w[0])
	}

	// Center should be 1.0
	center := w[n/2]
	if math.Abs(float64(center)-1.0) > 0.01 {
		t.Errorf("w[N/2] = %f, expected ~1.0", center)
	}
}

func TestKaiser_Beta0_Rectangular(t *testing.T) {
	// Kaiser with beta=0 should produce a rectangular window (all 1s)
	n := 64
	w := Kaiser(n, 0.0)

	for i := 0; i < n; i++ {
		if math.Abs(float64(w[i])-1.0) > 1e-6 {
			t.Errorf("w[%d] = %f, expected 1.0 for beta=0", i, w[i])
		}
	}
}

func TestKaiser_PositiveBeta(t *testing.T) {
	n := 128
	w := Kaiser(n, 8.6)

	// Center should be 1.0 (maximum)
	center := w[n/2]
	if math.Abs(float64(center)-1.0) > 0.01 {
		t.Errorf("w[N/2] = %f, expected ~1.0", center)
	}

	// Edges should be significantly less than 1
	if w[0] > 0.01 {
		t.Errorf("w[0] = %f, expected near zero for beta=8.6", w[0])
	}
}

func TestNewWindow_UnknownName(t *testing.T) {
	_, err := NewWindow("unknown-window", 256)
	if err == nil {
		t.Fatal("expected error for unknown window name")
	}
}

func TestNewWindow_ValidNames(t *testing.T) {
	names := []string{"blackman-harris", "hann", "hamming", "kaiser"}
	for _, name := range names {
		w, err := NewWindow(name, 128)
		if err != nil {
			t.Errorf("NewWindow(%q, 128) returned error: %v", name, err)
		}
		if len(w) != 128 {
			t.Errorf("NewWindow(%q, 128) returned window of length %d", name, len(w))
		}
	}
}

func TestWindows_Symmetry(t *testing.T) {
	n := 256
	windows := map[string][]float32{
		"blackman-harris": BlackmanHarris(n),
		"hann":            Hann(n),
		"hamming":         Hamming(n),
		"kaiser":          Kaiser(n, 5.0),
	}

	for name, w := range windows {
		for i := 0; i < n/2; i++ {
			diff := math.Abs(float64(w[i]) - float64(w[n-1-i]))
			if diff > 1e-5 {
				t.Errorf("%s: w[%d]=%f != w[%d]=%f (diff=%e)",
					name, i, w[i], n-1-i, w[n-1-i], diff)
			}
		}
	}
}

func TestNewWindow_InvalidSize(t *testing.T) {
	_, err := NewWindow("hann", 0)
	if err == nil {
		t.Fatal("expected error for size 0")
	}
	_, err = NewWindow("hann", -1)
	if err == nil {
		t.Fatal("expected error for negative size")
	}
}

func BenchmarkBlackmanHarris65536(b *testing.B) {
	for i := 0; i < b.N; i++ {
		BlackmanHarris(65536)
	}
}
