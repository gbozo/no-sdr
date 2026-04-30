package dsp

import (
	"math"
	"testing"
)

func TestNewFFT_InvalidSize(t *testing.T) {
	_, err := NewFFT(3)
	if err == nil {
		t.Fatal("expected error for non-power-of-2 size")
	}
	_, err = NewFFT(0)
	if err == nil {
		t.Fatal("expected error for size 0")
	}
	_, err = NewFFT(7)
	if err == nil {
		t.Fatal("expected error for size 7")
	}
}

func TestFFT_N8_Impulse(t *testing.T) {
	// Input: unit impulse [1,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0]
	// DFT of impulse = flat spectrum (all bins = 1+0j)
	fft, err := NewFFT(8)
	if err != nil {
		t.Fatal(err)
	}

	data := make([]float32, 16) // 2*8
	data[0] = 1.0               // re[0] = 1, everything else = 0

	fft.Transform(data)

	// All bins should have magnitude 1
	for k := 0; k < 8; k++ {
		re := data[2*k]
		im := data[2*k+1]
		mag := math.Sqrt(float64(re*re + im*im))
		if math.Abs(mag-1.0) > 1e-5 {
			t.Errorf("bin %d: expected magnitude 1.0, got %f (re=%f, im=%f)", k, mag, re, im)
		}
	}
}

func TestFFT_N8_DC(t *testing.T) {
	// Input: constant signal [1,0, 1,0, 1,0, 1,0, 1,0, 1,0, 1,0, 1,0]
	// DFT should give bin 0 = 8+0j, all other bins = 0
	fft, err := NewFFT(8)
	if err != nil {
		t.Fatal(err)
	}

	data := make([]float32, 16)
	for i := 0; i < 8; i++ {
		data[2*i] = 1.0
	}

	fft.Transform(data)

	// Bin 0 should be 8+0j
	if math.Abs(float64(data[0])-8.0) > 1e-4 {
		t.Errorf("bin 0 real: expected 8.0, got %f", data[0])
	}
	if math.Abs(float64(data[1])) > 1e-4 {
		t.Errorf("bin 0 imag: expected 0.0, got %f", data[1])
	}

	// All other bins should be ~0
	for k := 1; k < 8; k++ {
		re := data[2*k]
		im := data[2*k+1]
		mag := math.Sqrt(float64(re*re + im*im))
		if mag > 1e-4 {
			t.Errorf("bin %d: expected magnitude ~0, got %f", k, mag)
		}
	}
}

func TestFFT_N16_SineWave(t *testing.T) {
	// Input: sine wave at bin 3 frequency
	// x[n] = sin(2*pi*3*n/16)
	// Should give peak at bin 3 and bin 13 (N-3)
	n := 16
	fft, err := NewFFT(n)
	if err != nil {
		t.Fatal(err)
	}

	data := make([]float32, 2*n)
	for i := 0; i < n; i++ {
		data[2*i] = float32(math.Sin(2.0 * math.Pi * 3.0 * float64(i) / float64(n)))
		data[2*i+1] = 0
	}

	fft.Transform(data)

	// Find bin with max magnitude
	maxMag := float64(0)
	maxBin := 0
	for k := 0; k < n; k++ {
		re := float64(data[2*k])
		im := float64(data[2*k+1])
		mag := math.Sqrt(re*re + im*im)
		if mag > maxMag {
			maxMag = mag
			maxBin = k
		}
	}

	// Peak should be at bin 3 or bin 13 (N-3)
	if maxBin != 3 && maxBin != n-3 {
		t.Errorf("expected peak at bin 3 or %d, got bin %d", n-3, maxBin)
	}

	// The magnitude at bin 3 should be N/2 = 8
	mag3 := math.Sqrt(float64(data[6])*float64(data[6]) + float64(data[7])*float64(data[7]))
	if math.Abs(mag3-float64(n)/2.0) > 0.1 {
		t.Errorf("bin 3 magnitude: expected %f, got %f", float64(n)/2.0, mag3)
	}
}

func TestFFT_N1024_Parseval(t *testing.T) {
	// Parseval's theorem: sum |x[n]|^2 = (1/N) * sum |X[k]|^2
	n := 1024
	fft, err := NewFFT(n)
	if err != nil {
		t.Fatal(err)
	}

	data := make([]float32, 2*n)
	// Generate a test signal (mix of sines)
	timeEnergy := float64(0)
	for i := 0; i < n; i++ {
		val := float32(math.Sin(2.0*math.Pi*7.0*float64(i)/float64(n)) +
			0.5*math.Cos(2.0*math.Pi*23.0*float64(i)/float64(n)))
		data[2*i] = val
		data[2*i+1] = 0
		timeEnergy += float64(val * val)
	}

	fft.Transform(data)

	// Compute frequency domain energy
	freqEnergy := float64(0)
	for k := 0; k < n; k++ {
		re := float64(data[2*k])
		im := float64(data[2*k+1])
		freqEnergy += re*re + im*im
	}
	freqEnergy /= float64(n) // Parseval normalization

	relErr := math.Abs(timeEnergy-freqEnergy) / timeEnergy
	if relErr > 1e-4 {
		t.Errorf("Parseval's theorem violated: time energy=%f, freq energy (normalized)=%f, relative error=%e",
			timeEnergy, freqEnergy, relErr)
	}
}

func TestFFT_N4_Manual(t *testing.T) {
	// N=4 DFT of [1, 2, 3, 4] (real only)
	// X[0] = 1+2+3+4 = 10
	// X[1] = 1 + 2*(-j) + 3*(-1) + 4*(j) = 1 - 3 + j(4-2) = -2 + 2j
	// X[2] = 1 + 2*(-1) + 3*(1) + 4*(-1) = 1-2+3-4 = -2
	// X[3] = 1 + 2*(j) + 3*(-1) + 4*(-j) = 1-3 + j(2-4) = -2 - 2j
	fft, err := NewFFT(4)
	if err != nil {
		t.Fatal(err)
	}

	data := []float32{1, 0, 2, 0, 3, 0, 4, 0}
	fft.Transform(data)

	expected := []complex128{10 + 0i, -2 + 2i, -2 + 0i, -2 - 2i}

	for k := 0; k < 4; k++ {
		re := float64(data[2*k])
		im := float64(data[2*k+1])
		expRe := real(expected[k])
		expIm := imag(expected[k])
		if math.Abs(re-expRe) > 1e-4 || math.Abs(im-expIm) > 1e-4 {
			t.Errorf("bin %d: expected (%f, %f), got (%f, %f)", k, expRe, expIm, re, im)
		}
	}
}

func TestFFT_N64_Impulse(t *testing.T) {
	// Larger size: impulse should give flat spectrum
	n := 64
	fft, err := NewFFT(n)
	if err != nil {
		t.Fatal(err)
	}

	data := make([]float32, 2*n)
	data[0] = 1.0

	fft.Transform(data)

	for k := 0; k < n; k++ {
		re := data[2*k]
		im := data[2*k+1]
		mag := math.Sqrt(float64(re*re + im*im))
		if math.Abs(mag-1.0) > 1e-4 {
			t.Errorf("bin %d: expected magnitude 1.0, got %f", k, mag)
		}
	}
}

func BenchmarkFFT65536(b *testing.B) {
	n := 65536
	fft, err := NewFFT(n)
	if err != nil {
		b.Fatal(err)
	}

	data := make([]float32, 2*n)
	for i := 0; i < n; i++ {
		data[2*i] = float32(math.Sin(2.0 * math.Pi * float64(i) / float64(n)))
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		// Reset data each iteration (impulse)
		data[0] = 1.0
		fft.Transform(data)
	}
}

func BenchmarkFFT4096(b *testing.B) {
	n := 4096
	fft, err := NewFFT(n)
	if err != nil {
		b.Fatal(err)
	}

	data := make([]float32, 2*n)
	for i := 0; i < n; i++ {
		data[2*i] = float32(math.Sin(2.0 * math.Pi * float64(i) / float64(n)))
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		fft.Transform(data)
	}
}
