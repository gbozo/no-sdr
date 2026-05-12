//go:build (gpu_vulkan && linux)

package gpu

/*
#cgo CFLAGS: -I${SRCDIR}/c -I${SRCDIR}/c/vkFFT -I/usr/include/glslang/Include
#cgo linux LDFLAGS: -lglslang -lglslang-default-resource-limits -lSPIRV-Tools-opt -lSPIRV -lvulkan -lm -lstdc++

#include "c/vulkan_probe.c"
#include "c/vulkan_device.c"
#include "c/vkfft_wrapper.c"
#include "c/iq_pipeline.c"
#include "c/fm_stereo.c"
*/
import "C" //nolint:typecheck
