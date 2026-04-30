package dsp

import (
	"log/slog"
	"math"
	"math/cmplx"
	"testing"
)

func TestNCO_ZeroOffset(t *testing.T) {
	nco := NewNCOBlock(0)
	err := nco.Init(BlockContext{SampleRate: 48000, Logger: slog.Default()})
	if err != nil {
		t.Fatal(err)
	}

	in := make([]complex64, 1024)
	out := make([]complex64, 1024)
	for i := range in {
		in[i] = complex(float32(i)/1024.0, float32(i)/2048.0)
	}

	n := nco.ProcessComplex(in, out)
	if n != 1024 {
		t.Fatalf("expected 1024 samples, got %d", n)
	}

	for i := range out {
		// With zero offset, output should equal input
		diffRe := math.Abs(float64(real(out[i]) - real(in[i])))
		diffIm := math.Abs(float64(imag(out[i]) - imag(in[i])))
		if diffRe > 1e-5 || diffIm > 1e-5 {
			t.Fatalf("sample %d: expected %v, got %v", i, in[i], out[i])
		}
	}
}

func TestNCO_FrequencyShift(t *testing.T) {
	sampleRate := 48000.0
	offsetHz := 1000.0
	nco := NewNCOBlock(offsetHz)
	err := nco.Init(BlockContext{SampleRate: sampleRate, Logger: slog.Default()})
	if err != nil {
		t.Fatal(err)
	}

	// Generate a pure tone at 5000 Hz
	toneHz := 5000.0
	numSamples := 4096
	in := make([]complex64, numSamples)
	out := make([]complex64, numSamples)

	for i := range in {
		angle := 2.0 * math.Pi * toneHz * float64(i) / sampleRate
		in[i] = complex(float32(math.Cos(angle)), float32(math.Sin(angle)))
	}

	nco.ProcessComplex(in, out)

	// After shifting by -1000 Hz (NCO mixes with exp(-j*phase)), the tone should be at 4000 Hz.
	// Verify by measuring the output frequency:
	// Compute average angular velocity between consecutive samples.
	var totalAngle float64
	for i := 1; i < numSamples; i++ {
		prev := complex128(out[i-1])
		curr := complex128(out[i])
		diff := curr * cmplx.Conj(prev)
		totalAngle += cmplx.Phase(diff)
	}
	avgPhasePerSample := totalAngle / float64(numSamples-1)
	measuredFreq := avgPhasePerSample * sampleRate / (2.0 * math.Pi)

	expectedFreq := toneHz - offsetHz // 4000 Hz
	if math.Abs(measuredFreq-expectedFreq) > 5.0 {
		t.Fatalf("expected shifted freq ~%.0f Hz, measured %.1f Hz", expectedFreq, measuredFreq)
	}
}

func TestNCO_SetOffset(t *testing.T) {
	nco := NewNCOBlock(1000)
	err := nco.Init(BlockContext{SampleRate: 48000, Logger: slog.Default()})
	if err != nil {
		t.Fatal(err)
	}

	nco.SetOffset(2000)
	expectedInc := 2.0 * math.Pi * 2000.0 / 48000.0
	if math.Abs(nco.phaseInc-expectedInc) > 1e-10 {
		t.Fatalf("expected phaseInc %f, got %f", expectedInc, nco.phaseInc)
	}
}

func TestNCO_Reset(t *testing.T) {
	nco := NewNCOBlock(1000)
	err := nco.Init(BlockContext{SampleRate: 48000, Logger: slog.Default()})
	if err != nil {
		t.Fatal(err)
	}

	// Process some samples to advance phase
	in := make([]complex64, 100)
	out := make([]complex64, 100)
	for i := range in {
		in[i] = complex(1, 0)
	}
	nco.ProcessComplex(in, out)

	if nco.phase == 0 {
		t.Fatal("phase should be non-zero after processing")
	}

	nco.Reset()
	if nco.phase != 0 {
		t.Fatalf("expected phase 0 after reset, got %f", nco.phase)
	}
}

func BenchmarkNCO(b *testing.B) {
	nco := NewNCOBlock(100000)
	nco.Init(BlockContext{SampleRate: 2400000, Logger: slog.Default()})

	in := make([]complex64, 2400000)
	out := make([]complex64, 2400000)
	for i := range in {
		in[i] = complex(float32(i%256)/128.0-1.0, float32((i+64)%256)/128.0-1.0)
	}

	b.SetBytes(int64(len(in)) * 8) // 8 bytes per complex64
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		nco.ProcessComplex(in, out)
	}
}
