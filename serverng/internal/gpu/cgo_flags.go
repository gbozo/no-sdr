//go:build gpu_vulkan

package gpu

/*
#cgo CFLAGS: -I${SRCDIR}/c -I${SRCDIR}/c/vkFFT
#cgo darwin CFLAGS: -I/Users/I570173/VulkanSDK/1.4.341.1/macOS/include -I/Users/I570173/VulkanSDK/1.4.341.1/macOS/include/glslang/Include
#cgo darwin LDFLAGS: -L/Users/I570173/VulkanSDK/1.4.341.1/macOS/lib -lvulkan -Wl,-rpath,/Users/I570173/VulkanSDK/1.4.341.1/macOS/lib
#cgo linux CFLAGS: -I/usr/include -I/usr/include/glslang/Include
#cgo linux LDFLAGS: -lvulkan

// glslang (needed by VkFFT for runtime SPIR-V compilation)
#cgo darwin LDFLAGS: -lglslang -lglslang-default-resource-limits -lSPIRV
#cgo linux  LDFLAGS: -lglslang -lglslang-default-resource-limits -lSPIRV

// Unity build: compile all C source files in a single translation unit.
// vulkan_probe.c must come first as it defines device_type_priority().
#include "c/vulkan_probe.c"
#include "c/vulkan_device.c"
#include "c/vkfft_wrapper.c"
#include "c/iq_pipeline.c"
#include "c/fm_stereo.c"
*/
import "C" //nolint:typecheck
