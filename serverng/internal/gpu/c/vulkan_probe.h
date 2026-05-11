/*
 * vulkan_probe.h — minimal Vulkan device enumeration for Go CGO
 *
 * Used by internal/gpu/vulkan.go (build tag: gpu_vulkan).
 * Requires: libvulkan (Linux) or MoltenVK (macOS).
 */
#ifndef VULKAN_PROBE_H
#define VULKAN_PROBE_H

#include <stdint.h>

/* Result struct written by vk_probe(). All fields zero on failure. */
typedef struct {
    char     deviceName[256];          /* VkPhysicalDeviceProperties.deviceName */
    uint32_t deviceType;               /* VkPhysicalDeviceType (0-4) */
    uint64_t vramBytes;                /* largest DEVICE_LOCAL heap, bytes */
    uint32_t maxWorkgroupInvocations;  /* VkPhysicalDeviceLimits.maxComputeWorkGroupInvocations */
    uint32_t maxSharedMemoryBytes;     /* VkPhysicalDeviceLimits.maxComputeSharedMemorySize */
    int      unifiedMemory;            /* 1 if HOST_VISIBLE|DEVICE_LOCAL heap found */
} VkProbeResult;

/*
 * vk_probe — enumerate Vulkan physical devices and pick the best one.
 *
 * Selection priority: discrete > integrated > virtual > cpu > other.
 * Within the same type, picks the device with the largest DEVICE_LOCAL heap.
 *
 * Returns 0 on success, non-zero on any Vulkan error or if no devices found.
 * On failure, *result is zeroed.
 */
int vk_probe(VkProbeResult *result);

#endif /* VULKAN_PROBE_H */
