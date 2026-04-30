package dsp

import (
	"log/slog"
	"testing"
)

func TestDecimate_ReducesLength(t *testing.T) {
	d := NewDecimateBlock(10)
	err := d.Init(BlockContext{SampleRate: 240000, Logger: slog.Default()})
	if err != nil {
		t.Fatal(err)
	}

	in := make([]complex64, 1000)
	out := make([]complex64, 100)
	for i := range in {
		in[i] = complex(float32(i), float32(-i))
	}

	n := d.ProcessComplex(in, out)
	if n != 100 {
		t.Fatalf("expected 100 output samples, got %d", n)
	}
}

func TestDecimate_CorrectSamples(t *testing.T) {
	factor := 5
	d := NewDecimateBlock(factor)
	d.Init(BlockContext{SampleRate: 48000, Logger: slog.Default()})

	in := make([]complex64, 100)
	out := make([]complex64, 20)
	for i := range in {
		in[i] = complex(float32(i), float32(i*2))
	}

	n := d.ProcessComplex(in, out)
	if n != 20 {
		t.Fatalf("expected 20 output samples, got %d", n)
	}

	for j := 0; j < n; j++ {
		expected := in[j*factor]
		if out[j] != expected {
			t.Fatalf("out[%d] = %v, expected %v (in[%d])", j, out[j], expected, j*factor)
		}
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
