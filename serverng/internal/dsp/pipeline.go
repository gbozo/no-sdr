package dsp

import (
	"fmt"
	"log/slog"
)

// Pipeline chains ProcessorBlocks together, managing buffer allocation.
type Pipeline struct {
	blocks  []ProcessorBlock
	buffers [][]complex64 // intermediate buffers between stages
	inRate  float64
	outRate float64
	logger  *slog.Logger
}

// NewPipeline creates a pipeline from a sequence of processor blocks.
// Validates rate propagation and allocates intermediate buffers.
func NewPipeline(inputRate float64, blocks []ProcessorBlock, logger *slog.Logger) (*Pipeline, error) {
	if len(blocks) == 0 {
		return nil, fmt.Errorf("pipeline: at least one block is required")
	}
	if inputRate <= 0 {
		return nil, fmt.Errorf("pipeline: inputRate must be positive, got %f", inputRate)
	}
	if logger == nil {
		logger = slog.Default()
	}

	p := &Pipeline{
		blocks: blocks,
		inRate: inputRate,
		logger: logger,
	}

	// Propagate rates through blocks and initialize each one.
	rate := inputRate
	for i, b := range blocks {
		outRate := b.SampleRateOut(rate)
		if outRate <= 0 {
			return nil, fmt.Errorf("pipeline: block %d (%s) returned invalid output rate %f for input rate %f",
				i, b.Name(), outRate, rate)
		}

		ctx := BlockContext{
			SampleRate: rate,
			BlockSize:  0,
			Logger:     logger.With("block", b.Name(), "index", i),
		}
		if err := b.Init(ctx); err != nil {
			return nil, fmt.Errorf("pipeline: failed to init block %d (%s): %w", i, b.Name(), err)
		}

		logger.Info("pipeline: initialized block",
			"index", i,
			"name", b.Name(),
			"inRate", rate,
			"outRate", outRate,
		)
		rate = outRate
	}
	p.outRate = rate

	// Allocate intermediate buffers.
	// We need len(blocks)-1 intermediate buffers (input goes to first block,
	// output of last block is the pipeline output).
	// Size each buffer based on a max input of 32768 samples scaled by rate ratios.
	const maxInputSamples = 32768
	if len(blocks) > 1 {
		p.buffers = make([][]complex64, len(blocks)-1)
		bufRate := inputRate
		for i := 0; i < len(blocks)-1; i++ {
			outRate := blocks[i].SampleRateOut(bufRate)
			// Buffer size: scale input size by rate ratio, add headroom.
			ratio := outRate / bufRate
			bufSize := int(float64(maxInputSamples)*ratio) + 64
			if bufSize < maxInputSamples {
				bufSize = maxInputSamples
			}
			p.buffers[i] = make([]complex64, bufSize)
			bufRate = outRate
		}
	}

	return p, nil
}

// Process runs input through all stages and returns the final output.
// The output slice is owned by the pipeline (reused between calls).
func (p *Pipeline) Process(in []complex64) []complex64 {
	if len(p.blocks) == 0 {
		return in
	}

	if len(p.blocks) == 1 {
		// Single block: use a dedicated buffer or process in-place if safe.
		// Allocate output buffer on demand.
		if len(p.buffers) == 0 {
			p.buffers = [][]complex64{make([]complex64, len(in)+64)}
		}
		buf := p.buffers[0]
		if len(buf) < len(in) {
			buf = make([]complex64, len(in)+64)
			p.buffers[0] = buf
		}
		n := p.blocks[0].ProcessComplex(in, buf)
		return buf[:n]
	}

	// Multi-block chain.
	current := in
	for i, b := range p.blocks {
		var out []complex64
		if i < len(p.blocks)-1 {
			// Use intermediate buffer.
			buf := p.buffers[i]
			if len(buf) < len(current) {
				buf = make([]complex64, len(current)+64)
				p.buffers[i] = buf
			}
			out = buf
		} else {
			// Last block: use the last intermediate buffer from previous stage output.
			// We reuse the last allocated buffer slot.
			lastBuf := p.buffers[len(p.buffers)-1]
			if len(lastBuf) < len(current) {
				lastBuf = make([]complex64, len(current)+64)
				p.buffers[len(p.buffers)-1] = lastBuf
			}
			out = lastBuf
		}
		n := b.ProcessComplex(current, out)
		current = out[:n]
	}
	return current
}

// OutputRate returns the final output sample rate.
func (p *Pipeline) OutputRate() float64 {
	return p.outRate
}

// Reset resets all blocks in the pipeline.
func (p *Pipeline) Reset() {
	for _, b := range p.blocks {
		b.Reset()
	}
}
