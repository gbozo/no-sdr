/*
 * vulkan_device.h — Vulkan logical device + compute queue creation
 *
 * Used by internal/gpu/backend.go (build tag: gpu_vulkan).
 */
#ifndef VULKAN_DEVICE_H
#define VULKAN_DEVICE_H

#include <vulkan/vulkan.h>
#include <stdint.h>

/* Holds the Vulkan objects needed for compute dispatch. */
typedef struct {
    VkInstance       instance;
    VkPhysicalDevice physicalDevice;
    VkDevice         device;
    VkQueue          computeQueue;
    uint32_t         computeQueueFamily;
    VkCommandPool    commandPool;
} VkDeviceContext;

/*
 * vk_device_init — create logical device with a compute queue.
 *
 * Picks the same "best" physical device as vk_probe (discrete > integrated ...),
 * finds a compute-capable queue family, creates a logical device, and records
 * a persistent command pool.
 *
 * Returns 0 on success, non-zero on failure. *ctx is zeroed on failure.
 */
int vk_device_init(VkDeviceContext *ctx);

/*
 * vk_device_destroy — release all Vulkan objects in ctx.
 * Safe to call with a zeroed ctx.
 */
void vk_device_destroy(VkDeviceContext *ctx);

#endif /* VULKAN_DEVICE_H */
