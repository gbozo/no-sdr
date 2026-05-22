package dsp

import (
	"log/slog"
	"math"
	"math/cmplx"
	"testing"
)

func TestDecimate_ReducesLength(t *testing.T) {
	d := NewDecimateBlock(10)
	err := d.Init(BlockContext{SampleRate: 240000, Logger: slog.Default()})
	if err != nil {
		t.Fatal(err)
	}

	expectedOut := 95
	in := make([]complex64, 1000)
	out := make([]complex64, expectedOut+5)
	for i := range in {
		in[i] = complex(float32(i), float32(-i))
	}

	n := d.ProcessComplex(in, out)
	if n != expectedOut {
		t.Fatalf("expected %d output samples, got %d", expectedOut, n)
	}
}

func TestDecimate_CumulativePhase(t *testing.T) {
	// Verify that decimation phase is maintained correctly across
	// multiple ProcessComplex calls (simulating chunked input).
	factor := 10
	d := NewDecimateBlock(factor)
	err := d.Init(BlockContext{SampleRate: 240000, Logger: slog.Default()})
	if err != nil {
		t.Fatal(err)
	}

	inPhaseFreq := 0.01
	outPhaseFreq := inPhaseFreq * float64(factor) // 0.1

	// Two consecutive 1000-sample chunks
	chunk1 := make([]complex64, 1000)
	chunk2 := make([]complex64, 1000)
	for i := range chunk1 {
		phase := 2.0 * math.Pi * inPhaseFreq * float64(i)
		chunk1[i] = complex(float32(math.Cos(phase)), float32(math.Sin(phase)))
		phase = 2.0 * math.Pi * inPhaseFreq * float64(i+1000)
		chunk2[i] = complex(float32(math.Cos(phase)), float32(math.Sin(phase)))
	}

	out1 := make([]complex64, 120)
	out2 := make([]complex64, 120)

	n1 := d.ProcessComplex(chunk1, out1)
	n2 := d.ProcessComplex(chunk2, out2)

	if n1 <= 0 || n2 <= 0 {
		t.Fatal("expected output from both chunks")
	}

	// The last output from chunk1 and the first from chunk2 should have
	// a phase advance of 2*pi*f_out (one output sample period).
	last1 := out1[n1-1]
	first2 := out2[0]

	expectedPhaseInc := 2.0 * math.Pi * outPhaseFreq
	expected := complex128(last1) * complex(math.Cos(expectedPhaseInc), math.Sin(expectedPhaseInc))
	conj := complex128(first2) * cmplx.Conj(expected)
	phaseErr := cmplx.Phase(conj)
	t.Logf("phase error across chunk boundary: %f rad (expected ~0)", phaseErr)
	if math.Abs(phaseErr) > 0.1 {
		t.Errorf("phase discontinuity across chunks: %f rad", phaseErr)
	}

	// Magnitude should be consistent
	mag1 := cmplx.Abs(complex128(last1))
	mag2 := cmplx.Abs(complex128(first2))
	t.Logf("mag1=%f mag2=%f", mag1, mag2)
	if math.Abs(mag1-mag2) > 0.01 {
		t.Errorf("magnitude discontinuity across chunks: %f vs %f", mag1, mag2)
	}
}

func TestDecimate_AliasingRejection(t *testing.T) {
	// Verify the FIR filter rejects out-of-band energy.
	// Generate a tone at 3× cutoff (which would alias into passband
	// with simple decimation). After FIR decimation, the amplitude
	// should be significantly attenuated.
	factor := 10
	d := NewDecimateBlock(factor)
	err := d.Init(BlockContext{SampleRate: 240000, Logger: slog.Default()})
	if err != nil {
		t.Fatal(err)
	}

	cutoff := 0.5 / float64(factor)

	// Use a tone well into the stopband (5× cutoff)
	toneFreq := cutoff * 5.0
	numIn := 24000
	in := make([]complex64, numIn)
	out := make([]complex64, numIn/factor)

	for i := 0; i < numIn; i++ {
		phase := 2.0 * math.Pi * toneFreq * float64(i)
		in[i] = complex(float32(math.Cos(phase)), float32(math.Sin(phase)))
	}

	n := d.ProcessComplex(in, out)
	if n == 0 {
		t.Fatal("expected output")
	}

	var totalMag float64
	for i := 0; i < n; i++ {
		re := float64(real(out[i]))
		im := float64(imag(out[i]))
		totalMag += math.Sqrt(re*re + im*im)
	}
	avgMag := totalMag / float64(n)

	t.Logf("avg out-of-band magnitude at %dx cutoff: %f (should be < 0.001)", 5, avgMag)
	if avgMag > 0.001 {
		t.Errorf("out-of-band tone avg magnitude %f, expected < 0.001", avgMag)
	}
}

func TestDecimate_FrequencyResponse(t *testing.T) {
	// Measure frequency response at several points to validate filter.
	factor := 10
	d := NewDecimateBlock(factor)
	err := d.Init(BlockContext{SampleRate: 240000, Logger: slog.Default()})
	if err != nil {
		t.Fatal(err)
	}

	type measurement struct {
		freqNorm float64 // normalized frequency (0..0.5)
		label    string
	}
	points := []measurement{
		{0.01, "near DC"},
		{0.04, "near passband edge"},
		{0.06, "in transition band"},
		{0.10, "in stopband (2× cutoff)"},
		{0.25, "deep stopband"},
	}

	numIn := 48000
	for _, p := range points {
		d.Reset()
		in := make([]complex64, numIn)
		out := make([]complex64, numIn/factor)
		for i := 0; i < numIn; i++ {
			phase := 2.0 * math.Pi * p.freqNorm * float64(i)
			in[i] = complex(float32(math.Cos(phase)), float32(math.Sin(phase)))
		}
		n := d.ProcessComplex(in, out)
		if n == 0 {
			continue
		}
		var totalMag float64
		for i := 0; i < n; i++ {
			re := float64(real(out[i]))
			im := float64(imag(out[i]))
			totalMag += math.Sqrt(re*re + im*im)
		}
		avgMag := totalMag / float64(n)
		attDB := 20.0 * math.Log10(avgMag)
		t.Logf("  f=%.3f (%s): avgMag=%.6f (%.1f dB)", p.freqNorm, p.label, avgMag, attDB)
	}
}

func TestDecimate_InBandPasses(t *testing.T) {
	factor := 10
	d := NewDecimateBlock(factor)
	err := d.Init(BlockContext{SampleRate: 240000, Logger: slog.Default()})
	if err != nil {
		t.Fatal(err)
	}

	numIn := 24000
	in := make([]complex64, numIn)
	out := make([]complex64, numIn/factor)

	toneFreq := 0.5 / float64(factor) * 0.1
	for i := 0; i < numIn; i++ {
		phase := 2.0 * math.Pi * toneFreq * float64(i)
		in[i] = complex(float32(math.Cos(phase)), float32(math.Sin(phase)))
	}

	n := d.ProcessComplex(in, out)
	if n == 0 {
		t.Fatal("expected output")
	}

	var avgMag float64
	for i := 0; i < n; i++ {
		re := float64(real(out[i]))
		im := float64(imag(out[i]))
		avgMag += math.Sqrt(re*re + im*im)
	}
	avgMag /= float64(n)

	t.Logf("avg in-band magnitude: %f (should be close to 1.0)", avgMag)
	if avgMag < 0.5 {
		t.Errorf("in-band tone attenuated to %f, expected > 0.5", avgMag)
	}
}

func TestDecimate_DCPasses(t *testing.T) {
	factor := 10
	d := NewDecimateBlock(factor)
	err := d.Init(BlockContext{SampleRate: 240000, Logger: slog.Default()})
	if err != nil {
		t.Fatal(err)
	}

	numIn := 2000
	in := make([]complex64, numIn)
	out := make([]complex64, numIn/factor)

	for i := range in {
		in[i] = complex(1.0, 0.0)
	}

	n := d.ProcessComplex(in, out)
	if n == 0 {
		t.Fatal("expected output")
	}

	var avgRe, avgIm float64
	for i := 0; i < n; i++ {
		avgRe += float64(real(out[i]))
		avgIm += float64(imag(out[i]))
	}
	avgRe /= float64(n)
	avgIm /= float64(n)

	if avgRe < 0.5 || avgRe > 1.5 {
		t.Errorf("DC I magnitude: %f, expected ~1.0", avgRe)
	}
	if avgIm > 0.01 {
		t.Errorf("DC Q magnitude: %f, expected ~0.0", avgIm)
	}
}

func TestDecimate_FilterTaps(t *testing.T) {
	// Quick sanity on the filter taps.
	factor := 10
	d := NewDecimateBlock(factor)
	err := d.Init(BlockContext{SampleRate: 240000, Logger: slog.Default()})
	if err != nil {
		t.Fatal(err)
	}

	taps := d.PrototypeTaps()
	var tapSum float32
	for _, v := range taps {
		tapSum += v
	}

	t.Logf("numTaps=%d, tap sum=%f (should be ~1.0)", len(taps), tapSum)
	if math.Abs(float64(tapSum-1.0)) > 0.01 {
		t.Errorf("filter taps do not sum to 1.0: sum=%f", tapSum)
	}

	// Frequency response at f=0.15 (3x cutoff for factor=10)
	var hRe, hIm float64
	for k, h := range taps {
		angle := -2.0 * math.Pi * 0.15 * float64(k)
		hRe += float64(h) * math.Cos(angle)
		hIm += float64(h) * math.Sin(angle)
	}
	respMag := math.Sqrt(hRe*hRe + hIm*hIm)
	respDB := 20.0 * math.Log10(respMag)
	t.Logf("|H(0.15)| = %f (%.1f dB)", respMag, respDB)

	// At 3x cutoff, should be well into stopband
	if respDB > -40 {
		t.Errorf("Frequency response at 3x cutoff is only %.1f dB (expected < -40 dB)", respDB)
	}
}

func TestDecimate_SampleRateOut(t *testing.T) {
	d := NewDecimateBlock(10)
	rate := d.SampleRateOut(2400000)
	if rate != 240000 {
		t.Fatalf("expected 240000, got %f", rate)
	}
}

func TestDecimate_Name(t *testing.T) {
	d := NewDecimateBlock(4)
	if d.Name() != "decimate" {
		t.Fatalf("expected 'decimate', got '%s'", d.Name())
	}
}

func BenchmarkDecimate(b *testing.B) {
	d := NewDecimateBlock(10)
	d.Init(BlockContext{SampleRate: 2400000, Logger: slog.Default()})

	in := make([]complex64, 2400000)
	out := make([]complex64, 240000)
	for i := range in {
		in[i] = complex(float32(i%256)/128.0-1.0, float32((i+64)%256)/128.0-1.0)
	}

	b.SetBytes(int64(len(in)) * 8)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		d.ProcessComplex(in, out)
	}
}


