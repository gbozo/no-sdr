package demod

import (
	"math"
	"testing"

	"github.com/gbozo/no-sdr/serverng/internal/dsp"
)

func TestSsbDemod(t *testing.T) {
	sampleRate := 12000.0
	n := 1200

	// Generate a known signal: real component is a 1kHz tone
	in := make([]complex64, n)
	for i := 0; i < n; i++ {
		t_sec := float64(i) / sampleRate
		re := float32(math.Sin(2 * math.Pi * 1000 * t_sec))
		im := float32(math.Cos(2 * math.Pi * 1000 * t_sec))
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

	// Output should be real(in) = sin(2*pi*1000*t)
	maxErr := float32(0)
	for i := 0; i < n; i++ {
		t_sec := float64(i) / sampleRate
		expected := float32(math.Sin(2 * math.Pi * 1000 * t_sec))
		err := float32(math.Abs(float64(out[i] - expected)))
		if err > maxErr {
			maxErr = err
		}
	}
	if maxErr > 1e-6 {
		t.Errorf("SSB output error too high: %e", maxErr)
	}
}

func TestSsbDemodLsb(t *testing.T) {
	demod := NewSsbDemod("lsb")
	if demod.Name() != "ssb_lsb" {
		t.Errorf("expected name 'ssb_lsb', got '%s'", demod.Name())
	}

	ctx := dsp.BlockContext{SampleRate: 12000, BlockSize: 128}
	demod.Init(ctx)

	in := make([]complex64, 128)
	out := make([]float32, 128)
	for i := range in {
		in[i] = complex(float32(i)*0.01, float32(i)*0.02)
	}

	written := demod.Process(in, out)
	if written != 128 {
		t.Fatalf("expected 128 samples, got %d", written)
	}

	// Verify real component extraction
	for i := 0; i < 128; i++ {
		if out[i] != real(in[i]) {
			t.Errorf("sample %d: expected %f, got %f", i, real(in[i]), out[i])
			break
		}
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
