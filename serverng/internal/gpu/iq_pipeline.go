//go:build gpu_vulkan

package gpu

/*
#include "c/iq_pipeline.h"
*/
import "C"
import (
	"fmt"
	"math"
	"unsafe"
)

// IqPipelineContext wraps the GPU IQ compute pipeline.
// Supports batched processing of up to 64 concurrent clients.
type IqPipelineContext struct {
	ptr *C.IqPipelineCtx
}

// IqClientState holds per-client parameters and filter state.
// This is synchronized with the GPU — the GPU updates state (phase, filter taps)
// after each process call.
type IqClientState struct {
	// NCO
	Phase    float64 // current phase [0, 2π)
	PhaseInc float64 // 2π * offsetHz / sampleRate

	// Butterworth coefficients (2 sections)
	B0_0, B1_0, B2_0, A1_0, A2_0 float64 // section 0
	B0_1, B1_1, B2_1, A1_1, A2_1 float64 // section 1

	// Butterworth state I channel
	StI0Z1, StI0Z2, StI1Z1, StI1Z2 float64
	// Butterworth state Q channel
	StQ0Z1, StQ0Z2, StQ1Z1, StQ1Z2 float64

	// Decimation
	DecimFactor int

	// DC blocker
	DCEnabled bool
	DCAlpha   float64
	DCI       float64
	DCQ       float64
}

// NewIqClientState creates a new client state with the given IQ extractor parameters.
func NewIqClientState(inputRate, outputRate, tuneOffsetHz int, dcEnabled bool) *IqClientState {
	factor := inputRate / outputRate
	if factor < 1 {
		factor = 1
	}

	// Butterworth 4th-order: 2 biquad sections
	cutoff := float64(outputRate) / 2.0
	sampleRate := float64(inputRate)
	q1 := 1.0 / (2.0 * math.Cos(math.Pi/8.0))
	q2 := 1.0 / (2.0 * math.Cos(3.0*math.Pi/8.0))

	computeBiquad := func(cutoffHz, sr, q float64) (b0, b1, b2, a1, a2 float64) {
		K := math.Tan(math.Pi * cutoffHz / sr)
		K2 := K * K
		norm := 1.0 + K/q + K2
		b0 = K2 / norm
		b1 = 2.0 * K2 / norm
		b2 = K2 / norm
		a1 = 2.0 * (K2 - 1.0) / norm
		a2 = (1.0 - K/q + K2) / norm
		return
	}

	b0_0, b1_0, b2_0, a1_0, a2_0 := computeBiquad(cutoff, sampleRate, q1)
	b0_1, b1_1, b2_1, a1_1, a2_1 := computeBiquad(cutoff, sampleRate, q2)

	// DC blocker alpha: 1 Hz corner at the given sample rate
	dcAlpha := 1.0 - (2.0 * math.Pi * 1.0 / sampleRate)

	return &IqClientState{
		Phase:    0,
		PhaseInc: 2.0 * math.Pi * float64(tuneOffsetHz) / sampleRate,
		B0_0:    b0_0, B1_0: b1_0, B2_0: b2_0, A1_0: a1_0, A2_0: a2_0,
		B0_1:    b0_1, B1_1: b1_1, B2_1: b2_1, A1_1: a1_1, A2_1: a2_1,
		DecimFactor: factor,
		DCEnabled:   dcEnabled,
		DCAlpha:     dcAlpha,
	}
}

// SetTuneOffset updates the NCO frequency offset.
func (s *IqClientState) SetTuneOffset(hz int, inputRate int) {
	s.PhaseInc = 2.0 * math.Pi * float64(hz) / float64(inputRate)
}

// SetBandwidth updates the Butterworth cutoff and resets filter state.
func (s *IqClientState) SetBandwidth(bwHz int, inputRate int) {
	cutoff := float64(bwHz) / 2.0
	sampleRate := float64(inputRate)
	q1 := 1.0 / (2.0 * math.Cos(math.Pi/8.0))
	q2 := 1.0 / (2.0 * math.Cos(3.0*math.Pi/8.0))

	computeBiquad := func(cutoffHz, sr, q float64) (b0, b1, b2, a1, a2 float64) {
		K := math.Tan(math.Pi * cutoffHz / sr)
		K2 := K * K
		norm := 1.0 + K/q + K2
		b0 = K2 / norm
		b1 = 2.0 * K2 / norm
		b2 = K2 / norm
		a1 = 2.0 * (K2 - 1.0) / norm
		a2 = (1.0 - K/q + K2) / norm
		return
	}

	s.B0_0, s.B1_0, s.B2_0, s.A1_0, s.A2_0 = computeBiquad(cutoff, sampleRate, q1)
	s.B0_1, s.B1_1, s.B2_1, s.A1_1, s.A2_1 = computeBiquad(cutoff, sampleRate, q2)
	// Reset filter state
	s.StI0Z1, s.StI0Z2, s.StI1Z1, s.StI1Z2 = 0, 0, 0, 0
	s.StQ0Z1, s.StQ0Z2, s.StQ1Z1, s.StQ1Z2 = 0, 0, 0, 0
}

// Reset clears all filter state (NCO phase, Butterworth, DC blocker).
func (s *IqClientState) Reset() {
	s.Phase = 0
	s.StI0Z1, s.StI0Z2, s.StI1Z1, s.StI1Z2 = 0, 0, 0, 0
	s.StQ0Z1, s.StQ0Z2, s.StQ1Z1, s.StQ1Z2 = 0, 0, 0, 0
	s.DCI, s.DCQ = 0, 0
}

// MaxClients returns the maximum batch size.
const MaxIqClients = 64

// NewIqPipeline creates a GPU IQ pipeline context.
func (b *vulkanBackend) NewIqPipeline() (*IqPipelineContext, error) {
	if b.dev == nil {
		return nil, fmt.Errorf("gpu: backend not initialized")
	}
	ptr := C.iq_pipeline_create(unsafe.Pointer(b.dev))
	if ptr == nil {
		return nil, fmt.Errorf("gpu: iq_pipeline_create failed")
	}
	return &IqPipelineContext{ptr: ptr}, nil
}

// Process runs the IQ pipeline for a batch of clients on the GPU.
//
// rawIQ: shared input uint8 IQ data (all clients process the same chunk)
// states: per-client state (updated in-place with new filter state after GPU execution)
//
// Returns a slice of int16 slices, one per client (interleaved I,Q).
func (p *IqPipelineContext) Process(rawIQ []byte, states []*IqClientState) ([][]int16, error) {
	numClients := len(states)
	if numClients == 0 {
		return nil, nil
	}
	if numClients > MaxIqClients {
		return nil, fmt.Errorf("gpu: too many clients (%d > %d)", numClients, MaxIqClients)
	}

	inputSamples := len(rawIQ) / 2
	if inputSamples == 0 {
		return nil, nil
	}

	// Convert Go states to C params
	params := make([]C.IqClientParams, numClients)
	for i, s := range states {
		params[i] = C.IqClientParams{
			phaseInit: C.float(s.Phase),
			phaseInc:  C.float(s.PhaseInc),
			b0_0:      C.float(s.B0_0), b1_0: C.float(s.B1_0), b2_0: C.float(s.B2_0),
			a1_0:      C.float(s.A1_0), a2_0: C.float(s.A2_0),
			b0_1:      C.float(s.B0_1), b1_1: C.float(s.B1_1), b2_1: C.float(s.B2_1),
			a1_1:      C.float(s.A1_1), a2_1: C.float(s.A2_1),
			stI0_z1:   C.float(s.StI0Z1), stI0_z2: C.float(s.StI0Z2),
			stI1_z1:   C.float(s.StI1Z1), stI1_z2: C.float(s.StI1Z2),
			stQ0_z1:   C.float(s.StQ0Z1), stQ0_z2: C.float(s.StQ0Z2),
			stQ1_z1:   C.float(s.StQ1Z1), stQ1_z2: C.float(s.StQ1Z2),
			decimFactor: C.uint32_t(s.DecimFactor),
			dcAlpha:     C.float(s.DCAlpha),
			dcI:         C.float(s.DCI),
			dcQ:         C.float(s.DCQ),
		}
		if s.DCEnabled {
			params[i].dcEnabled = 1
		}
	}

	// Allocate output buffers
	maxOutPerClient := inputSamples // worst case
	outBuf := make([]int16, numClients*maxOutPerClient*2)
	outCounts := make([]uint32, numClients)

	rc := C.iq_pipeline_process(
		p.ptr,
		&params[0],
		(*C.uint8_t)(unsafe.Pointer(&rawIQ[0])),
		C.uint32_t(inputSamples),
		C.uint32_t(numClients),
		(*C.int16_t)(unsafe.Pointer(&outBuf[0])),
		(*C.uint32_t)(unsafe.Pointer(&outCounts[0])),
	)
	if rc != 0 {
		return nil, fmt.Errorf("gpu: iq_pipeline_process failed (rc=%d)", int(rc))
	}

	// Update Go states from GPU-modified params
	for i, s := range states {
		s.Phase = float64(params[i].phaseInit)
		s.StI0Z1 = float64(params[i].stI0_z1)
		s.StI0Z2 = float64(params[i].stI0_z2)
		s.StI1Z1 = float64(params[i].stI1_z1)
		s.StI1Z2 = float64(params[i].stI1_z2)
		s.StQ0Z1 = float64(params[i].stQ0_z1)
		s.StQ0Z2 = float64(params[i].stQ0_z2)
		s.StQ1Z1 = float64(params[i].stQ1_z1)
		s.StQ1Z2 = float64(params[i].stQ1_z2)
		s.DCI = float64(params[i].dcI)
		s.DCQ = float64(params[i].dcQ)
	}

	// Split output into per-client slices
	results := make([][]int16, numClients)
	for i := 0; i < numClients; i++ {
		count := int(outCounts[i])
		if count > 0 {
			start := i * maxOutPerClient * 2
			results[i] = outBuf[start : start+count*2]
		}
	}

	return results, nil
}

// Close releases GPU resources.
func (p *IqPipelineContext) Close() {
	if p.ptr != nil {
		C.iq_pipeline_destroy(p.ptr)
		p.ptr = nil
	}
}
