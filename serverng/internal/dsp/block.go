package dsp

import (
	"log/slog"
)

// SampleType represents the types of samples that flow through pipes.
type Complex64 = complex64
type Float32Sample = float32

// BlockContext provides configuration and pipe handles to a block.
type BlockContext struct {
	SampleRate float64
	BlockSize  int // preferred chunk size (0 = any length)
	Logger     *slog.Logger
}

// Block is the interface all DSP processing stages implement.
type Block interface {
	Name() string
	SampleRateOut(inputRate float64) float64 // output rate given input rate (for rate propagation)
}

// ProcessorBlock processes complex IQ samples (most common).
type ProcessorBlock interface {
	Block
	Init(ctx BlockContext) error
	ProcessComplex(in []complex64, out []complex64) int // returns samples written to out
	Reset()
}

// ComplexToRealBlock converts complex IQ to real float32 (demodulators).
type ComplexToRealBlock interface {
	Block
	Init(ctx BlockContext) error
	Process(in []complex64, out []float32) int
	Reset()
}
