//go:build gpu_vulkan && linux && musl

package gpu

/*
#cgo CFLAGS: -I${SRCDIR}/c -I${SRCDIR}/c/vkFFT -I/usr/include/glslang/Include

// Alpine uses shared libs (.so) — simple linking works.
#cgo LDFLAGS: -lglslang -lglslang-default-resource-limits -lSPIRV-Tools-opt -lSPIRV -lvulkan -lm -lstdc++

#include "c/vulkan_probe.c"
#include "c/vulkan_device.c"
#include "c/vkfft_wrapper.c"
#include "c/iq_pipeline.c"
#include "c/fm_stereo.c"
*/
import "C" //nolint:typecheck