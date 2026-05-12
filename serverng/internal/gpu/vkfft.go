//go:build gpu_vulkan

package gpu

/*
#include "c/vkfft_wrapper.h"
*/
import "C"
import (
	"fmt"
	"sync"
	"unsafe"
)

// FFTContext wraps a VkFftContext for GPU FFT processing.
// Use Backend.NewFFT() to create; call Close() when done.
type FFTContext struct {
	ptr     *C.VkFftContext
	n       int // FFT size
	queueMu *sync.Mutex // shared with all GPU pipelines — protects vkQueueSubmit
}

// NewFFT creates a persistent GPU FFT context for the given FFT size.
// fftSize must be a power of two (e.g. 65536).
func (b *vulkanBackend) NewFFT(fftSize int) (*FFTContext, error) {
	if b.dev == nil {
		return nil, fmt.Errorf("gpu: backend not initialized")
	}
	ptr := C.vk_fft_create(b.dev, C.uint(fftSize))
	if ptr == nil {
		return nil, fmt.Errorf("gpu: vk_fft_create failed (fftSize=%d)", fftSize)
	}
	return &FFTContext{ptr: ptr, n: fftSize}, nil
}

// Process runs a single FFT frame on the GPU.
//
// iq must contain fftSize*2 uint8 bytes (interleaved I, Q).
// The returned slice has fftSize float32 values: 10*log10(power) for each bin,
// in natural FFT order (DC at bin 0). Caller must apply FFT-shift and normalization.
//
// The returned slice is valid until the next call to Process or Close.
func (f *FFTContext) Process(iq []byte) ([]float32, error) {
	if len(iq) < f.n*2 {
		return nil, fmt.Errorf("gpu: iq buffer too small (need %d, got %d)", f.n*2, len(iq))
	}
	out := make([]float32, f.n)

	// Lock the shared Vulkan queue — only one pipeline can submit at a time.
	if f.queueMu != nil {
		f.queueMu.Lock()
		defer f.queueMu.Unlock()
	}

	rc := C.vk_fft_process(
		f.ptr,
		(*C.uint8_t)(unsafe.Pointer(&iq[0])),
		(*C.float)(unsafe.Pointer(&out[0])),
	)
	if rc != 0 {
		return nil, fmt.Errorf("gpu: vk_fft_process failed (rc=%d)", int(rc))
	}
	return out, nil
}

// Close releases GPU resources held by this FFT context.
func (f *FFTContext) Close() {
	if f.ptr != nil {
		C.vk_fft_destroy(f.ptr)
		f.ptr = nil
	}
}
