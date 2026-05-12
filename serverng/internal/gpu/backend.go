//go:build gpu_vulkan

package gpu

/*
#include "c/vulkan_device.h"
#include <stdlib.h>
*/
import "C"
import (
	"fmt"
	"sync"
	"unsafe"
)

// vulkanBackend implements backendImpl for the gpu_vulkan build.
// dev is allocated on the C heap (C.malloc) so CGO can safely pass it to C
// functions without triggering the "Go pointer to unpinned Go pointer" panic.
type vulkanBackend struct {
	cap    Capability
	dev    *C.VkDeviceContext // C-heap allocated; never points into GC memory
	queueMu sync.Mutex       // protects ALL vkQueueSubmit calls (Vulkan queues are NOT thread-safe)
}

func newVulkanBackend(cap Capability) (*vulkanBackend, error) {
	// Allocate VkDeviceContext on the C heap so the GC cannot move it.
	dev := (*C.VkDeviceContext)(C.malloc(C.size_t(unsafe.Sizeof(C.VkDeviceContext{}))))
	if dev == nil {
		return nil, fmt.Errorf("gpu: failed to allocate VkDeviceContext")
	}
	if rc := C.vk_device_init(dev); rc != 0 {
		C.free(unsafe.Pointer(dev))
		return nil, fmt.Errorf("gpu: Vulkan device init failed (rc=%d)", int(rc))
	}
	return &vulkanBackend{cap: cap, dev: dev}, nil
}

func (b *vulkanBackend) close() {
	if b.dev != nil {
		C.vk_device_destroy(b.dev)
		C.free(unsafe.Pointer(b.dev))
		b.dev = nil
	}
}

func (b *vulkanBackend) fft(rawIQ []byte, fftSize int, window string, averaging float32) ([]float32, error) {
	// Phase 2: VkFFT dispatch goes here.
	// For now return ErrNotAvailable so callers fall through to CPU FFT.
	return nil, ErrNotAvailable
}

func (b *vulkanBackend) maxClients() int {
	// Phase 3: IQ pipeline supports up to 64 clients.
	return MaxIqClients
}

func (b *vulkanBackend) newFFT(fftSize int) (*FFTContext, error) {
	ctx, err := b.NewFFT(fftSize)
	if err != nil {
		return nil, err
	}
	ctx.queueMu = &b.queueMu
	return ctx, nil
}

func (b *vulkanBackend) newIqPipeline() (*IqPipelineContext, error) {
	ctx, err := b.NewIqPipeline()
	if err != nil {
		return nil, err
	}
	ctx.queueMu = &b.queueMu
	return ctx, nil
}

func (b *vulkanBackend) newFmStereoPipeline(taps []float32) (*FmStereoContext, error) {
	ctx, err := b.NewFmStereoPipeline(taps)
	if err != nil {
		return nil, err
	}
	ctx.queueMu = &b.queueMu
	return ctx, nil
}

