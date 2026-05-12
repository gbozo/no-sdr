/*
 * vulkan_device.c — Vulkan logical device + compute queue creation
 */
#include "vulkan_device.h"
#include "vulkan_probe.h"
#include <string.h>
#include <stdlib.h>
#include <stdio.h>

/* device_type_priority is defined in vulkan_probe.c — forward declare here */
static int device_type_priority(VkPhysicalDeviceType t);

/* Pick the best physical device by same priority+VRAM logic as vk_probe. */
static VkPhysicalDevice pick_physical_device(VkInstance instance) {
    uint32_t count = 0;
    vkEnumeratePhysicalDevices(instance, &count, NULL);
    if (count == 0) return VK_NULL_HANDLE;

    VkPhysicalDevice *devs = (VkPhysicalDevice *)alloca(count * sizeof(VkPhysicalDevice));
    vkEnumeratePhysicalDevices(instance, &count, devs);

    int      bestPri  = -1;
    uint64_t bestVRAM = 0;
    VkPhysicalDevice best = VK_NULL_HANDLE;

    for (uint32_t i = 0; i < count; i++) {
        VkPhysicalDeviceProperties props;
        vkGetPhysicalDeviceProperties(devs[i], &props);

        VkPhysicalDeviceMemoryProperties memProps;
        vkGetPhysicalDeviceMemoryProperties(devs[i], &memProps);

        uint64_t vram = 0;
        for (uint32_t h = 0; h < memProps.memoryHeapCount; h++) {
            if (memProps.memoryHeaps[h].flags & VK_MEMORY_HEAP_DEVICE_LOCAL_BIT)
                vram += memProps.memoryHeaps[h].size;
        }

        int pri = device_type_priority(props.deviceType);
        if (pri > bestPri || (pri == bestPri && vram > bestVRAM)) {
            bestPri  = pri;
            bestVRAM = vram;
            best     = devs[i];
        }
    }
    return best;
}

/* Find a queue family that supports VK_QUEUE_COMPUTE_BIT. Prefer a compute-only
 * family (no graphics bit) to avoid contention on desktop GPUs. */
static int find_compute_queue_family(VkPhysicalDevice pdev, uint32_t *familyIndex) {
    uint32_t count = 0;
    vkGetPhysicalDeviceQueueFamilyProperties(pdev, &count, NULL);
    if (count == 0) return -1;

    VkQueueFamilyProperties *props =
        (VkQueueFamilyProperties *)alloca(count * sizeof(VkQueueFamilyProperties));
    vkGetPhysicalDeviceQueueFamilyProperties(pdev, &count, props);

    /* First pass: compute-only (no graphics) — dedicated compute queue */
    for (uint32_t i = 0; i < count; i++) {
        VkQueueFlags f = props[i].queueFlags;
        if ((f & VK_QUEUE_COMPUTE_BIT) && !(f & VK_QUEUE_GRAPHICS_BIT)) {
            *familyIndex = i;
            return 0;
        }
    }
    /* Second pass: any compute-capable family */
    for (uint32_t i = 0; i < count; i++) {
        if (props[i].queueFlags & VK_QUEUE_COMPUTE_BIT) {
            *familyIndex = i;
            return 0;
        }
    }
    return -1;
}

int vk_device_init(VkDeviceContext *ctx) {
    memset(ctx, 0, sizeof(*ctx));

    /* --- Instance --- */
    VkApplicationInfo appInfo = {
        .sType              = VK_STRUCTURE_TYPE_APPLICATION_INFO,
        .pApplicationName   = "node-sdr",
        .applicationVersion = VK_MAKE_VERSION(1, 0, 0),
        .pEngineName        = "no-engine",
        .engineVersion      = VK_MAKE_VERSION(1, 0, 0),
        .apiVersion         = VK_API_VERSION_1_2,
    };
    /*
     * On macOS, MoltenVK is a portability driver. Since Vulkan SDK 1.3.216+
     * the loader requires VK_KHR_portability_enumeration + the portability flag.
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
    if (vkCreateInstance(&instanceCI, NULL, &ctx->instance) != VK_SUCCESS)
        return 1;

    /* --- Physical device --- */
    ctx->physicalDevice = pick_physical_device(ctx->instance);
    if (ctx->physicalDevice == VK_NULL_HANDLE) {
        vkDestroyInstance(ctx->instance, NULL);
        ctx->instance = VK_NULL_HANDLE;
        return 2;
    }

    /* --- Compute queue family --- */
    if (find_compute_queue_family(ctx->physicalDevice, &ctx->computeQueueFamily) != 0) {
        vkDestroyInstance(ctx->instance, NULL);
        ctx->instance = VK_NULL_HANDLE;
        return 3;
    }

    /* --- Logical device --- */
    float queuePriority = 1.0f;
    VkDeviceQueueCreateInfo queueCI = {
        .sType            = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO,
        .queueFamilyIndex = ctx->computeQueueFamily,
        .queueCount       = 1,
        .pQueuePriorities = &queuePriority,
    };
    /*
     * On macOS, MoltenVK requires VK_KHR_portability_subset at device creation
     * (Vulkan Portability Specification §4.1.1). Omitting it causes vkCreateDevice
     * to succeed but later API calls to produce undefined behaviour / crashes.
     */
#ifdef __APPLE__
    const char *devExts[] = { "VK_KHR_portability_subset" };
    VkDeviceCreateInfo deviceCI = {
        .sType                   = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO,
        .queueCreateInfoCount    = 1,
        .pQueueCreateInfos       = &queueCI,
        .enabledExtensionCount   = 1,
        .ppEnabledExtensionNames = devExts,
    };
#else
    VkDeviceCreateInfo deviceCI = {
        .sType                = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO,
        .queueCreateInfoCount = 1,
        .pQueueCreateInfos    = &queueCI,
    };
#endif
    if (vkCreateDevice(ctx->physicalDevice, &deviceCI, NULL, &ctx->device) != VK_SUCCESS) {
        vkDestroyInstance(ctx->instance, NULL);
        ctx->instance = VK_NULL_HANDLE;
        return 4;
    }

    /* --- Retrieve queue handle --- */
    vkGetDeviceQueue(ctx->device, ctx->computeQueueFamily, 0, &ctx->computeQueue);

    /* --- Command pool --- */
    VkCommandPoolCreateInfo poolCI = {
        .sType            = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO,
        .queueFamilyIndex = ctx->computeQueueFamily,
        .flags            = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT,
    };
    if (vkCreateCommandPool(ctx->device, &poolCI, NULL, &ctx->commandPool) != VK_SUCCESS) {
        vkDestroyDevice(ctx->device, NULL);
        vkDestroyInstance(ctx->instance, NULL);
        memset(ctx, 0, sizeof(*ctx));
        return 5;
    }

    return 0;
}

void vk_device_destroy(VkDeviceContext *ctx) {
    if (!ctx) return;
    if (ctx->device != VK_NULL_HANDLE) {
        if (ctx->commandPool != VK_NULL_HANDLE)
            vkDestroyCommandPool(ctx->device, ctx->commandPool, NULL);
        vkDestroyDevice(ctx->device, NULL);
    }
    if (ctx->instance != VK_NULL_HANDLE)
        vkDestroyInstance(ctx->instance, NULL);
    memset(ctx, 0, sizeof(*ctx));
}
