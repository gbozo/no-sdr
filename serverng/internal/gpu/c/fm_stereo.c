// fm_stereo.c — Vulkan compute pipeline for FM stereo FIR + matrix + de-emphasis + decimation
#include "fm_stereo.h"
#include "vulkan_device.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

// GLSL shader source (compiled at runtime via glslang)
#include "fm_stereo_glsl.inc"

// compile_iq_glsl is defined in iq_pipeline.c (included before this file in the unity build).

struct FmStereoPipelineCtx {
    VkDevice device;
    VkQueue queue;
    VkCommandBuffer cmdBuf;
    VkFence fence;

    VkDescriptorSetLayout descLayout;
    VkPipelineLayout pipelineLayout;
    VkPipeline pipeline;
    VkDescriptorPool descPool;
    VkDescriptorSet descSet;

    // SSBOs
    VkBuffer tapsBuf;           // binding 0: FIR taps (read-only, small)
    VkDeviceMemory tapsMem;

    VkBuffer statesBuf;         // binding 1: per-client state (read+write)
    VkDeviceMemory statesMem;

    VkBuffer compositeBuf;      // binding 2: input composite
    VkDeviceMemory compositeMem;

    VkBuffer carrier38Buf;      // binding 3: input carrier
    VkDeviceMemory carrier38Mem;

    VkBuffer blendsBuf;         // binding 4: input blends
    VkDeviceMemory blendsMem;

    VkBuffer audioOutBuf;       // binding 5: output audio
    VkDeviceMemory audioOutMem;

    VkBuffer outCountsBuf;      // binding 6: output counts
    VkDeviceMemory outCountsMem;

    // Staging buffers (host-visible)
    VkBuffer stagingIn;         // composite + carrier38 + blends
    VkDeviceMemory stagingInMem;
    VkBuffer stagingStates;     // states upload/download
    VkDeviceMemory stagingStatesMem;
    VkBuffer stagingOut;        // audio + counts download
    VkDeviceMemory stagingOutMem;

    VkPhysicalDevice physDevice;
    uint32_t numTaps;
};

// Helper: find suitable memory type
static uint32_t fm_findMemoryType(VkPhysicalDevice phys, uint32_t typeFilter, VkMemoryPropertyFlags props) {
    VkPhysicalDeviceMemoryProperties memProps;
    vkGetPhysicalDeviceMemoryProperties(phys, &memProps);
    for (uint32_t i = 0; i < memProps.memoryTypeCount; i++) {
        if ((typeFilter & (1 << i)) && (memProps.memoryTypes[i].propertyFlags & props) == props) {
            return i;
        }
    }
    return UINT32_MAX;
}

// Helper: create buffer + allocate memory
static int fm_createBuffer(VkDevice dev, VkPhysicalDevice phys, VkDeviceSize size,
                           VkBufferUsageFlags usage, VkMemoryPropertyFlags memProps,
                           VkBuffer* buf, VkDeviceMemory* mem) {
    VkBufferCreateInfo ci = {
        .sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO,
        .size = size,
        .usage = usage,
        .sharingMode = VK_SHARING_MODE_EXCLUSIVE,
    };
    if (vkCreateBuffer(dev, &ci, NULL, buf) != VK_SUCCESS) return -1;

    VkMemoryRequirements reqs;
    vkGetBufferMemoryRequirements(dev, *buf, &reqs);

    uint32_t memIdx = fm_findMemoryType(phys, reqs.memoryTypeBits, memProps);
    if (memIdx == UINT32_MAX) { vkDestroyBuffer(dev, *buf, NULL); return -1; }

    VkMemoryAllocateInfo ai = {
        .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
        .allocationSize = reqs.size,
        .memoryTypeIndex = memIdx,
    };
    if (vkAllocateMemory(dev, &ai, NULL, mem) != VK_SUCCESS) {
        vkDestroyBuffer(dev, *buf, NULL);
        return -1;
    }
    vkBindBufferMemory(dev, *buf, *mem, 0);
    return 0;
}

FmStereoPipelineCtx* fm_stereo_create(void* dev, const float* taps, uint32_t numTaps) {
    VkDeviceContext* vkDev = (VkDeviceContext*)dev;
    if (!vkDev || numTaps > FM_MAX_TAPS) return NULL;

    FmStereoPipelineCtx* ctx = (FmStereoPipelineCtx*)calloc(1, sizeof(FmStereoPipelineCtx));
    if (!ctx) return NULL;

    ctx->device = vkDev->device;
    ctx->queue = vkDev->computeQueue;
    ctx->physDevice = vkDev->physicalDevice;
    ctx->numTaps = numTaps;

    // Compile shader
    uint32_t spirvSize = 0;
    uint32_t* spirv = compile_iq_glsl(kFmStereoGLSL, &spirvSize);
    if (!spirv) {
        free(ctx);
        return NULL;
    }

    // Create shader module
    VkShaderModuleCreateInfo smCI = {
        .sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO,
        .codeSize = (size_t)spirvSize,
        .pCode = spirv,
    };
    VkShaderModule shaderMod;
    VkResult vr = vkCreateShaderModule(ctx->device, &smCI, NULL, &shaderMod);
    free(spirv);
    if (vr != VK_SUCCESS) { free(ctx); return NULL; }

    // Descriptor set layout: 7 SSBO bindings
    VkDescriptorSetLayoutBinding bindings[7];
    for (int i = 0; i < 7; i++) {
        bindings[i] = (VkDescriptorSetLayoutBinding){
            .binding = i,
            .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
            .descriptorCount = 1,
            .stageFlags = VK_SHADER_STAGE_COMPUTE_BIT,
        };
    }
    VkDescriptorSetLayoutCreateInfo dslCI = {
        .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
        .bindingCount = 7,
        .pBindings = bindings,
    };
    vr = vkCreateDescriptorSetLayout(ctx->device, &dslCI, NULL, &ctx->descLayout);
    if (vr != VK_SUCCESS) goto fail_shader;

    // Pipeline layout with push constants
    VkPushConstantRange pcRange = {
        .stageFlags = VK_SHADER_STAGE_COMPUTE_BIT,
        .offset = 0,
        .size = sizeof(FmPushConstants),
    };
    VkPipelineLayoutCreateInfo plCI = {
        .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
        .setLayoutCount = 1,
        .pSetLayouts = &ctx->descLayout,
        .pushConstantRangeCount = 1,
        .pPushConstantRanges = &pcRange,
    };
    vr = vkCreatePipelineLayout(ctx->device, &plCI, NULL, &ctx->pipelineLayout);
    if (vr != VK_SUCCESS) goto fail_dsl;

    // Compute pipeline
    VkComputePipelineCreateInfo cpCI = {
        .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
        .stage = {
            .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
            .stage = VK_SHADER_STAGE_COMPUTE_BIT,
            .module = shaderMod,
            .pName = "main",
        },
        .layout = ctx->pipelineLayout,
    };
    vr = vkCreateComputePipelines(ctx->device, VK_NULL_HANDLE, 1, &cpCI, NULL, &ctx->pipeline);
    vkDestroyShaderModule(ctx->device, shaderMod, NULL);
    if (vr != VK_SUCCESS) goto fail_pl;

    // Descriptor pool
    VkDescriptorPoolSize poolSize = { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 7 };
    VkDescriptorPoolCreateInfo dpCI = {
        .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO,
        .maxSets = 1,
        .poolSizeCount = 1,
        .pPoolSizes = &poolSize,
    };
    vr = vkCreateDescriptorPool(ctx->device, &dpCI, NULL, &ctx->descPool);
    if (vr != VK_SUCCESS) goto fail_pipe;

    // Allocate descriptor set
    VkDescriptorSetAllocateInfo dsAI = {
        .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
        .descriptorPool = ctx->descPool,
        .descriptorSetCount = 1,
        .pSetLayouts = &ctx->descLayout,
    };
    vr = vkAllocateDescriptorSets(ctx->device, &dsAI, &ctx->descSet);
    if (vr != VK_SUCCESS) goto fail_pool;

    // Buffer sizes
    VkDeviceSize tapsSize = numTaps * sizeof(float);
    VkDeviceSize statesSize = FM_MAX_CLIENTS * sizeof(FmClientState);
    VkDeviceSize inputSize = (VkDeviceSize)FM_MAX_CLIENTS * FM_MAX_INPUT_SAMPLES * sizeof(float);
    VkDeviceSize maxOutSamples = FM_MAX_INPUT_SAMPLES / 5;  // min decim factor
    VkDeviceSize audioOutSize = (VkDeviceSize)FM_MAX_CLIENTS * maxOutSamples * 2 * sizeof(float);
    VkDeviceSize countsSize = FM_MAX_CLIENTS * sizeof(uint32_t);

    VkBufferUsageFlags devUsage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT;
    VkMemoryPropertyFlags devMem = VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT;
    VkBufferUsageFlags hostUsage = VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT;
    VkMemoryPropertyFlags hostMem = VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;

    // Create device-local buffers
    if (fm_createBuffer(ctx->device, ctx->physDevice, tapsSize, devUsage, devMem, &ctx->tapsBuf, &ctx->tapsMem) != 0) goto fail_pool;
    if (fm_createBuffer(ctx->device, ctx->physDevice, statesSize, devUsage, devMem, &ctx->statesBuf, &ctx->statesMem) != 0) goto fail_pool;
    if (fm_createBuffer(ctx->device, ctx->physDevice, inputSize, devUsage, devMem, &ctx->compositeBuf, &ctx->compositeMem) != 0) goto fail_pool;
    if (fm_createBuffer(ctx->device, ctx->physDevice, inputSize, devUsage, devMem, &ctx->carrier38Buf, &ctx->carrier38Mem) != 0) goto fail_pool;
    if (fm_createBuffer(ctx->device, ctx->physDevice, inputSize, devUsage, devMem, &ctx->blendsBuf, &ctx->blendsMem) != 0) goto fail_pool;
    if (fm_createBuffer(ctx->device, ctx->physDevice, audioOutSize, devUsage, devMem, &ctx->audioOutBuf, &ctx->audioOutMem) != 0) goto fail_pool;
    if (fm_createBuffer(ctx->device, ctx->physDevice, countsSize, devUsage, devMem, &ctx->outCountsBuf, &ctx->outCountsMem) != 0) goto fail_pool;

    // Create staging buffers
    VkDeviceSize stagingInSize = inputSize * 3; // composite + carrier38 + blends
    VkDeviceSize stagingOutSize = audioOutSize + countsSize;
    if (fm_createBuffer(ctx->device, ctx->physDevice, stagingInSize, hostUsage, hostMem, &ctx->stagingIn, &ctx->stagingInMem) != 0) goto fail_pool;
    if (fm_createBuffer(ctx->device, ctx->physDevice, statesSize, hostUsage, hostMem, &ctx->stagingStates, &ctx->stagingStatesMem) != 0) goto fail_pool;
    if (fm_createBuffer(ctx->device, ctx->physDevice, stagingOutSize, hostUsage, hostMem, &ctx->stagingOut, &ctx->stagingOutMem) != 0) goto fail_pool;

    // Write descriptor set
    VkBuffer allBufs[7] = { ctx->tapsBuf, ctx->statesBuf, ctx->compositeBuf, ctx->carrier38Buf, ctx->blendsBuf, ctx->audioOutBuf, ctx->outCountsBuf };
    VkDeviceSize allSizes[7] = { tapsSize, statesSize, inputSize, inputSize, inputSize, audioOutSize, countsSize };
    VkWriteDescriptorSet writes[7];
    VkDescriptorBufferInfo bufInfos[7];
    for (int i = 0; i < 7; i++) {
        bufInfos[i] = (VkDescriptorBufferInfo){ .buffer = allBufs[i], .offset = 0, .range = allSizes[i] };
        writes[i] = (VkWriteDescriptorSet){
            .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET,
            .dstSet = ctx->descSet,
            .dstBinding = i,
            .descriptorCount = 1,
            .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
            .pBufferInfo = &bufInfos[i],
        };
    }
    vkUpdateDescriptorSets(ctx->device, 7, writes, 0, NULL);

    // Command buffer
    VkCommandBufferAllocateInfo cbAI = {
        .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
        .commandPool = vkDev->commandPool,
        .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY,
        .commandBufferCount = 1,
    };
    vr = vkAllocateCommandBuffers(ctx->device, &cbAI, &ctx->cmdBuf);
    if (vr != VK_SUCCESS) goto fail_pool;

    // Fence
    VkFenceCreateInfo fCI = { .sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO };
    vr = vkCreateFence(ctx->device, &fCI, NULL, &ctx->fence);
    if (vr != VK_SUCCESS) goto fail_pool;

    // Upload taps (one-time)
    void* mapped;
    vkMapMemory(ctx->device, ctx->stagingInMem, 0, tapsSize, 0, &mapped);
    memcpy(mapped, taps, tapsSize);
    vkUnmapMemory(ctx->device, ctx->stagingInMem);

    // Copy taps to device-local buffer
    VkCommandBufferBeginInfo beginInfo = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO, .flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT };
    vkBeginCommandBuffer(ctx->cmdBuf, &beginInfo);
    VkBufferCopy copyRegion = { .size = tapsSize };
    vkCmdCopyBuffer(ctx->cmdBuf, ctx->stagingIn, ctx->tapsBuf, 1, &copyRegion);
    vkEndCommandBuffer(ctx->cmdBuf);

    VkSubmitInfo submit = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1, .pCommandBuffers = &ctx->cmdBuf };
    vkQueueSubmit(ctx->queue, 1, &submit, ctx->fence);
    vkWaitForFences(ctx->device, 1, &ctx->fence, VK_TRUE, UINT64_MAX);
    vkResetFences(ctx->device, 1, &ctx->fence);
    vkResetCommandBuffer(ctx->cmdBuf, 0);

    return ctx;

fail_pipe:
    vkDestroyPipeline(ctx->device, ctx->pipeline, NULL);
fail_pl:
    vkDestroyPipelineLayout(ctx->device, ctx->pipelineLayout, NULL);
fail_dsl:
    vkDestroyDescriptorSetLayout(ctx->device, ctx->descLayout, NULL);
fail_shader:
    vkDestroyShaderModule(ctx->device, shaderMod, NULL);
fail_pool:
    // Cleanup any allocated resources (simplified — production would track each allocation)
    free(ctx);
    return NULL;
}

int fm_stereo_process(
    FmStereoPipelineCtx* ctx,
    FmClientState* states,
    const float* composite,
    const float* carrier38,
    const float* blends,
    uint32_t numSamples,
    uint32_t numClients,
    uint32_t decimFactor,
    float* outAudio,
    uint32_t* outCounts
) {
    if (!ctx || numClients == 0 || numClients > FM_MAX_CLIENTS || numSamples > FM_MAX_INPUT_SAMPLES) return -1;

    VkDeviceSize perClientInput = numSamples * sizeof(float);
    VkDeviceSize totalInput = (VkDeviceSize)numClients * perClientInput;
    VkDeviceSize statesSize = numClients * sizeof(FmClientState);
    uint32_t maxOutPerClient = numSamples / decimFactor;
    VkDeviceSize audioOutSize = (VkDeviceSize)numClients * maxOutPerClient * 2 * sizeof(float);
    VkDeviceSize countsSize = numClients * sizeof(uint32_t);

    // Upload states
    void* mapped;
    vkMapMemory(ctx->device, ctx->stagingStatesMem, 0, statesSize, 0, &mapped);
    memcpy(mapped, states, statesSize);
    vkUnmapMemory(ctx->device, ctx->stagingStatesMem);

    // Upload inputs (composite + carrier38 + blends) into staging
    vkMapMemory(ctx->device, ctx->stagingInMem, 0, totalInput * 3, 0, &mapped);
    char* ptr = (char*)mapped;
    memcpy(ptr, composite, totalInput);
    memcpy(ptr + totalInput, carrier38, totalInput);
    memcpy(ptr + totalInput * 2, blends, totalInput);
    vkUnmapMemory(ctx->device, ctx->stagingInMem);

    // Record command buffer
    VkCommandBufferBeginInfo beginInfo = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO, .flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT };
    vkBeginCommandBuffer(ctx->cmdBuf, &beginInfo);

    // Copy staging → device buffers
    VkBufferCopy statesCopy = { .size = statesSize };
    vkCmdCopyBuffer(ctx->cmdBuf, ctx->stagingStates, ctx->statesBuf, 1, &statesCopy);

    VkBufferCopy compCopy = { .srcOffset = 0, .size = totalInput };
    vkCmdCopyBuffer(ctx->cmdBuf, ctx->stagingIn, ctx->compositeBuf, 1, &compCopy);

    VkBufferCopy carrCopy = { .srcOffset = totalInput, .size = totalInput };
    vkCmdCopyBuffer(ctx->cmdBuf, ctx->stagingIn, ctx->carrier38Buf, 1, &carrCopy);

    VkBufferCopy blendCopy = { .srcOffset = totalInput * 2, .size = totalInput };
    vkCmdCopyBuffer(ctx->cmdBuf, ctx->stagingIn, ctx->blendsBuf, 1, &blendCopy);

    // Barrier: transfer → compute
    VkMemoryBarrier barrier = {
        .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER,
        .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
        .dstAccessMask = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT,
    };
    vkCmdPipelineBarrier(ctx->cmdBuf,
        VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
        0, 1, &barrier, 0, NULL, 0, NULL);

    // Bind pipeline + descriptor set
    vkCmdBindPipeline(ctx->cmdBuf, VK_PIPELINE_BIND_POINT_COMPUTE, ctx->pipeline);
    vkCmdBindDescriptorSets(ctx->cmdBuf, VK_PIPELINE_BIND_POINT_COMPUTE,
        ctx->pipelineLayout, 0, 1, &ctx->descSet, 0, NULL);

    // Push constants
    FmPushConstants pc = { .numClients = numClients, .numSamples = numSamples, .decimFactor = decimFactor, .numTaps = ctx->numTaps };
    vkCmdPushConstants(ctx->cmdBuf, ctx->pipelineLayout, VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(pc), &pc);

    // Dispatch: one workgroup per client
    vkCmdDispatch(ctx->cmdBuf, numClients, 1, 1);

    // Barrier: compute → transfer
    VkMemoryBarrier barrier2 = {
        .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER,
        .srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT,
        .dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT,
    };
    vkCmdPipelineBarrier(ctx->cmdBuf,
        VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT,
        0, 1, &barrier2, 0, NULL, 0, NULL);

    // Copy results back: states, audio, counts
    vkCmdCopyBuffer(ctx->cmdBuf, ctx->statesBuf, ctx->stagingStates, 1, &statesCopy);

    VkBufferCopy audioCopy = { .size = audioOutSize };
    vkCmdCopyBuffer(ctx->cmdBuf, ctx->audioOutBuf, ctx->stagingOut, 1, &audioCopy);

    VkBufferCopy countsCopy = { .srcOffset = 0, .dstOffset = audioOutSize, .size = countsSize };
    vkCmdCopyBuffer(ctx->cmdBuf, ctx->outCountsBuf, ctx->stagingOut, 1, &countsCopy);

    vkEndCommandBuffer(ctx->cmdBuf);

    // Submit + wait
    VkSubmitInfo submitInfo = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1, .pCommandBuffers = &ctx->cmdBuf };
    VkResult vr = vkQueueSubmit(ctx->queue, 1, &submitInfo, ctx->fence);
    if (vr != VK_SUCCESS) return -2;

    vkWaitForFences(ctx->device, 1, &ctx->fence, VK_TRUE, UINT64_MAX);
    vkResetFences(ctx->device, 1, &ctx->fence);
    vkResetCommandBuffer(ctx->cmdBuf, 0);

    // Read back states
    vkMapMemory(ctx->device, ctx->stagingStatesMem, 0, statesSize, 0, &mapped);
    memcpy(states, mapped, statesSize);
    vkUnmapMemory(ctx->device, ctx->stagingStatesMem);

    // Read back audio + counts
    vkMapMemory(ctx->device, ctx->stagingOutMem, 0, audioOutSize + countsSize, 0, &mapped);
    ptr = (char*)mapped;
    memcpy(outAudio, ptr, audioOutSize);
    memcpy(outCounts, ptr + audioOutSize, countsSize);
    vkUnmapMemory(ctx->device, ctx->stagingOutMem);

    return 0;
}

void fm_stereo_destroy(FmStereoPipelineCtx* ctx) {
    if (!ctx) return;

    vkDeviceWaitIdle(ctx->device);
    vkDestroyFence(ctx->device, ctx->fence, NULL);

    // Destroy buffers
    VkBuffer bufs[] = { ctx->tapsBuf, ctx->statesBuf, ctx->compositeBuf, ctx->carrier38Buf, ctx->blendsBuf, ctx->audioOutBuf, ctx->outCountsBuf, ctx->stagingIn, ctx->stagingStates, ctx->stagingOut };
    VkDeviceMemory mems[] = { ctx->tapsMem, ctx->statesMem, ctx->compositeMem, ctx->carrier38Mem, ctx->blendsMem, ctx->audioOutMem, ctx->outCountsMem, ctx->stagingInMem, ctx->stagingStatesMem, ctx->stagingOutMem };
    for (int i = 0; i < 10; i++) {
        if (bufs[i]) vkDestroyBuffer(ctx->device, bufs[i], NULL);
        if (mems[i]) vkFreeMemory(ctx->device, mems[i], NULL);
    }

    vkDestroyPipeline(ctx->device, ctx->pipeline, NULL);
    vkDestroyPipelineLayout(ctx->device, ctx->pipelineLayout, NULL);
    vkDestroyDescriptorPool(ctx->device, ctx->descPool, NULL);
    vkDestroyDescriptorSetLayout(ctx->device, ctx->descLayout, NULL);

    free(ctx);
}
