package dsp

import (
	"log/slog"
	"os"
	"testing"
)

// passthrough is a test block that passes samples through unchanged.
type passthrough struct {
	name string
}

func (p *passthrough) Name() string                          { return p.name }
func (p *passthrough) SampleRateOut(in float64) float64      { return in }
func (p *passthrough) Init(_ BlockContext) error             { return nil }
func (p *passthrough) ProcessComplex(in, out []complex64) int {
	copy(out, in)
	return len(in)
}
func (p *passthrough) Reset() {}

// decimator is a test block that decimates by a fixed factor.
type decimator struct {
	name   string
	factor int
}

func (d *decimator) Name() string                          { return d.name }
func (d *decimator) SampleRateOut(in float64) float64      { return in / float64(d.factor) }
func (d *decimator) Init(_ BlockContext) error             { return nil }
func (d *decimator) ProcessComplex(in, out []complex64) int {
	n := 0
	for i := 0; i < len(in); i += d.factor {
		out[n] = in[i]
		n++
	}
	return n
}
func (d *decimator) Reset() {}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

func TestPipeline_SinglePassthrough(t *testing.T) {
	blocks := []ProcessorBlock{&passthrough{name: "pass"}}
	p, err := NewPipeline(2400000, blocks, testLogger())
	if err != nil {
		t.Fatalf("NewPipeline: %v", err)
	}

	if p.OutputRate() != 2400000 {
		t.Fatalf("expected output rate 2400000, got %f", p.OutputRate())
	}

	in := make([]complex64, 1024)
	for i := range in {
		in[i] = complex(float32(i), float32(-i))
	}

	out := p.Process(in)
	if len(out) != 1024 {
		t.Fatalf("expected 1024 output samples, got %d", len(out))
	}
	for i := range out {
		if out[i] != in[i] {
			t.Fatalf("sample %d: expected %v, got %v", i, in[i], out[i])
		}
	}
}

func TestPipeline_ChainedDecimation(t *testing.T) {
	blocks := []ProcessorBlock{
		&decimator{name: "dec4", factor: 4},
		&decimator{name: "dec2", factor: 2},
	}
	p, err := NewPipeline(2400000, blocks, testLogger())
	if err != nil {
		t.Fatalf("NewPipeline: %v", err)
	}

	expectedRate := 2400000.0 / 4.0 / 2.0
	if p.OutputRate() != expectedRate {
		t.Fatalf("expected output rate %f, got %f", expectedRate, p.OutputRate())
	}

	in := make([]complex64, 1024)
	for i := range in {
		in[i] = complex(float32(i), 0)
	}

	out := p.Process(in)
	// 1024 / 4 / 2 = 128 samples
	if len(out) != 128 {
		t.Fatalf("expected 128 output samples, got %d", len(out))
	}

	// First output should be sample 0 (decimated by 4, then by 2 → every 8th).
	for i, s := range out {
		expected := complex(float32(i*8), 0)
		if s != expected {
			t.Fatalf("sample %d: expected %v, got %v", i, expected, s)
		}
	}
}

func TestPipeline_Reset(t *testing.T) {
	blocks := []ProcessorBlock{&passthrough{name: "p1"}, &passthrough{name: "p2"}}
	p, err := NewPipeline(48000, blocks, testLogger())
	if err != nil {
		t.Fatalf("NewPipeline: %v", err)
	}
	// Just ensure Reset doesn't panic.
	p.Reset()
}

func TestPipeline_EmptyBlocksError(t *testing.T) {
	_, err := NewPipeline(48000, nil, testLogger())
	if err == nil {
		t.Fatal("expected error for empty blocks")
	}
}

func TestPipeline_InvalidRateError(t *testing.T) {
	_, err := NewPipeline(0, []ProcessorBlock{&passthrough{name: "p"}}, testLogger())
	if err == nil {
		t.Fatal("expected error for zero input rate")
	}
}
