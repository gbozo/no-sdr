//go:build gpu_vulkan

package gpu

/*
#include "c/fm_stereo.h"
#include <stdlib.h>
*/
import "C"
import (
	"fmt"
	"math"
	"sync"
	"unsafe"
)

// MaxFmClients is the maximum number of concurrent WFM stereo clients
// supported by the GPU FM stereo pipeline.
const MaxFmClients = C.FM_MAX_CLIENTS

// MaxFmInputSamples is the maximum input samples per chunk at 240kHz.
const MaxFmInputSamples = C.FM_MAX_INPUT_SAMPLES

// FmStereoContext wraps the GPU FM stereo FIR + matrix + de-emphasis pipeline.
type FmStereoContext struct {
	ptr     *C.FmStereoPipelineCtx
	numTaps int
	queueMu *sync.Mutex // shared with all GPU pipelines — protects vkQueueSubmit
}

// FmClientState holds per-client FM stereo processing state.
// This is kept in Go and marshalled to/from the C struct on each Process call.
type FmClientState struct {
	// FIR delay lines (64 entries each, power-of-2 for masking)
	LprBuf [64]float32
	LrBuf  [64]float32
	LprPos int
	LrPos  int

	// De-emphasis state (75µs IIR)
	DeemphL     float32
	DeemphR     float32
	DeemphAlpha float32

	// DC block state (post-decimation)
	DcPrevL    float32
	DcOutPrevL float32
	DcPrevR    float32
	DcOutPrevR float32

	// Decimation counter
	DecimCounter int
}

// NewFmClientState creates a fresh FM stereo client state with the given
// sample rate and de-emphasis time constant.
// sampleRate: input rate (typically 240000)
// deemphTau: de-emphasis time constant in seconds (75e-6 for US/Japan, 50e-6 for EU)
func NewFmClientState(sampleRate int, deemphTau float64) *FmClientState {
	alpha := float32(1.0 - math.Exp(-1.0/(float64(sampleRate)*deemphTau)))
	return &FmClientState{
		DeemphAlpha: alpha,
	}
}

// Reset clears all state (delay lines, IIR state, counters).
func (s *FmClientState) Reset() {
	*s = FmClientState{DeemphAlpha: s.DeemphAlpha}
}

// NewFmStereoPipeline creates a GPU FM stereo processing pipeline.
// taps: FIR filter coefficients (typically 51 taps, 15kHz LPF at 240kHz)
func (b *vulkanBackend) NewFmStereoPipeline(taps []float32) (*FmStereoContext, error) {
	if b.dev == nil {
		return nil, ErrNotAvailable
	}
	if len(taps) == 0 || len(taps) > C.FM_MAX_TAPS {
		return nil, fmt.Errorf("gpu: FM stereo taps count %d exceeds max %d", len(taps), C.FM_MAX_TAPS)
	}

	cTaps := (*C.float)(unsafe.Pointer(&taps[0]))
	ctx := C.fm_stereo_create(unsafe.Pointer(b.dev), cTaps, C.uint32_t(len(taps)))
	if ctx == nil {
		return nil, fmt.Errorf("gpu: FM stereo pipeline creation failed")
	}

	return &FmStereoContext{ptr: ctx, numTaps: len(taps)}, nil
}

// Process runs the FM stereo FIR + matrix + de-emphasis + decimation pipeline
// on the GPU for a batch of WFM clients.
//
// composite: float32 slice of length numClients * numSamples (FM discriminator output)
// carrier38: float32 slice of length numClients * numSamples (2×cos(2×pilotPhase))
// blends:    float32 slice of length numClients * numSamples (stereo blend [0,1])
// states:    per-client state (updated in place)
// decimFactor: typically 5 (240kHz → 48kHz)
//
// Returns slice of per-client float32 audio buffers (interleaved L,R at decimated rate).
func (f *FmStereoContext) Process(
	composite, carrier38, blends []float32,
	states []*FmClientState,
	numSamples, decimFactor int,
) ([][]float32, error) {
	if f == nil || f.ptr == nil {
		return nil, ErrNotAvailable
	}
	numClients := len(states)
	if numClients == 0 || numClients > int(MaxFmClients) {
		return nil, fmt.Errorf("gpu: FM stereo numClients %d out of range [1,%d]", numClients, MaxFmClients)
	}
	if numSamples > int(MaxFmInputSamples) || numSamples <= 0 {
		return nil, fmt.Errorf("gpu: FM stereo numSamples %d out of range", numSamples)
	}
	expectedLen := numClients * numSamples
	if len(composite) < expectedLen || len(carrier38) < expectedLen || len(blends) < expectedLen {
		return nil, fmt.Errorf("gpu: FM stereo input buffer too short (need %d, got comp=%d carr=%d blend=%d)",
			expectedLen, len(composite), len(carrier38), len(blends))
	}

	// Marshal Go states to C structs
	cStates := make([]C.FmClientState, numClients)
	for i, s := range states {
		for j := 0; j < 64; j++ {
			cStates[i].lprBuf[j] = C.float(s.LprBuf[j])
			cStates[i].lrBuf[j] = C.float(s.LrBuf[j])
		}
		cStates[i].lprPos = C.int32_t(s.LprPos)
		cStates[i].lrPos = C.int32_t(s.LrPos)
		cStates[i].deemphL = C.float(s.DeemphL)
		cStates[i].deemphR = C.float(s.DeemphR)
		cStates[i].deemphAlpha = C.float(s.DeemphAlpha)
		cStates[i].dcPrevL = C.float(s.DcPrevL)
		cStates[i].dcOutPrevL = C.float(s.DcOutPrevL)
		cStates[i].dcPrevR = C.float(s.DcPrevR)
		cStates[i].dcOutPrevR = C.float(s.DcOutPrevR)
		cStates[i].decimCounter = C.int32_t(s.DecimCounter)
	}

	// Allocate output buffers — use ceiling division to handle non-multiple chunk sizes.
	maxOutPerClient := (numSamples + decimFactor - 1) / decimFactor
	outAudio := make([]float32, numClients*maxOutPerClient*2)
	outCounts := make([]uint32, numClients)

	// Lock the shared Vulkan queue — only one pipeline can submit at a time.
	if f.queueMu != nil {
		f.queueMu.Lock()
	}
	rc := C.fm_stereo_process(
		f.ptr,
		&cStates[0],
		(*C.float)(unsafe.Pointer(&composite[0])),
		(*C.float)(unsafe.Pointer(&carrier38[0])),
		(*C.float)(unsafe.Pointer(&blends[0])),
		C.uint32_t(numSamples),
		C.uint32_t(numClients),
		C.uint32_t(decimFactor),
		(*C.float)(unsafe.Pointer(&outAudio[0])),
		(*C.uint32_t)(unsafe.Pointer(&outCounts[0])),
	)
	if f.queueMu != nil {
		f.queueMu.Unlock()
	}
	if rc != 0 {
		return nil, fmt.Errorf("gpu: FM stereo process failed (rc=%d)", int(rc))
	}

	// Unmarshal C states back to Go
	for i, s := range states {
		for j := 0; j < 64; j++ {
			s.LprBuf[j] = float32(cStates[i].lprBuf[j])
			s.LrBuf[j] = float32(cStates[i].lrBuf[j])
		}
		s.LprPos = int(cStates[i].lprPos)
		s.LrPos = int(cStates[i].lrPos)
		s.DeemphL = float32(cStates[i].deemphL)
		s.DeemphR = float32(cStates[i].deemphR)
		s.DcPrevL = float32(cStates[i].dcPrevL)
		s.DcOutPrevL = float32(cStates[i].dcOutPrevL)
		s.DcPrevR = float32(cStates[i].dcPrevR)
		s.DcOutPrevR = float32(cStates[i].dcOutPrevR)
		s.DecimCounter = int(cStates[i].decimCounter)
	}

	// Split per-client results
	results := make([][]float32, numClients)
	offset := 0
	for i := range results {
		count := int(outCounts[i]) * 2 // stereo frames × 2 channels
		results[i] = outAudio[offset : offset+count]
		offset += maxOutPerClient * 2
	}

	return results, nil
}

// Close releases the GPU FM stereo pipeline resources.
func (f *FmStereoContext) Close() {
	if f != nil && f.ptr != nil {
		C.fm_stereo_destroy(f.ptr)
		f.ptr = nil
	}
}
