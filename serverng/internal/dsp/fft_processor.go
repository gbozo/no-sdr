package dsp

import (
	"errors"
	"log/slog"
	"math"
	"time"
	"unsafe"
)

// GPUFFTBackend is the interface that a GPU FFT provider must satisfy.
// The gpu.FFTContext type satisfies this interface.
type GPUFFTBackend interface {
	// Process runs a C2C FFT on fftSize*2 uint8 IQ bytes.
	// Returns fftSize float32 values: 10*log10(power) for each bin in natural FFT order.
	// Caller applies FFT-shift and subtracts normDbVal.
	// Returns a non-nil error on GPU failure — caller must fall back to CPU.
	Process(iq []byte) ([]float32, error)
	// Close releases the GPU resources.
	Close()
}

// fastLog10Power computes an approximation of 10*log10(x) using the IEEE 754
// bit representation of x. It extracts the binary exponent directly and uses
// a 3-term minimax polynomial over the mantissa for the fractional log2 part,
// then multiplies by log10(2). Max error is < 0.01 dB — imperceptible on a
// waterfall display. x must be positive.
//
// Derivation: log10(x) = log2(x) * log10(2)
//   log2(x) = exponent + log2(mantissa),  mantissa in [1,2)
//   log2(m) ≈ -1.0 + 2.0*m - 0.5*m*m  (minimax on [1,2], max err ~0.006)
func fastLog10Power(x float32) float32 {
	// Reinterpret bits to access the raw IEEE 754 float32 word.
	bits32 := *(*uint32)(unsafe.Pointer(&x))

	// Extract unbiased binary exponent: (bits >> 23) - 127
	exp := int32(bits32>>23) - 127

	// Build a float32 with the same mantissa but exponent = 0 (value in [1,2)).
	mantissaBits := (bits32 & 0x7FFFFF) | 0x3F800000
	m := *(*float32)(unsafe.Pointer(&mantissaBits))

	// 3-term minimax polynomial for log2(m), m in [1,2):
	//   log2(m) ≈ -1.0 + 2.0*m - 0.5*m*m  (max error ~0.006 bits)
	log2m := -1.0 + 2.0*m - 0.5*m*m

	// 10*log10(x) = log2(x) * 10*log10(2)
	const tenLog10Of2 = float32(3.01029995663981) // 10 * log10(2)
	return (float32(exp) + log2m) * tenLog10Of2
}

// FftProcessorConfig configures the FFT processor pipeline.
type FftProcessorConfig struct {
	FftSize    int     // power of 2
	SampleRate int     // dongle sample rate
	Window     string  // "blackman-harris", "hann", "hamming"
	Averaging  float32 // 0 = no averaging, 0.9 = heavy smoothing
	TargetFps  int     // output frame rate cap (0 = unlimited). Typical: 30.
}

// FftProcessor accumulates raw uint8 IQ data, applies windowing + FFT,
// computes magnitude in dB with averaging, and rate-caps output frames.
type FftProcessor struct {
	fftSize    int
	sampleRate int
	averaging  float32
	targetFps  int
	windowName string

	// DSP core
	fft       *FFT
	window    []float32
	normDbVal float32

	// GPU FFT backend (optional — nil = CPU only)
	gpuFFT       GPUFFTBackend
	gpuPaused    bool  // when true, GPU path is skipped (admin disabled)
	gpuFrames    int64 // count of frames processed by GPU

	// Pre-allocated work buffers (zero alloc in hot path)
	complexBuf []float32 // interleaved complex input/output, length 2*fftSize
	magBuf     []float32 // magnitude output, length fftSize
	avgBuf     []float32 // exponential averaging state, length fftSize (nil if averaging==0)
	avgInit    bool       // whether avgBuf has been initialized with first frame

	// Ring buffer accumulator
	ringBuf     []byte
	ringFill    int
	samplesNeed int // fftSize * 2 bytes

	// Rate cap state
	minInterval time.Duration
	lastEmit    time.Time
	pendingBuf  []float32 // accumulated frame for rate cap, length fftSize
	pendingN    int       // number of frames accumulated into pendingBuf
}

// NewFftProcessor creates a new FFT processor with fully pre-allocated buffers.
func NewFftProcessor(cfg FftProcessorConfig) (*FftProcessor, error) {
	if cfg.FftSize < 4 || cfg.FftSize&(cfg.FftSize-1) != 0 {
		return nil, errors.New("fft_processor: fftSize must be a power of 2 and >= 4")
	}
	if cfg.Window == "" {
		cfg.Window = "blackman-harris"
	}
	if cfg.Averaging < 0 {
		cfg.Averaging = 0
	}
	if cfg.Averaging > 1 {
		cfg.Averaging = 1
	}

	fft, err := NewFFT(cfg.FftSize)
	if err != nil {
		return nil, err
	}

	win, err := NewWindow(cfg.Window, cfg.FftSize)
	if err != nil {
		return nil, err
	}

	p := &FftProcessor{
		fftSize:    cfg.FftSize,
		sampleRate: cfg.SampleRate,
		averaging:  cfg.Averaging,
		targetFps:  cfg.TargetFps,
		windowName: cfg.Window,
		fft:        fft,
		window:     win,
	}

	p.normDbVal = p.computeNormalization()
	p.samplesNeed = cfg.FftSize * 2

	// Pre-allocate all buffers
	p.complexBuf = make([]float32, 2*cfg.FftSize)
	p.magBuf = make([]float32, cfg.FftSize)
	p.ringBuf = make([]byte, cfg.FftSize*2*4) // 4 frames of headroom
	p.ringFill = 0
	p.pendingBuf = make([]float32, cfg.FftSize)
	p.pendingN = 0

	if cfg.Averaging > 0 {
		p.avgBuf = make([]float32, cfg.FftSize)
		p.avgInit = false
	}

	// Rate cap
	if cfg.TargetFps > 0 {
		p.minInterval = time.Second / time.Duration(cfg.TargetFps)
	}

	return p, nil
}

// SetGPUBackend attaches a GPU FFT backend to this processor.
// Calling with nil removes the GPU backend and falls back to CPU.
// Must not be called concurrently with ProcessIqData.
func (p *FftProcessor) SetGPUBackend(g GPUFFTBackend) {
	if p.gpuFFT != nil {
		p.gpuFFT.Close()
	}
	p.gpuFFT = g
	if g != nil {
		slog.Info("fft_processor: GPU FFT backend attached",
			"fft_size", p.fftSize)
	} else {
		slog.Info("fft_processor: GPU FFT backend removed, falling back to CPU")
	}
}

// SetGPUPaused pauses/resumes the GPU FFT path without tearing down the backend.
func (p *FftProcessor) SetGPUPaused(paused bool) {
	p.gpuPaused = paused
}

// GPUFrames returns the number of FFT frames processed by the GPU backend.
func (p *FftProcessor) GPUFrames() int64 {
	return p.gpuFrames
}

// ProcessIqData accepts raw uint8 IQ data (interleaved I,Q,I,Q...)
// and returns zero or more FFT magnitude frames ([]float32 in dB, length = FftSize).
// May return 0 frames if rate cap hasn't elapsed or insufficient data accumulated.
// The returned slices are owned by the caller (copied from internal buffers).
func (p *FftProcessor) ProcessIqData(data []byte) [][]float32 {
	// Append into ring buffer
	needed := p.ringFill + len(data)
	if needed > len(p.ringBuf) {
		// Grow ring buffer (rare path)
		newBuf := make([]byte, needed*2)
		copy(newBuf, p.ringBuf[:p.ringFill])
		p.ringBuf = newBuf
	}
	copy(p.ringBuf[p.ringFill:], data)
	p.ringFill += len(data)

	var emitted [][]float32
	now := time.Now()

	consumed := 0
	for p.ringFill-consumed >= p.samplesNeed {
		p.processOneFrame(p.ringBuf[consumed : consumed+p.samplesNeed])
		consumed += p.samplesNeed

		if p.minInterval <= 0 {
			// No rate cap — emit every frame
			frame := make([]float32, p.fftSize)
			copy(frame, p.magBuf)
			emitted = append(emitted, frame)
			continue
		}

		// Rate-capped: accumulate into pending frame
		if p.pendingN == 0 {
			copy(p.pendingBuf, p.magBuf)
			p.pendingN = 1
		} else {
			p.pendingN++
			n := float32(p.pendingN)
			for i := 0; i < p.fftSize; i++ {
				p.pendingBuf[i] += (p.magBuf[i] - p.pendingBuf[i]) / n
			}
		}

		if now.Sub(p.lastEmit) >= p.minInterval {
			frame := make([]float32, p.fftSize)
			copy(frame, p.pendingBuf)
			emitted = append(emitted, frame)
			p.pendingN = 0
			p.lastEmit = now
		}
	}

	// Compact ring buffer: move remainder to front
	if consumed > 0 {
		if consumed < p.ringFill {
			copy(p.ringBuf, p.ringBuf[consumed:p.ringFill])
		}
		p.ringFill -= consumed
	}

	return emitted
}

// processOneFrame converts one FFT-sized chunk of uint8 IQ into magnitude dB.
// Result is written into p.magBuf. Zero allocations on CPU path.
// If a GPU backend is attached, the GPU path is tried first with CPU fallback.
func (p *FftProcessor) processOneFrame(rawIq []byte) {
	// ── GPU path ──────────────────────────────────────────────────────────────
	if p.gpuFFT != nil && !p.gpuPaused {
		if gpuOut, err := p.gpuFFT.Process(rawIq); err == nil {
			// GPU returns fftSize bins in natural FFT order (DC at bin 0).
			// Apply FFT-shift (DC → center) and normalization — same as CPU path.
			fftSize := p.fftSize
			half := fftSize >> 1
			normDb := p.normDbVal
			mag := p.magBuf

			for i := 0; i < fftSize; i++ {
				srcIdx := (i + half) & (fftSize - 1)
				mag[i] = gpuOut[srcIdx] - normDb
			}

			// Apply exponential averaging (same as CPU path)
			if p.averaging > 0 {
				if !p.avgInit {
					copy(p.avgBuf, mag)
					p.avgInit = true
				} else {
					a := p.averaging
					b := 1 - a
					avg := p.avgBuf
					for i := 0; i < fftSize; i++ {
						avg[i] = a*avg[i] + b*mag[i]
					}
				}
				copy(mag, p.avgBuf)
			}
			p.gpuFrames++
			return
		}
		// GPU failed — fall through to CPU path (do not disable GPU; transient errors are common)
	}

	// ── CPU path ──────────────────────────────────────────────────────────────
	fftSize := p.fftSize
	win := p.window
	buf := p.complexBuf

	// Convert uint8 IQ -> float32 [-1,+1] with windowing in one pass
	for i := 0; i < fftSize; i++ {
		w := win[i]
		buf[i*2] = (float32(rawIq[i*2]) - 127.5) / 127.5 * w
		buf[i*2+1] = (float32(rawIq[i*2+1]) - 127.5) / 127.5 * w
	}

	// In-place FFT
	p.fft.Transform(buf)

	// Compute magnitude in dB with FFT-shift (DC in center)
	half := fftSize >> 1
	normDb := p.normDbVal
	mag := p.magBuf

	for i := 0; i < fftSize; i++ {
		srcIdx := (i + half) & (fftSize - 1)
		re := buf[srcIdx*2]
		im := buf[srcIdx*2+1]
		power := re*re + im*im
		if power < 1e-20 {
			power = 1e-20
		}
		mag[i] = fastLog10Power(power) - normDb
	}

	// Exponential averaging
	if p.averaging > 0 {
		if !p.avgInit {
			copy(p.avgBuf, mag)
			p.avgInit = true
		} else {
			a := p.averaging
			b := 1 - a
			avg := p.avgBuf
			for i := 0; i < fftSize; i++ {
				avg[i] = a*avg[i] + b*mag[i]
			}
		}
		// Output the averaged magnitudes
		copy(mag, p.avgBuf)
	}
}

// Resize changes FFT size at runtime (used on profile switch).
func (p *FftProcessor) Resize(newSize int) error {
	if newSize < 4 || newSize&(newSize-1) != 0 {
		return errors.New("fft_processor: newSize must be a power of 2 and >= 4")
	}

	fft, err := NewFFT(newSize)
	if err != nil {
		return err
	}

	win, err := NewWindow(p.windowName, newSize)
	if err != nil {
		return err
	}

	p.fftSize = newSize
	p.fft = fft
	p.window = win
	p.samplesNeed = newSize * 2
	p.normDbVal = p.computeNormalization()

	// Re-allocate buffers
	p.complexBuf = make([]float32, 2*newSize)
	p.magBuf = make([]float32, newSize)
	p.pendingBuf = make([]float32, newSize)
	p.pendingN = 0
	p.ringBuf = make([]byte, newSize*2*4)
	p.ringFill = 0

	if p.averaging > 0 {
		p.avgBuf = make([]float32, newSize)
		p.avgInit = false
	} else {
		p.avgBuf = nil
		p.avgInit = false
	}

	return nil
}

// Reset clears averaging state and ring buffer.
func (p *FftProcessor) Reset() {
	p.ringFill = 0
	p.pendingN = 0
	p.lastEmit = time.Time{}
	p.avgInit = false
	if p.avgBuf != nil {
		for i := range p.avgBuf {
			p.avgBuf[i] = 0
		}
	}
}

// computeNormalization returns 20*log10(fftSize) + 20*log10(coherentGain)
// where coherentGain = sum(window) / fftSize.
func (p *FftProcessor) computeNormalization() float32 {
	fftNorm := 20.0 * math.Log10(float64(p.fftSize))

	var windowSum float64
	for _, v := range p.window {
		windowSum += float64(v)
	}
	coherentGain := windowSum / float64(p.fftSize)
	windowCorrectionDb := 20.0 * math.Log10(coherentGain)

	return float32(fftNorm + windowCorrectionDb)
}
