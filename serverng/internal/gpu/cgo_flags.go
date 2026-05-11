//go:build gpu_vulkan

package gpu

/*
#cgo CFLAGS: -I${SRCDIR}/c
#cgo darwin CFLAGS: -I/Users/I570173/VulkanSDK/1.4.341.1/macOS/include
#cgo darwin LDFLAGS: -L/Users/I570173/VulkanSDK/1.4.341.1/macOS/lib -lvulkan -Wl,-rpath,/Users/I570173/VulkanSDK/1.4.341.1/macOS/lib
#cgo linux LDFLAGS: -lvulkan

// Unity build: compile both C source files in a single translation unit.
// vulkan_probe.c must come first as it defines device_type_priority().
#include "c/vulkan_probe.c"
#include "c/vulkan_device.c"
*/
import "C" //nolint:typecheck
