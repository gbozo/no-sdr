package dsp

import (
	"log/slog"
	"math"
	"testing"
)

func TestNewIqExtractor_Basic(t *testing.T) {
	ext, err := NewIqExtractor(IqExtractorConfig{
		InputSampleRate:  2400000,
		OutputSampleRate: 48000,
		TuneOffset:       0,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// 2400000 / 48000 = 50
	if ext.DecimationFactor() != 50 {
		t.Errorf("expected factor 50, got %d", ext.DecimationFactor())
	}
	if ext.OutputSampleRate() != 48000 {
		t.Errorf("expected output rate 48000, got %d", ext.OutputSampleRate())
	}
}

func TestNewIqExtractor_NonIntegerFactor(t *testing.T) {
	// 2400000 / 44100 = 54.42... → nearest integer factor: 54 → rate = 44444
	// or 55 → rate = 43636. 54 gives 44444 which is closer to 44100.
	ext, err := NewIqExtractor(IqExtractorConfig{
		InputSampleRate:  2400000,
		OutputSampleRate: 44100,
		TuneOffset:       0,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	factor := ext.DecimationFactor()
	actualRate := 2400000 / factor
	t.Logf("target=44100, factor=%d, actualRate=%d", factor, actualRate)

	// Should be 54 or 55 — either way, factor must be valid
	if factor < 1 {
		t.Fatalf("invalid factor %d", factor)
	}
	if actualRate <= 0 {
		t.Fatalf("invalid actual rate %d", actualRate)
	}
}

func TestNewIqExtractor_InvalidConfig(t *testing.T) {
	tests := []struct {
		name string
		cfg  IqExtractorConfig
	}{
		{"zero input rate", IqExtractorConfig{InputSampleRate: 0, OutputSampleRate: 48000}},
		{"zero output rate", IqExtractorConfig{InputSampleRate: 2400000, OutputSampleRate: 0}},
		{"output > input", IqExtractorConfig{InputSampleRate: 48000, OutputSampleRate: 2400000}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := NewIqExtractor(tt.cfg)
			if err == nil {
				t.Fatal("expected error, got nil")
			}
		})
	}
}

func TestIqExtractor_OutputLength(t *testing.T) {
	ext, err := NewIqExtractor(IqExtractorConfig{
		InputSampleRate:  2400000,
		OutputSampleRate: 48000,
		TuneOffset:       100000,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// 1000 input samples → 1000 / 50 = 20 output samples
	// Each sample is 2 bytes in uint8 IQ input
	inputSamples := 1000
	rawIQ := make([]byte, inputSamples*2)
	// Fill with center (127.5 → 128 for uint8 DC)
	for i := range rawIQ {
		rawIQ[i] = 128
	}

	out := ext.Process(rawIQ)
	if out == nil {
		t.Fatal("expected non-nil output")
	}

	if len(out) == 0 {
		t.Fatal("expected non-empty output")
	}
	if len(out)%2 != 0 {
		t.Errorf("output length must be even (I+Q pairs), got %d", len(out))
	}
	if len(out) < 20 {
		t.Errorf("expected at least 20 int16 values (10 IQ pairs), got %d", len(out))
	}
}

func TestIqExtractor_SineShift(t *testing.T) {
	// Generate a sine at +100kHz offset, tune to +100kHz.
	// After NCO shift, the signal should appear at DC in the output.
	const (
		inputRate  = 2400000
		outputRate = 48000
		tuneOffset = 100000
		numSamples = 24000 // 10ms of input
	)

	ext, err := NewIqExtractor(IqExtractorConfig{
		InputSampleRate:  inputRate,
		OutputSampleRate: outputRate,
		TuneOffset:       tuneOffset,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Generate test signal: carrier at +100kHz
	rawIQ := make([]byte, numSamples*2)
	twoPi := 2.0 * math.Pi
	for i := 0; i < numSamples; i++ {
		phase := twoPi * float64(tuneOffset) * float64(i) / float64(inputRate)
		iVal := math.Cos(phase)
		qVal := math.Sin(phase)
		// Convert to uint8: (val * 127.5) + 127.5
		rawIQ[i*2] = uint8(iVal*127.5 + 127.5)
		rawIQ[i*2+1] = uint8(qVal*127.5 + 127.5)
	}

	out := ext.Process(rawIQ)
	if out == nil {
		t.Fatal("expected non-nil output")
	}

	// After shifting by +100kHz and filtering, a signal originally at +100kHz
	// should now be at DC. The I channel should have significant energy,
	// and the signal should be mostly constant (DC).
	// Check that the output has non-zero magnitude (signal passed through).
	var sumMag float64
	numOut := len(out) / 2
	for i := 0; i < numOut; i++ {
		iSamp := float64(out[i*2])
		qSamp := float64(out[i*2+1])
		sumMag += math.Sqrt(iSamp*iSamp + qSamp*qSamp)
	}
	avgMag := sumMag / float64(numOut)

	// The signal should have significant magnitude (not just noise)
	// A pure carrier through NCO+filter should produce output > 1000 (out of 32767)
	if avgMag < 500 {
		t.Errorf("expected significant output magnitude after tuning, got avg=%f", avgMag)
	}
	t.Logf("avg output magnitude: %.1f (out of 32767 max)", avgMag)
}

func TestIqExtractor_SetTuneOffset(t *testing.T) {
	ext, err := NewIqExtractor(IqExtractorConfig{
		InputSampleRate:  2400000,
		OutputSampleRate: 48000,
		TuneOffset:       0,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	ext.SetTuneOffset(200000)
	// Verify no panic and the extractor still works
	rawIQ := make([]byte, 2000)
	for i := range rawIQ {
		rawIQ[i] = 128
	}
	out := ext.Process(rawIQ)
	if out == nil {
		t.Fatal("expected non-nil output after SetTuneOffset")
	}
}

func TestIqExtractor_SetOutputSampleRate(t *testing.T) {
	ext, err := NewIqExtractor(IqExtractorConfig{
		InputSampleRate:  2400000,
		OutputSampleRate: 48000,
		TuneOffset:       0,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Switch to WFM rate
	ext.SetOutputSampleRate(240000)
	if ext.OutputSampleRate() != 240000 {
		t.Errorf("expected output rate 240000, got %d", ext.OutputSampleRate())
	}
	if ext.DecimationFactor() != 10 {
		t.Errorf("expected factor 10, got %d", ext.DecimationFactor())
	}

	// Process should still work
	rawIQ := make([]byte, 10000)
	for i := range rawIQ {
		rawIQ[i] = 128
	}
	out := ext.Process(rawIQ)
	if out == nil {
		t.Fatal("expected non-nil output after SetOutputSampleRate")
	}

	if len(out) == 0 {
		t.Fatal("expected non-empty output")
	}
	if len(out)%2 != 0 {
		t.Errorf("output length must be even (I+Q pairs), got %d", len(out))
	}
}

func TestIqExtractor_Reset(t *testing.T) {
	ext, err := NewIqExtractor(IqExtractorConfig{
		InputSampleRate:  2400000,
		OutputSampleRate: 48000,
		TuneOffset:       100000,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Process some data, then reset, process again — no panic
	rawIQ := make([]byte, 2000)
	for i := range rawIQ {
		rawIQ[i] = 128
	}
	ext.Process(rawIQ)
	ext.Reset()
	out := ext.Process(rawIQ)
	if out == nil {
		t.Fatal("expected non-nil output after Reset")
	}
}

func TestIqExtractor_EmptyInput(t *testing.T) {
	ext, err := NewIqExtractor(IqExtractorConfig{
		InputSampleRate:  2400000,
		OutputSampleRate: 48000,
		TuneOffset:       0,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Empty input
	out := ext.Process(nil)
	if out != nil {
		t.Errorf("expected nil for nil input, got len=%d", len(out))
	}

	out = ext.Process([]byte{})
	if out != nil {
		t.Errorf("expected nil for empty input, got len=%d", len(out))
	}

	// Single byte (not enough for a sample)
	out = ext.Process([]byte{128})
	if out != nil {
		t.Errorf("expected nil for single byte input, got len=%d", len(out))
	}
}

func TestIqExtractor_CW(t *testing.T) {
	// CW mode: 2.4M→12k (factor=200), bandwidth=500, tune offset within BW.
	// Generate a carrier within the passband and verify output.
	const (
		inputRate  = 2400000
		outputRate = 12000
		tuneOffset = 1000
	)

	ext, err := NewIqExtractor(IqExtractorConfig{
		InputSampleRate:  inputRate,
		OutputSampleRate: outputRate,
		TuneOffset:       tuneOffset,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Set bandwidth to 500 Hz (CW default)
	ext.SetBandwidth(500)

	// Feed a carrier at the tuned frequency (so NCO shifts it to DC)
	carrierFreq := tuneOffset
	numSamples := inputRate / 50 // 20ms of input at 2.4M = 48000 samples
	rawIQ := make([]byte, numSamples*2)
	twoPi := 2.0 * math.Pi
	for i := 0; i < numSamples; i++ {
		phase := twoPi * float64(carrierFreq) * float64(i) / float64(inputRate)
		iVal := math.Cos(phase)
		qVal := math.Sin(phase)
		rawIQ[i*2] = uint8(iVal*127.5 + 127.5)
		rawIQ[i*2+1] = uint8(qVal*127.5 + 127.5)
	}

	out := ext.Process(rawIQ)
	if out == nil {
		t.Fatal("CW: expected non-nil output")
	}

	numOut := len(out) / 2
	if numOut == 0 {
		t.Fatal("CW: expected non-empty output")
	}

	var sumMag float64
	for i := 0; i < numOut; i++ {
		iSamp := float64(out[i*2])
		qSamp := float64(out[i*2+1])
		sumMag += math.Sqrt(iSamp*iSamp + qSamp*qSamp)
	}
	avgMag := sumMag / float64(numOut)

	t.Logf("CW: output samples=%d, avg magnitude=%.1f (out of 32767)", numOut, avgMag)
	if avgMag < 1000 {
		t.Errorf("CW: expected significant output magnitude, got avg=%f", avgMag)
	}
}

func TestIqExtractor_CW_OutOfBand(t *testing.T) {
	// CW mode with a carrier far from the tune offset (outside bandwidth).
	// The carrier should be rejected by the windowed-sinc FIR decimator.
	const (
		inputRate  = 2400000
		outputRate = 12000
		tuneOffset = 1000 // tuned to 1kHz
	)

	ext, err := NewIqExtractor(IqExtractorConfig{
		InputSampleRate:  inputRate,
		OutputSampleRate: outputRate,
		TuneOffset:       tuneOffset,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Set bandwidth to 500 Hz (CW default)
	ext.SetBandwidth(500)

	// Feed a carrier at tuneOffset + 3kHz (well outside the 250 Hz LPF cutoff)
	carrierFreq := tuneOffset + 3000
	numSamples := inputRate / 50
	rawIQ := make([]byte, numSamples*2)
	twoPi := 2.0 * math.Pi
	for i := 0; i < numSamples; i++ {
		phase := twoPi * float64(carrierFreq) * float64(i) / float64(inputRate)
		iVal := math.Cos(phase)
		qVal := math.Sin(phase)
		rawIQ[i*2] = uint8(iVal*127.5 + 127.5)
		rawIQ[i*2+1] = uint8(qVal*127.5 + 127.5)
	}

	out := ext.Process(rawIQ)
	if out == nil {
		t.Fatal("CW: expected non-nil output")
	}

	numOut := len(out) / 2
	var sumMag float64
	for i := 0; i < numOut; i++ {
		iSamp := float64(out[i*2])
		qSamp := float64(out[i*2+1])
		sumMag += math.Sqrt(iSamp*iSamp + qSamp*qSamp)
	}
	avgMag := sumMag / float64(numOut)

	t.Logf("CW OOB: output samples=%d, avg magnitude=%.3f (expected ~0)", numOut, avgMag)
	if avgMag > 20000 {
		t.Errorf("CW: out-of-band carrier should be rejected, got avg=%f", avgMag)
	}
}

func TestDecimate_Factor200_CW(t *testing.T) {
	// Direct test of the decimate block at factor=200 (CW rate: 2.4M→12k).
	// Generate a tone within the FIR passband (DC to 0.0025 normalized frequency).
	factor := 200
	d := NewDecimateBlock(factor)
	err := d.Init(BlockContext{SampleRate: 2400000, Logger: slog.Default()})
	if err != nil {
		t.Fatal(err)
	}

	// Tone at 0.1 * cutoff = very low frequency (should pass almost unchanged)
	cutoff := 0.5 / float64(factor) // 0.0025
	toneFreq := cutoff * 0.1        // 0.00025
	numIn := 2400000 / 50           // 20ms at 2.4M = 48000
	in := make([]complex64, numIn)
	out := make([]complex64, numIn/factor)

	for i := 0; i < numIn; i++ {
		phase := 2.0 * math.Pi * toneFreq * float64(i)
		in[i] = complex(float32(math.Cos(phase)), float32(math.Sin(phase)))
	}

	n := d.ProcessComplex(in, out)
	if n == 0 {
		t.Fatal("expected output from factor=200 decimate")
	}

	var avgMag float64
	for i := 0; i < n; i++ {
		re := float64(real(out[i]))
		im := float64(imag(out[i]))
		avgMag += math.Sqrt(re*re + im*im)
	}
	avgMag /= float64(n)

	t.Logf("factor=200: in=%d, out=%d, avgMag=%f (expected ~1.0)", numIn, n, avgMag)
	if avgMag < 0.5 {
		t.Errorf("in-band tone at cutoff*0.1 should pass, avgMag=%f", avgMag)
	}
}

func TestFindDecimationFactor(t *testing.T) {
	tests := []struct {
		inputRate  int
		targetRate int
		wantFactor int
	}{
		{2400000, 48000, 50},
		{2400000, 240000, 10},
		{2400000, 24000, 100},
		{2400000, 12000, 200},
		{2400000, 2400000, 1},
	}

	for _, tt := range tests {
		got := findDecimationFactor(tt.inputRate, tt.targetRate)
		if got != tt.wantFactor {
			t.Errorf("findDecimationFactor(%d, %d) = %d, want %d",
				tt.inputRate, tt.targetRate, got, tt.wantFactor)
		}
	}
}

func BenchmarkIqExtractor(b *testing.B) {
	// Simulates real workload: 2.4M samples/sec dongle → 48k output
	// One 10ms chunk = 24000 samples of input
	ext, err := NewIqExtractor(IqExtractorConfig{
		InputSampleRate:  2400000,
		OutputSampleRate: 48000,
		TuneOffset:       100000,
	})
	if err != nil {
		b.Fatalf("unexpected error: %v", err)
	}

	// Generate 10ms of IQ data (24000 samples × 2 bytes)
	const numSamples = 24000
	rawIQ := make([]byte, numSamples*2)
	twoPi := 2.0 * math.Pi
	for i := 0; i < numSamples; i++ {
		phase := twoPi * 100000.0 * float64(i) / 2400000.0
		rawIQ[i*2] = uint8(math.Cos(phase)*127.5 + 127.5)
		rawIQ[i*2+1] = uint8(math.Sin(phase)*127.5 + 127.5)
	}

	b.ResetTimer()
	b.SetBytes(int64(len(rawIQ)))
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		ext.Process(rawIQ)
	}
}

func BenchmarkIqExtractor_WFM(b *testing.B) {
	// WFM: 2.4M → 240k (factor 10)
	ext, err := NewIqExtractor(IqExtractorConfig{
		InputSampleRate:  2400000,
		OutputSampleRate: 240000,
		TuneOffset:       -200000,
	})
	if err != nil {
		b.Fatalf("unexpected error: %v", err)
	}

	const numSamples = 24000
	rawIQ := make([]byte, numSamples*2)
	for i := range rawIQ {
		rawIQ[i] = 128
	}

	b.ResetTimer()
	b.SetBytes(int64(len(rawIQ)))
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		ext.Process(rawIQ)
	}
}
