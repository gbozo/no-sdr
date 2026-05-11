// Package gpu provides GPU acceleration for the SDR DSP pipeline via Vulkan
// compute shaders and VkFFT.
//
// Build tags:
//   - (default)   — CPU stub only; all operations return ErrNotAvailable.
//   - gpu_vulkan  — Vulkan + VkFFT backend compiled in via CGO.
//
// Usage pattern in callers:
//
//	cap := gpu.Probe()
//	if cap.Available {
//	    backend, err := gpu.NewBackend(cap)
//	    if err == nil {
//	        fftProc.SetGPUBackend(backend)
//	        defer backend.Close()
//	    }
//	}
//
// All Backend methods are nil-safe: calling on a nil *Backend returns
// ErrNotAvailable and the caller falls through to the CPU path.
package gpu

import (
	"errors"
	"log/slog"
)

// ErrNotAvailable is returned by all Backend methods when GPU acceleration
// is not available (missing build tag, no Vulkan device, or init failure).
var ErrNotAvailable = errors.New("gpu: not available")

// DeviceType classifies the physical GPU.
type DeviceType string

const (
	DeviceDiscrete   DeviceType = "discrete"
	DeviceIntegrated DeviceType = "integrated"
	DeviceCPU        DeviceType = "cpu"
	DeviceVirtual    DeviceType = "virtual"
	DeviceOther      DeviceType = "other"
)

// Capability reports what GPU acceleration is available at runtime.
// Returned by Probe(); safe to inspect even when Available is false.
type Capability struct {
	// Available is true only when a usable Vulkan device was found and
	// the gpu_vulkan build tag is present.
	Available bool

	// DeviceName is the Vulkan device name string (e.g. "AMD Radeon 680M").
	DeviceName string

	// DeviceType classifies the GPU role.
	DeviceType DeviceType

	// VRAM is the total device-local memory in bytes.
	// For integrated GPUs this reflects shared system memory visible to the GPU.
	VRAM uint64

	// MaxComputeWorkgroupInvocations is the hardware limit on threads per workgroup.
	MaxComputeWorkgroupInvocations uint32

	// MaxComputeSharedMemorySize is the hardware limit on shared memory per workgroup (bytes).
	MaxComputeSharedMemorySize uint32

	// VkFFTAvailable indicates whether the VkFFT library was compiled in
	// (requires gpu_vulkan tag) and successfully initialized.
	VkFFTAvailable bool

	// UnifiedMemory is true when the device supports HOST_VISIBLE + DEVICE_LOCAL
	// memory (typical on integrated GPUs) — enables zero-copy IQ input.
	UnifiedMemory bool
}

// Probe detects GPU capabilities. It never panics and never returns an error;
// callers check cap.Available. Safe to call multiple times.
func Probe() Capability {
	return probe()
}

// LogCapability emits a structured log summary of cap using logger.
func LogCapability(cap Capability, logger *slog.Logger) {
	if !cap.Available {
		logger.Info("gpu: acceleration unavailable (build without gpu_vulkan tag or no Vulkan device)")
		return
	}
	logger.Info("gpu: Vulkan device ready",
		"device", cap.DeviceName,
		"type", cap.DeviceType,
		"vram_mb", cap.VRAM/1024/1024,
		"unified_memory", cap.UnifiedMemory,
		"vkfft", cap.VkFFTAvailable,
		"max_workgroup", cap.MaxComputeWorkgroupInvocations,
	)
}

// Backend is the GPU computation backend.
// Obtain via NewBackend; must be closed with Close when done.
// All methods are nil-safe (return ErrNotAvailable on nil receiver).
type Backend struct {
	impl backendImpl
}

// NewBackend creates a GPU backend from a probed Capability.
// Returns an error (and a nil Backend) if the backend cannot be initialized.
// If cap.Available is false, returns ErrNotAvailable without attempting init.
func NewBackend(cap Capability) (*Backend, error) {
	if !cap.Available {
		return nil, ErrNotAvailable
	}
	return newBackend(cap)
}

// Close releases all GPU resources held by this backend.
// Safe to call on nil.
func (b *Backend) Close() {
	if b != nil && b.impl != nil {
		b.impl.close()
	}
}

// FFT performs a power-of-2 FFT on uint8 IQ data and returns magnitude in dB.
//
// rawIQ must have length == 2*fftSize (interleaved I, Q bytes, bias 127.5).
// window selects the apodization window: "blackman-harris", "hann", "hamming".
// averaging is the exponential smoothing coefficient in [0, 1); 0 = no smoothing.
//
// The returned slice has length fftSize with DC shifted to center (bin 0 = lowest freq).
// Returns ErrNotAvailable if GPU FFT is not initialised.
func (b *Backend) FFT(rawIQ []byte, fftSize int, window string, averaging float32) ([]float32, error) {
	if b == nil || b.impl == nil {
		return nil, ErrNotAvailable
	}
	return b.impl.fft(rawIQ, fftSize, window, averaging)
}

// MaxClients returns the maximum number of concurrent IQ pipeline client slots
// this backend supports. Returns 0 when not available.
func (b *Backend) MaxClients() int {
	if b == nil || b.impl == nil {
		return 0
	}
	return b.impl.maxClients()
}

// backendImpl is the internal interface implemented by the tag-selected backend.
type backendImpl interface {
	close()
	fft(rawIQ []byte, fftSize int, window string, averaging float32) ([]float32, error)
	maxClients() int
}
