package demod

import (
	"math"
	"testing"

	"github.com/gbozo/no-sdr/serverng/internal/dsp"
)

func TestSsbDemod(t *testing.T) {
	sampleRate := 12000.0
	modFreq := 1000.0
	n := 2400 // 200ms — enough for AGC to settle

	// Generate a known SSB-like signal: real component is a 1kHz tone.
	// The DC block removes the DC component; AGC normalizes amplitude to ~0.3.
	in := make([]complex64, n)
	for i := 0; i < n; i++ {
		t_sec := float64(i) / sampleRate
		re := float32(math.Sin(2 * math.Pi * modFreq * t_sec))
		im := float32(math.Cos(2 * math.Pi * modFreq * t_sec))
		in[i] = complex(re, im)
	}

	// USB demod
	demod := NewSsbDemod("usb")
	ctx := dsp.BlockContext{SampleRate: sampleRate, BlockSize: n}
	demod.Init(ctx)

	out := make([]float32, n)
	written := demod.Process(in, out)
	if written != n {
		t.Fatalf("expected %d samples, got %d", n, written)
	}

	// After AGC settling (skip first half), verify:
	// 1. Output is non-silent
	// 2. Output oscillates at modFreq (1kHz)
	// 3. Output amplitude is in AGC range
	start := n / 2
	hasSignal := false
	maxAmp := float32(0)
	for i := start; i < n; i++ {
		a := float32(math.Abs(float64(out[i])))
		if a > 0.01 {
			hasSignal = true
		}
		if a > maxAmp {
			maxAmp = a
		}
	}
	if !hasSignal {
		t.Errorf("SSB output is silent after settling (max amp: %f)", maxAmp)
	}
	if maxAmp > 2.0 {
		t.Errorf("SSB output amplitude too high after AGC: %f", maxAmp)
	}

	// Verify correct frequency via zero crossings
	period := int(sampleRate / modFreq)
	crossings := 0
	for i := start + 1; i < n; i++ {
		if (out[i-1] < 0 && out[i] >= 0) || (out[i-1] >= 0 && out[i] < 0) {
			crossings++
		}
	}
	remainingSamples := n - start
	expectedCrossings := 2 * remainingSamples / period
	tolerance := expectedCrossings / 5
	if math.Abs(float64(crossings-expectedCrossings)) > float64(tolerance) {
		t.Errorf("SSB frequency wrong: expected ~%d zero crossings, got %d", expectedCrossings, crossings)
	}
}

func TestSsbDemodLsb(t *testing.T) {
	demod := NewSsbDemod("lsb")
	if demod.Name() != "ssb_lsb" {
		t.Errorf("expected name 'ssb_lsb', got '%s'", demod.Name())
	}

	ctx := dsp.BlockContext{SampleRate: 12000, BlockSize: 128}
	demod.Init(ctx)

	// Feed a ramp signal — the DC block + AGC will process it
	in := make([]complex64, 128)
	out := make([]float32, 128)
	for i := range in {
		in[i] = complex(float32(i)*0.01, float32(i)*0.02)
	}

	written := demod.Process(in, out)
	if written != 128 {
		t.Fatalf("expected 128 samples, got %d", written)
	}

	// Output length must match input — verify no samples are dropped
	// (ramp has monotonic real component so all outputs should be non-negative after some settling)
	hasOutput := false
	for i := 10; i < 128; i++ { // skip transient
		if out[i] != 0 {
			hasOutput = true
			break
		}
	}
	if !hasOutput {
		t.Error("SSB LSB output is all-zero")
	}
}

func TestCwDemod(t *testing.T) {
	sampleRate := 12000.0
	bfoHz := 700.0
	n := 12000 // 1 second

	// Generate a pure DC carrier (CW key-down)
	in := make([]complex64, n)
	for i := range in {
		in[i] = complex(1.0, 0.0) // constant carrier
	}

	demod := NewCwDemod(bfoHz)
	ctx := dsp.BlockContext{SampleRate: sampleRate, BlockSize: n}
	if err := demod.Init(ctx); err != nil {
		t.Fatalf("Init failed: %v", err)
	}
	// Set bandwidth wide enough to pass the 700 Hz BFO tone.
	// Default CW bandwidth is 500 Hz which would attenuate 700 Hz.
	demod.SetBandwidth(1500)

	out := make([]float32, n)
	written := demod.Process(in, out)
	if written != n {
		t.Fatalf("expected %d samples, got %d", n, written)
	}

	// Output should be cos(2*pi*700*t) since input is (1, 0) and we mix with BFO
	// Verify frequency by counting zero crossings
	start := 100 // skip startup
	crossings := 0
	for i := start + 1; i < n; i++ {
		if (out[i-1] < 0 && out[i] >= 0) || (out[i-1] >= 0 && out[i] < 0) {
			crossings++
		}
	}

	// Expected: 2 crossings per cycle × frequency × duration
	duration := float64(n-start) / sampleRate
	expectedCrossings := int(2.0 * bfoHz * duration)
	tolerance := expectedCrossings / 10

	if math.Abs(float64(crossings-expectedCrossings)) > float64(tolerance) {
		t.Errorf("CW BFO frequency wrong: expected ~%d crossings, got %d", expectedCrossings, crossings)
	}

	// Verify amplitude is ~1.0 (mixing unit carrier with unit BFO)
	maxAmp := float32(0)
	for i := start; i < n; i++ {
		a := float32(math.Abs(float64(out[i])))
		if a > maxAmp {
			maxAmp = a
		}
	}
	if maxAmp < 0.9 || maxAmp > 1.1 {
		t.Errorf("CW amplitude unexpected: %f (expected ~1.0)", maxAmp)
	}
}

func TestCwDemodReset(t *testing.T) {
	demod := NewCwDemod(700)
	ctx := dsp.BlockContext{SampleRate: 12000, BlockSize: 1024}
	demod.Init(ctx)

	// Process some data to advance phase
	in := make([]complex64, 1024)
	out := make([]float32, 1024)
	for i := range in {
		in[i] = complex(1, 0)
	}
	demod.Process(in, out)

	if demod.phase == 0 {
		t.Error("phase should have advanced after processing")
	}

	demod.Reset()
	if demod.phase != 0 {
		t.Error("Reset did not clear phase")
	}
}

func TestCwDemodName(t *testing.T) {
	d := NewCwDemod(700)
	if d.Name() != "cw" {
		t.Errorf("expected name 'cw', got '%s'", d.Name())
	}
}

func BenchmarkCwDemod(b *testing.B) {
	sampleRate := 12000.0
	n := 4096

	in := make([]complex64, n)
	for i := range in {
		in[i] = complex(1, 0)
	}
	out := make([]float32, n)

	demod := NewCwDemod(700)
	ctx := dsp.BlockContext{SampleRate: sampleRate, BlockSize: n}
	demod.Init(ctx)

	b.ResetTimer()
	b.SetBytes(int64(n * 8))
	for i := 0; i < b.N; i++ {
		demod.Process(in, out)
	}
}

func BenchmarkSsbDemod(b *testing.B) {
	n := 4096
	in := make([]complex64, n)
	for i := range in {
		in[i] = complex(float32(i)*0.001, float32(i)*0.0005)
	}
	out := make([]float32, n)

	demod := NewSsbDemod("usb")
	ctx := dsp.BlockContext{SampleRate: 12000, BlockSize: n}
	demod.Init(ctx)

	b.ResetTimer()
	b.SetBytes(int64(n * 8))
	for i := 0; i < b.N; i++ {
		demod.Process(in, out)
	}
}
