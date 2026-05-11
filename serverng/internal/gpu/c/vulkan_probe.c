/*
 * vulkan_probe.c — Vulkan physical device enumeration
 *
 * Minimal headless Vulkan init: creates a VkInstance, enumerates physical
 * devices, picks the best one by type+VRAM, reports its properties.
 *
 * No window surface, no logical device, no queues — probe only.
 */
#include "vulkan_probe.h"
#include <vulkan/vulkan.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>

/* Device type priority: higher = preferred. */
static int device_type_priority(VkPhysicalDeviceType t) {
    switch (t) {
        case VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU:   return 4;
        case VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU: return 3;
        case VK_PHYSICAL_DEVICE_TYPE_VIRTUAL_GPU:    return 2;
        case VK_PHYSICAL_DEVICE_TYPE_CPU:            return 1;
        default:                                      return 0;
    }
}

int vk_probe(VkProbeResult *result) {
    memset(result, 0, sizeof(*result));

    /* --- Create headless Vulkan instance --- */
    VkApplicationInfo appInfo = {
        .sType              = VK_STRUCTURE_TYPE_APPLICATION_INFO,
        .pApplicationName   = "node-sdr-probe",
        .applicationVersion = VK_MAKE_VERSION(1, 0, 0),
        .pEngineName        = "no-engine",
        .engineVersion      = VK_MAKE_VERSION(1, 0, 0),
        .apiVersion         = VK_API_VERSION_1_2,
    };

    /*
     * On macOS, MoltenVK is a "portability driver". Since Vulkan SDK 1.3.216+
     * the loader requires the application to explicitly opt-in to portability
     * drivers via VK_KHR_portability_enumeration + the portability flag.
     * Without this, vkCreateInstance returns VK_ERROR_INCOMPATIBLE_DRIVER (-9).
     */
#ifdef __APPLE__
    const char *extensions[] = { "VK_KHR_portability_enumeration" };
    VkInstanceCreateInfo instanceCI = {
        .sType                   = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,
        .flags                   = VK_INSTANCE_CREATE_ENUMERATE_PORTABILITY_BIT_KHR,
        .pApplicationInfo        = &appInfo,
        .enabledExtensionCount   = 1,
        .ppEnabledExtensionNames = extensions,
    };
#else
    VkInstanceCreateInfo instanceCI = {
        .sType            = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,
        .pApplicationInfo = &appInfo,
    };
#endif

    VkInstance instance = VK_NULL_HANDLE;
    if (vkCreateInstance(&instanceCI, NULL, &instance) != VK_SUCCESS) {
        return 1;
    }

    /* --- Enumerate physical devices --- */
    uint32_t devCount = 0;
    vkEnumeratePhysicalDevices(instance, &devCount, NULL);
    if (devCount == 0) {
        vkDestroyInstance(instance, NULL);
        return 2;
    }

    VkPhysicalDevice *devices = (VkPhysicalDevice *)alloca(devCount * sizeof(VkPhysicalDevice));
    vkEnumeratePhysicalDevices(instance, &devCount, devices);

    /* --- Pick best device --- */
    int    bestPriority = -1;
    uint64_t bestVRAM   = 0;
    uint32_t bestIdx    = 0;

    for (uint32_t i = 0; i < devCount; i++) {
        VkPhysicalDeviceProperties props;
        vkGetPhysicalDeviceProperties(devices[i], &props);

        /* Compute total DEVICE_LOCAL heap size */
        VkPhysicalDeviceMemoryProperties memProps;
        vkGetPhysicalDeviceMemoryProperties(devices[i], &memProps);

        uint64_t vram = 0;
        for (uint32_t h = 0; h < memProps.memoryHeapCount; h++) {
            if (memProps.memoryHeaps[h].flags & VK_MEMORY_HEAP_DEVICE_LOCAL_BIT) {
                vram += memProps.memoryHeaps[h].size;
            }
        }

        int priority = device_type_priority(props.deviceType);
        if (priority > bestPriority || (priority == bestPriority && vram > bestVRAM)) {
            bestPriority = priority;
            bestVRAM     = vram;
            bestIdx      = i;
        }
    }

    /* --- Collect result for best device --- */
    VkPhysicalDevice best = devices[bestIdx];

    VkPhysicalDeviceProperties props;
    vkGetPhysicalDeviceProperties(best, &props);

    VkPhysicalDeviceMemoryProperties memProps;
    vkGetPhysicalDeviceMemoryProperties(best, &memProps);

    /* Copy device name (guaranteed <= 256 by Vulkan spec) */
    strncpy(result->deviceName, props.deviceName, sizeof(result->deviceName) - 1);
    result->deviceName[sizeof(result->deviceName) - 1] = '\0';

    result->deviceType              = (uint32_t)props.deviceType;
    result->maxWorkgroupInvocations = props.limits.maxComputeWorkGroupInvocations;
    result->maxSharedMemoryBytes    = props.limits.maxComputeSharedMemorySize;

    /* Sum DEVICE_LOCAL heaps for VRAM */
    uint64_t vram = 0;
    for (uint32_t h = 0; h < memProps.memoryHeapCount; h++) {
        if (memProps.memoryHeaps[h].flags & VK_MEMORY_HEAP_DEVICE_LOCAL_BIT) {
            vram += memProps.memoryHeaps[h].size;
        }
    }
    result->vramBytes = vram;

    /* Detect unified memory: any type that is both DEVICE_LOCAL and HOST_VISIBLE */
    result->unifiedMemory = 0;
    for (uint32_t t = 0; t < memProps.memoryTypeCount; t++) {
        VkMemoryPropertyFlags f = memProps.memoryTypes[t].propertyFlags;
        if ((f & VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT) &&
            (f & VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT)) {
            result->unifiedMemory = 1;
            break;
        }
    }

    vkDestroyInstance(instance, NULL);
    return 0;
}
