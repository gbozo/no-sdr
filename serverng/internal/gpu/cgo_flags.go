//go:build gpu_vulkan && linux && !musl

package gpu

/*
#cgo CFLAGS: -I${SRCDIR}/c -I${SRCDIR}/c/vkFFT -I/usr/include/glslang/Include

// Debian/Ubuntu use static libs (.a) requiring linker groups for circular deps.
#cgo LDFLAGS: -Wl,--start-group -lglslang -lMachineIndependent -lOSDependent -lHLSL -lOGLCompiler -lGenericCodeGen -lSPVRemapper -lglslang-default-resource-limits -lSPIRV-Tools-opt -lSPIRV-Tools -lSPIRV -lglslang -lpthread -Wl,--end-group -lvulkan -lm -lstdc++

#include "c/vulkan_probe.c"
#include "c/vulkan_device.c"
#include "c/vkfft_wrapper.c"
#include "c/iq_pipeline.c"
#include "c/fm_stereo.c"
*/
import "C" //nolint:typecheck