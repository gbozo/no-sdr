package demod

import (
	"math"
	"testing"

	"github.com/gbozo/no-sdr/serverng/internal/dsp"
)

// generateFmSignal creates a known FM-modulated complex signal.
// modFreq is the modulating frequency, deviation is the max frequency deviation.
func generateFmSignal(n int, sampleRate, carrierFreq, modFreq, deviation float64) []complex64 {
	out := make([]complex64, n)
	for i := 0; i < n; i++ {
		t := float64(i) / sampleRate
		// FM: phase = 2*pi*fc*t + (deviation/modFreq)*sin(2*pi*modFreq*t)
		phase := 2*math.Pi*carrierFreq*t + (deviation/modFreq)*math.Sin(2*math.Pi*modFreq*t)
		out[i] = complex(float32(math.Cos(phase)), float32(math.Sin(phase)))
	}
	return out
}

func TestFmMonoDemod(t *testing.T) {
	sampleRate := 240000.0
	modFreq := 1000.0   // 1kHz modulating tone
	deviation := 75000.0 // standard FM deviation
	n := 24000           // 100ms of data

	// Generate FM signal (carrier at 0 Hz since it's already baseband)
	signal := generateFmSignal(n, sampleRate, 0, modFreq, deviation)

	demod := NewFmMonoDemod(50e-6)
	ctx := dsp.BlockContext{SampleRate: sampleRate, BlockSize: n}
	if err := demod.Init(ctx); err != nil {
		t.Fatalf("Init failed: %v", err)
	}

	out := make([]float32, n)
	written := demod.Process(signal, out)
	if written != n {
		t.Fatalf("expected %d samples, got %d", n, written)
	}

	// After settling (skip first 10%), check that output is a ~1kHz sine
	// The demodulated signal should be periodic with period = sampleRate/modFreq
	period := int(sampleRate / modFreq)
	start := n / 4 // skip transient

	// Find zero crossings to verify frequency
	crossings := 0
	for i := start + 1; i < n; i++ {
		if (out[i-1] < 0 && out[i] >= 0) || (out[i-1] >= 0 && out[i] < 0) {
			crossings++
		}
	}

	// Expected crossings: 2 per period × remaining samples / period
	remainingSamples := n - start
	expectedCrossings := 2 * remainingSamples / period
	tolerance := expectedCrossings / 5 // 20% tolerance

	if math.Abs(float64(crossings-expectedCrossings)) > float64(tolerance) {
		t.Errorf("frequency mismatch: expected ~%d zero crossings, got %d", expectedCrossings, crossings)
	}

	// Check amplitude is reasonable (normalized to ±1 before de-emphasis)
	maxAmp := float32(0)
	for i := start; i < n; i++ {
		a := float32(math.Abs(float64(out[i])))
		if a > maxAmp {
			maxAmp = a
		}
	}
	if maxAmp < 0.01 {
		t.Errorf("output amplitude too low: %f", maxAmp)
	}
	if maxAmp > 2.0 {
		t.Errorf("output amplitude too high: %f", maxAmp)
	}
}

func TestFmMonoReset(t *testing.T) {
	demod := NewFmMonoDemod(50e-6)
	ctx := dsp.BlockContext{SampleRate: 240000, BlockSize: 1024}
	demod.Init(ctx)

	// Process some data
	in := make([]complex64, 1024)
	out := make([]float32, 1024)
	for i := range in {
		in[i] = complex(float32(i)/1024, float32(i)/2048)
	}
	demod.Process(in, out)

	// Reset and verify state cleared
	demod.Reset()
	if demod.prevI != 0 || demod.prevQ != 0 || demod.deemphState != 0 {
		t.Error("Reset did not clear state")
	}
}

func TestFmStereoPilotDetection(t *testing.T) {
	sampleRate := 240000.0
	n := 48000 // 200ms

	// Generate composite stereo signal with 19kHz pilot
	composite := make([]complex64, n)
	for i := 0; i < n; i++ {
		t_sec := float64(i) / sampleRate
		// Simple composite: pilot at 19kHz + some audio at 1kHz
		pilot := 0.1 * math.Sin(2*math.Pi*19000*t_sec)
		audio := 0.5 * math.Sin(2*math.Pi*1000*t_sec)
		// FM modulate the composite
		modPhase := (audio + pilot) * 0.5
		composite[i] = complex(float32(math.Cos(modPhase)), float32(math.Sin(modPhase)))
	}

	demod := NewFmStereoDemod(50e-6)
	ctx := dsp.BlockContext{SampleRate: sampleRate, BlockSize: n}
	if err := demod.Init(ctx); err != nil {
		t.Fatalf("Init failed: %v", err)
	}

	out := make([]float32, 2*n)
	written := demod.Process(composite, out)
	if written != 2*n {
		t.Fatalf("expected %d samples, got %d", 2*n, written)
	}

	// Blend factor should be a value between 0 and 1
	blend := demod.BlendFactor()
	if blend < 0 || blend > 1 {
		t.Errorf("blend factor out of range: %f", blend)
	}
}

func TestFmStereoOutputInterleaved(t *testing.T) {
	sampleRate := 240000.0
	n := 4800

	in := make([]complex64, n)
	for i := range in {
		phase := float64(i) * 0.01
		in[i] = complex(float32(math.Cos(phase)), float32(math.Sin(phase)))
	}

	demod := NewFmStereoDemod(50e-6)
	ctx := dsp.BlockContext{SampleRate: sampleRate, BlockSize: n}
	demod.Init(ctx)

	out := make([]float32, 2*n)
	written := demod.Process(in, out)
	if written != 2*n {
		t.Errorf("expected %d interleaved samples, got %d", 2*n, written)
	}
}

func TestFastAtan2(t *testing.T) {
	tests := []struct {
		y, x     float32
		expected float32
		tol      float32
	}{
		{0, 0, 0, 0},
		{1, 0, math.Pi / 2, 0.01},
		{0, 1, 0, 0.01},
		{-1, 0, -math.Pi / 2, 0.01},
		{0, -1, math.Pi, 0.01},
		{1, 1, math.Pi / 4, 0.01},
		{-1, 1, -math.Pi / 4, 0.01},
		{1, -1, 3 * math.Pi / 4, 0.01},
		{-1, -1, -3 * math.Pi / 4, 0.01},
	}

	for _, tt := range tests {
		got := fastAtan2(tt.y, tt.x)
		if math.Abs(float64(got-tt.expected)) > float64(tt.tol) {
			t.Errorf("fastAtan2(%f, %f) = %f, want %f (tol %f)",
				tt.y, tt.x, got, tt.expected, tt.tol)
		}
	}
}

func BenchmarkFmMono(b *testing.B) {
	sampleRate := 240000.0
	n := 4096
	signal := generateFmSignal(n, sampleRate, 0, 1000, 75000)
	out := make([]float32, n)

	demod := NewFmMonoDemod(50e-6)
	ctx := dsp.BlockContext{SampleRate: sampleRate, BlockSize: n}
	demod.Init(ctx)

	b.ResetTimer()
	b.SetBytes(int64(n * 8)) // complex64 = 8 bytes
	for i := 0; i < b.N; i++ {
		demod.Process(signal, out)
	}
}

func BenchmarkFmStereo(b *testing.B) {
	sampleRate := 240000.0
	n := 4096
	signal := generateFmSignal(n, sampleRate, 0, 1000, 75000)
	out := make([]float32, 2*n)

	demod := NewFmStereoDemod(50e-6)
	ctx := dsp.BlockContext{SampleRate: sampleRate, BlockSize: n}
	demod.Init(ctx)

	b.ResetTimer()
	b.SetBytes(int64(n * 8))
	for i := 0; i < b.N; i++ {
		demod.Process(signal, out)
	}
}
