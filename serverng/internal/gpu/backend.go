//go:build gpu_vulkan

package gpu

/*
#include "c/vulkan_device.h"
*/
import "C"
import (
	"fmt"
)

// vulkanBackend implements backendImpl for the gpu_vulkan build.
// Phase 1 contains device probe + logical device + compute queue.
// Phase 2 will add VkFFT; Phase 3 IQ pipeline shaders, etc.
type vulkanBackend struct {
	cap    Capability
	device C.VkDeviceContext // logical device + compute queue
}

func newVulkanBackend(cap Capability) (*vulkanBackend, error) {
	var ctx C.VkDeviceContext
	if rc := C.vk_device_init(&ctx); rc != 0 {
		return nil, fmt.Errorf("gpu: Vulkan device init failed (rc=%d)", int(rc))
	}
	return &vulkanBackend{cap: cap, device: ctx}, nil
}

func (b *vulkanBackend) close() {
	C.vk_device_destroy(&b.device)
}

func (b *vulkanBackend) fft(rawIQ []byte, fftSize int, window string, averaging float32) ([]float32, error) {
	// Phase 2: VkFFT dispatch goes here.
	// For now return ErrNotAvailable so callers fall through to CPU FFT.
	return nil, ErrNotAvailable
}

func (b *vulkanBackend) maxClients() int {
	// Phase 3: set based on SSBO slot pool size.
	return 0
}
