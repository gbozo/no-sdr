//go:build gpu_vulkan

package gpu

/*
#include "c/vulkan_probe.h"
*/
import "C"
import (
	"log/slog"
	"unsafe"
)

// probe detects the best available Vulkan physical device.
// Returns Available=false on any error (missing Vulkan runtime, no devices, etc.).
func probe() Capability {
	var info C.VkProbeResult
	rc := C.vk_probe(&info)
	if rc != 0 {
		// rc meanings: 1=vkCreateInstance failed, 2=no physical devices found
		slog.Info("gpu: vk_probe failed", "rc", int(rc))
		return Capability{Available: false}
	}

	devType := deviceTypeFromVk(uint32(info.deviceType))

	return Capability{
		Available:                      true,
		DeviceName:                     C.GoString(&info.deviceName[0]),
		DeviceType:                     devType,
		VRAM:                           uint64(info.vramBytes),
		MaxComputeWorkgroupInvocations: uint32(info.maxWorkgroupInvocations),
		MaxComputeSharedMemorySize:     uint32(info.maxSharedMemoryBytes),
		VkFFTAvailable:                 false, // set true in Phase 2 after VkFFT init
		UnifiedMemory:                  info.unifiedMemory != 0,
	}
}

func newBackend(cap Capability) (*Backend, error) {
	impl, err := newVulkanBackend(cap)
	if err != nil {
		return nil, err
	}
	return &Backend{impl: impl}, nil
}

// deviceTypeFromVk maps VkPhysicalDeviceType values to our DeviceType constants.
// VkPhysicalDeviceType values per Vulkan spec:
//
//	0 = OTHER, 1 = INTEGRATED_GPU, 2 = DISCRETE_GPU, 3 = VIRTUAL_GPU, 4 = CPU
func deviceTypeFromVk(t uint32) DeviceType {
	switch t {
	case 1:
		return DeviceIntegrated
	case 2:
		return DeviceDiscrete
	case 3:
		return DeviceVirtual
	case 4:
		return DeviceCPU
	default:
		return DeviceOther
	}
}

// Silence the "unsafe" import warning — used by C.GoString indirectly.
var _ = unsafe.Sizeof(0)
