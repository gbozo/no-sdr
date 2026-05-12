/*
 * vkfft_wrapper.h — GPU FFT via VkFFT
 *
 * Provides a persistent FFT context that processes uint8 IQ samples
 * through a full complex FFT on the GPU, returning float32 dB magnitudes.
 *
 * Thread-safety: none. External caller must serialize calls.
 */
#ifndef VKFFT_WRAPPER_H
#define VKFFT_WRAPPER_H

#include "vulkan_device.h"
#include <stdint.h>

/* Opaque FFT context — allocated/freed by vk_fft_create/vk_fft_destroy. */
typedef struct VkFftContext VkFftContext;

/*
 * vk_fft_create — allocate a GPU FFT context for the given device.
 *
 * fftSize must be a power of two (typically 65536).
 * Returns NULL on failure; caller must call vk_fft_destroy() even on partial init.
 */
VkFftContext *vk_fft_create(VkDeviceContext *dev, uint32_t fftSize);

/*
 * vk_fft_process — run one FFT frame on the GPU.
 *
 * iqData : uint8 raw IQ samples, length = fftSize * 2 (interleaved I, Q)
 * outDb  : float32 output, length = fftSize (all bins, 10*log10(power), no shift)
 *
 * Returns 0 on success, non-zero on Vulkan error.
 */
int vk_fft_process(VkFftContext *ctx, const uint8_t *iqData, float *outDb);

/*
 * vk_fft_destroy — free all GPU resources held by ctx. Safe to call with NULL.
 */
void vk_fft_destroy(VkFftContext *ctx);

#endif /* VKFFT_WRAPPER_H */
