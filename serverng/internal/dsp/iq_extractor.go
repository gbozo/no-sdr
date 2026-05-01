package dsp

import (
	"fmt"
	"log/slog"
	"math"
)

// IqExtractorConfig holds parameters for sub-band extraction.
type IqExtractorConfig struct {
	InputSampleRate  int          // dongle rate (e.g., 2400000)
	OutputSampleRate int          // desired rate (e.g., 48000 for NFM, 240000 for WFM)
	TuneOffset       int          // Hz offset from center frequency
	Logger           *slog.Logger // optional
}

// IqExtractor extracts a narrow sub-band from wideband IQ data.
// Pipeline: uint8→complex64 → NoiseBlanker → NCO shift → Butterworth LPF → Decimate → scale to Int16
type IqExtractor struct {
	nco      *NCOBlock
	filter   *ButterworthBlock
	decimate *DecimateBlock
	pipeline *Pipeline

	noiseBlanker *NoiseBlanker // optional pre-filter NB

	inputRate  int
	outputRate int
	factor     int // decimation factor

	logger *slog.Logger

	// Pre-allocated buffers
	complexIn []complex64 // converted from uint8
	int16Out  []int16     // final output
}

// NewIqExtractor creates a new sub-band extractor.
// Returns error if configuration is invalid.
func NewIqExtractor(cfg IqExtractorConfig) (*IqExtractor, error) {
	if cfg.InputSampleRate <= 0 {
		return nil, fmt.Errorf("iq_extractor: InputSampleRate must be positive, got %d", cfg.InputSampleRate)
	}
	if cfg.OutputSampleRate <= 0 {
		return nil, fmt.Errorf("iq_extractor: OutputSampleRate must be positive, got %d", cfg.OutputSampleRate)
	}
	if cfg.OutputSampleRate > cfg.InputSampleRate {
		return nil, fmt.Errorf("iq_extractor: OutputSampleRate (%d) cannot exceed InputSampleRate (%d)", cfg.OutputSampleRate, cfg.InputSampleRate)
	}

	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}

	// Compute decimation factor (must be integer). Find nearest valid.
	factor := findDecimationFactor(cfg.InputSampleRate, cfg.OutputSampleRate)
	actualOutputRate := cfg.InputSampleRate / factor

	// Create DSP blocks
	nco := NewNCOBlock(float64(cfg.TuneOffset))
	cutoff := float64(actualOutputRate) / 2.0
	filter := NewButterworthBlock(cutoff)
	decimate := NewDecimateBlock(factor)

	// Build pipeline
	pipeline, err := NewPipeline(float64(cfg.InputSampleRate), []ProcessorBlock{nco, filter, decimate}, logger)
	if err != nil {
		return nil, fmt.Errorf("iq_extractor: pipeline init failed: %w", err)
	}

	e := &IqExtractor{
		nco:          nco,
		filter:       filter,
		decimate:     decimate,
		pipeline:     pipeline,
		noiseBlanker: NewNoiseBlanker(10.0),
		inputRate:    cfg.InputSampleRate,
		outputRate:   actualOutputRate,
		factor:       factor,
		logger:       logger,
	}

	return e, nil
}

// Process takes raw uint8 IQ data (interleaved I,Q,I,Q...) and returns
// Int16 IQ sub-band (interleaved I,Q,I,Q...). May return nil if input is empty.
func (e *IqExtractor) Process(rawIQ []byte) []int16 {
	if len(rawIQ) < 2 {
		return nil
	}

	numSamples := len(rawIQ) / 2

	// Ensure complexIn buffer is large enough
	if cap(e.complexIn) < numSamples {
		e.complexIn = make([]complex64, numSamples)
	} else {
		e.complexIn = e.complexIn[:numSamples]
	}

	// Convert uint8 IQ to complex64: (byte - 127.5) / 127.5
	for i := 0; i < numSamples; i++ {
		iVal := (float32(rawIQ[i*2]) - 127.5) / 127.5
		qVal := (float32(rawIQ[i*2+1]) - 127.5) / 127.5
		e.complexIn[i] = complex(iVal, qVal)
	}

	// Apply pre-filter noise blanker (if enabled)
	e.noiseBlanker.Process(e.complexIn[:numSamples])

	// Run through pipeline: NCO → Butterworth → Decimate
	out := e.pipeline.Process(e.complexIn)
	if len(out) == 0 {
		return nil
	}

	// Scale to Int16 interleaved I,Q
	outLen := len(out) * 2
	if cap(e.int16Out) < outLen {
		e.int16Out = make([]int16, outLen)
	} else {
		e.int16Out = e.int16Out[:outLen]
	}

	for i, s := range out {
		e.int16Out[i*2] = clampToInt16(real(s) * 32767.0)
		e.int16Out[i*2+1] = clampToInt16(imag(s) * 32767.0)
	}

	return e.int16Out
}

// SetTuneOffset changes the NCO frequency at runtime.
func (e *IqExtractor) SetTuneOffset(hz int) {
	e.nco.SetOffset(float64(hz))
}

// SetOutputSampleRate changes bandwidth/decimation at runtime.
// Recomputes filter cutoff and decimation factor.
func (e *IqExtractor) SetOutputSampleRate(rate int) {
	if rate <= 0 || rate > e.inputRate {
		return
	}

	factor := findDecimationFactor(e.inputRate, rate)
	actualRate := e.inputRate / factor
	e.factor = factor
	e.outputRate = actualRate

	// Update filter cutoff
	e.filter.SetCutoff(float64(actualRate) / 2.0)

	// Update decimation factor — need to rebuild the decimate block
	e.decimate = NewDecimateBlock(factor)
	// Re-initialize with the filter's output rate (same as input rate since filter doesn't change rate)
	_ = e.decimate.Init(BlockContext{SampleRate: float64(e.inputRate)})

	// Rebuild pipeline with new decimation factor
	nco := e.nco
	filter := e.filter
	decimate := e.decimate

	pipeline, err := NewPipeline(float64(e.inputRate), []ProcessorBlock{nco, filter, decimate}, e.logger)
	if err != nil {
		e.logger.Error("iq_extractor: failed to rebuild pipeline", "error", err)
		return
	}
	e.pipeline = pipeline
}

// Reset clears all filter state.
func (e *IqExtractor) Reset() {
	e.pipeline.Reset()
	e.noiseBlanker.Reset()
}

// SetNbEnabled enables or disables the pre-filter noise blanker.
func (e *IqExtractor) SetNbEnabled(enabled bool) { e.noiseBlanker.SetEnabled(enabled) }

// SetNbThreshold sets the noise blanker impulse threshold multiplier.
func (e *IqExtractor) SetNbThreshold(t float32) { e.noiseBlanker.SetThreshold(t) }

// NbEnabled returns whether the noise blanker is currently enabled.
func (e *IqExtractor) NbEnabled() bool { return e.noiseBlanker.IsEnabled() }

// OutputSampleRate returns the current output rate.
func (e *IqExtractor) OutputSampleRate() int {
	return e.outputRate
}

// InputSampleRate returns the input sample rate.
func (e *IqExtractor) InputSampleRate() int {
	return e.inputRate
}

// DecimationFactor returns the current decimation factor.
func (e *IqExtractor) DecimationFactor() int {
	return e.factor
}

// findDecimationFactor finds the best integer decimation factor
// such that inputRate/factor is as close as possible to targetRate.
func findDecimationFactor(inputRate, targetRate int) int {
	if targetRate >= inputRate {
		return 1
	}

	// Ideal (possibly non-integer) factor
	idealFactor := float64(inputRate) / float64(targetRate)

	// Try floor and ceil, pick the one closest to the target rate
	floorFactor := int(math.Floor(idealFactor))
	ceilFactor := int(math.Ceil(idealFactor))

	if floorFactor < 1 {
		floorFactor = 1
	}
	if ceilFactor < 1 {
		ceilFactor = 1
	}

	floorRate := float64(inputRate) / float64(floorFactor)
	ceilRate := float64(inputRate) / float64(ceilFactor)

	floorDiff := math.Abs(floorRate - float64(targetRate))
	ceilDiff := math.Abs(ceilRate - float64(targetRate))

	if ceilDiff < floorDiff {
		return ceilFactor
	}
	return floorFactor
}

// clampToInt16 clamps a float32 value to the int16 range.
func clampToInt16(v float32) int16 {
	if v >= 32767.0 {
		return 32767
	}
	if v <= -32768.0 {
		return -32768
	}
	return int16(v)
}
