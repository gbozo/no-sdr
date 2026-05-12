// IQ Pipeline GPU Compute — C wrapper for Vulkan compute shader dispatch
//
// Creates a Vulkan compute pipeline, allocates SSBOs, and dispatches the
// iq_pipeline.comp shader for batched multi-client IQ processing.

#include "iq_pipeline.h"
#include "vulkan_device.h"

#include <stdlib.h>
#include <string.h>
#include <stdio.h>

// Inline GLSL source — compiled at runtime via glslang
static const char* kIqPipelineGLSL =
#include "iq_pipeline_glsl.inc"
;

// Forward declaration
static uint32_t* compile_iq_glsl(const char* src, uint32_t* outSize);

// ─── Pipeline Context ───────────────────────────────────────────────────────

struct IqPipelineCtx {
    VkDevice device;
    VkPhysicalDevice physicalDevice;
    VkQueue computeQueue;
    VkCommandPool commandPool;

    // Shader module + pipeline
    VkShaderModule shaderModule;
    VkDescriptorSetLayout descSetLayout;
    VkPipelineLayout pipelineLayout;
    VkPipeline pipeline;
    VkDescriptorPool descPool;
    VkDescriptorSet descSet;

    // Buffers
    VkBuffer paramsBuf;       // SSBO 0: ClientParams (read-write)
    VkDeviceMemory paramsMem;
    VkBuffer inputBuf;        // SSBO 1: raw IQ input (read-only, staging)
    VkDeviceMemory inputMem;
    VkBuffer outputBuf;       // SSBO 2: int16 output (write-only)
    VkDeviceMemory outputMem;
    VkBuffer metaBuf;         // SSBO 3: output counts
    VkDeviceMemory metaMem;

    // Host-visible staging for download
    VkBuffer outputStagingBuf;
    VkDeviceMemory outputStagingMem;
    VkBuffer metaStagingBuf;
    VkDeviceMemory metaStagingMem;

    // Synchronization
    VkCommandBuffer cmdBuf;
    VkFence fence;

    // Sizes
    uint32_t paramsBufSize;
    uint32_t inputBufSize;
    uint32_t outputBufSize;
    uint32_t metaBufSize;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

static uint32_t iq_findMemoryType(VkPhysicalDevice physDev, uint32_t typeBits, VkMemoryPropertyFlags props) {
    VkPhysicalDeviceMemoryProperties memProps;
    vkGetPhysicalDeviceMemoryProperties(physDev, &memProps);
    for (uint32_t i = 0; i < memProps.memoryTypeCount; i++) {
        if ((typeBits & (1u << i)) && (memProps.memoryTypes[i].propertyFlags & props) == props) {
            return i;
        }
    }
    return UINT32_MAX;
}

static int createBuffer(VkDevice dev, VkPhysicalDevice physDev, VkDeviceSize size,
                        VkBufferUsageFlags usage, VkMemoryPropertyFlags memProps,
                        VkBuffer* buf, VkDeviceMemory* mem) {
    VkBufferCreateInfo bufCI = {
        .sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO,
        .size = size,
        .usage = usage,
        .sharingMode = VK_SHARING_MODE_EXCLUSIVE,
    };
    if (vkCreateBuffer(dev, &bufCI, NULL, buf) != VK_SUCCESS) return -1;

    VkMemoryRequirements memReq;
    vkGetBufferMemoryRequirements(dev, *buf, &memReq);

    uint32_t memIdx = iq_findMemoryType(physDev, memReq.memoryTypeBits, memProps);
    if (memIdx == UINT32_MAX) return -2;

    VkMemoryAllocateInfo allocInfo = {
        .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
        .allocationSize = memReq.size,
        .memoryTypeIndex = memIdx,
    };
    if (vkAllocateMemory(dev, &allocInfo, NULL, mem) != VK_SUCCESS) return -3;
    if (vkBindBufferMemory(dev, *buf, *mem, 0) != VK_SUCCESS) return -4;
    return 0;
}

// ─── GLSL Compilation ───────────────────────────────────────────────────────

#include <glslang_c_interface.h>
#include <glslang/Public/resource_limits_c.h>

static uint32_t* compile_iq_glsl(const char* src, uint32_t* outSize) {
    glslang_initialize_process();

    glslang_input_t input = {
        .language = GLSLANG_SOURCE_GLSL,
        .stage = GLSLANG_STAGE_COMPUTE,
        .client = GLSLANG_CLIENT_VULKAN,
        .client_version = GLSLANG_TARGET_VULKAN_1_1,
        .target_language = GLSLANG_TARGET_SPV,
        .target_language_version = GLSLANG_TARGET_SPV_1_3,
        .code = src,
        .default_version = 450,
        .default_profile = GLSLANG_NO_PROFILE,
        .resource = glslang_default_resource(),
    };

    glslang_shader_t* shader = glslang_shader_create(&input);
    if (!glslang_shader_preprocess(shader, &input)) {
        fprintf(stderr, "iq_pipeline: glslang preprocess failed: %s\n", glslang_shader_get_info_log(shader));
        glslang_shader_delete(shader);
        glslang_finalize_process();
        return NULL;
    }
    if (!glslang_shader_parse(shader, &input)) {
        fprintf(stderr, "iq_pipeline: glslang parse failed: %s\n", glslang_shader_get_info_log(shader));
        glslang_shader_delete(shader);
        glslang_finalize_process();
        return NULL;
    }

    glslang_program_t* program = glslang_program_create();
    glslang_program_add_shader(program, shader);
    if (!glslang_program_link(program, GLSLANG_MSG_SPV_RULES_BIT | GLSLANG_MSG_VULKAN_RULES_BIT)) {
        fprintf(stderr, "iq_pipeline: glslang link failed: %s\n", glslang_program_get_info_log(program));
        glslang_program_delete(program);
        glslang_shader_delete(shader);
        glslang_finalize_process();
        return NULL;
    }

    glslang_program_SPIRV_generate(program, GLSLANG_STAGE_COMPUTE);
    size_t spirvSize = glslang_program_SPIRV_get_size(program);
    uint32_t* spirv = (uint32_t*)malloc(spirvSize * sizeof(uint32_t));
    glslang_program_SPIRV_get(program, spirv);
    *outSize = (uint32_t)(spirvSize * sizeof(uint32_t));

    glslang_program_delete(program);
    glslang_shader_delete(shader);
    glslang_finalize_process();
    return spirv;
}

// ─── Create ─────────────────────────────────────────────────────────────────

IqPipelineCtx* iq_pipeline_create(void* devPtr) {
    VkDeviceContext* dev = (VkDeviceContext*)devPtr;
    IqPipelineCtx* ctx = (IqPipelineCtx*)calloc(1, sizeof(IqPipelineCtx));
    if (!ctx) return NULL;

    ctx->device = dev->device;
    ctx->physicalDevice = dev->physicalDevice;
    ctx->computeQueue = dev->computeQueue;
    ctx->commandPool = dev->commandPool;

    // ── Compile shader ──
    uint32_t spirvSize = 0;
    uint32_t* spirv = compile_iq_glsl(kIqPipelineGLSL, &spirvSize);
    if (!spirv) { free(ctx); return NULL; }

    VkShaderModuleCreateInfo smCI = {
        .sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO,
        .codeSize = spirvSize,
        .pCode = spirv,
    };
    if (vkCreateShaderModule(ctx->device, &smCI, NULL, &ctx->shaderModule) != VK_SUCCESS) {
        free(spirv); free(ctx); return NULL;
    }
    free(spirv);

    // ── Descriptor set layout (4 SSBOs) ──
    VkDescriptorSetLayoutBinding bindings[4] = {
        {0, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL},
        {1, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL},
        {2, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL},
        {3, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL},
    };
    VkDescriptorSetLayoutCreateInfo dslCI = {
        .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
        .bindingCount = 4,
        .pBindings = bindings,
    };
    if (vkCreateDescriptorSetLayout(ctx->device, &dslCI, NULL, &ctx->descSetLayout) != VK_SUCCESS) {
        goto fail;
    }

    // ── Push constant range ──
    VkPushConstantRange pcRange = {
        .stageFlags = VK_SHADER_STAGE_COMPUTE_BIT,
        .offset = 0,
        .size = sizeof(IqPushConstants),
    };
    VkPipelineLayoutCreateInfo plCI = {
        .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
        .setLayoutCount = 1,
        .pSetLayouts = &ctx->descSetLayout,
        .pushConstantRangeCount = 1,
        .pPushConstantRanges = &pcRange,
    };
    if (vkCreatePipelineLayout(ctx->device, &plCI, NULL, &ctx->pipelineLayout) != VK_SUCCESS) {
        goto fail;
    }

    // ── Compute pipeline ──
    VkComputePipelineCreateInfo cpCI = {
        .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
        .stage = {
            .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
            .stage = VK_SHADER_STAGE_COMPUTE_BIT,
            .module = ctx->shaderModule,
            .pName = "main",
        },
        .layout = ctx->pipelineLayout,
    };
    if (vkCreateComputePipelines(ctx->device, VK_NULL_HANDLE, 1, &cpCI, NULL, &ctx->pipeline) != VK_SUCCESS) {
        goto fail;
    }

    // ── Allocate SSBOs ──
    ctx->paramsBufSize = IQ_MAX_CLIENTS * sizeof(IqClientParams);
    ctx->inputBufSize = IQ_MAX_INPUT_SAMPLES * 2;  // uint8 interleaved I,Q
    ctx->outputBufSize = IQ_MAX_CLIENTS * (IQ_MAX_INPUT_SAMPLES / 1) * 4;  // worst case: no decimation, 4 bytes per sample pair
    ctx->metaBufSize = IQ_MAX_CLIENTS * sizeof(uint32_t);

    // Params buffer: host-visible (read-write from both sides)
    if (createBuffer(ctx->device, ctx->physicalDevice, ctx->paramsBufSize,
            VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT,
            VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT,
            &ctx->paramsBuf, &ctx->paramsMem) != 0) goto fail;

    // Input buffer: host-visible (CPU writes each frame)
    if (createBuffer(ctx->device, ctx->physicalDevice, ctx->inputBufSize,
            VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT,
            VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT,
            &ctx->inputBuf, &ctx->inputMem) != 0) goto fail;

    // Output buffer: device-local
    if (createBuffer(ctx->device, ctx->physicalDevice, ctx->outputBufSize,
            VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT,
            VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT,
            &ctx->outputBuf, &ctx->outputMem) != 0) {
        // Fallback: host-visible if device-local fails (integrated GPU)
        if (createBuffer(ctx->device, ctx->physicalDevice, ctx->outputBufSize,
                VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT,
                VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT,
                &ctx->outputBuf, &ctx->outputMem) != 0) goto fail;
    }

    // Output staging: host-visible for readback
    if (createBuffer(ctx->device, ctx->physicalDevice, ctx->outputBufSize,
            VK_BUFFER_USAGE_TRANSFER_DST_BIT,
            VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT,
            &ctx->outputStagingBuf, &ctx->outputStagingMem) != 0) goto fail;

    // Meta buffer: device-local
    if (createBuffer(ctx->device, ctx->physicalDevice, ctx->metaBufSize,
            VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT,
            VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT,
            &ctx->metaBuf, &ctx->metaMem) != 0) {
        if (createBuffer(ctx->device, ctx->physicalDevice, ctx->metaBufSize,
                VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT,
                VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT,
                &ctx->metaBuf, &ctx->metaMem) != 0) goto fail;
    }

    // Meta staging
    if (createBuffer(ctx->device, ctx->physicalDevice, ctx->metaBufSize,
            VK_BUFFER_USAGE_TRANSFER_DST_BIT,
            VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT,
            &ctx->metaStagingBuf, &ctx->metaStagingMem) != 0) goto fail;

    // ── Descriptor pool + set ──
    VkDescriptorPoolSize poolSize = {VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 4};
    VkDescriptorPoolCreateInfo dpCI = {
        .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO,
        .maxSets = 1,
        .poolSizeCount = 1,
        .pPoolSizes = &poolSize,
    };
    if (vkCreateDescriptorPool(ctx->device, &dpCI, NULL, &ctx->descPool) != VK_SUCCESS) goto fail;

    VkDescriptorSetAllocateInfo dsAI = {
        .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
        .descriptorPool = ctx->descPool,
        .descriptorSetCount = 1,
        .pSetLayouts = &ctx->descSetLayout,
    };
    if (vkAllocateDescriptorSets(ctx->device, &dsAI, &ctx->descSet) != VK_SUCCESS) goto fail;

    // Write descriptor bindings
    VkDescriptorBufferInfo bufInfos[4] = {
        {ctx->paramsBuf, 0, ctx->paramsBufSize},
        {ctx->inputBuf, 0, ctx->inputBufSize},
        {ctx->outputBuf, 0, ctx->outputBufSize},
        {ctx->metaBuf, 0, ctx->metaBufSize},
    };
    VkWriteDescriptorSet writes[4];
    for (int i = 0; i < 4; i++) {
        writes[i] = (VkWriteDescriptorSet){
            .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET,
            .dstSet = ctx->descSet,
            .dstBinding = (uint32_t)i,
            .descriptorCount = 1,
            .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
            .pBufferInfo = &bufInfos[i],
        };
    }
    vkUpdateDescriptorSets(ctx->device, 4, writes, 0, NULL);

    // ── Command buffer + fence ──
    VkCommandBufferAllocateInfo cbAI = {
        .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
        .commandPool = ctx->commandPool,
        .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY,
        .commandBufferCount = 1,
    };
    if (vkAllocateCommandBuffers(ctx->device, &cbAI, &ctx->cmdBuf) != VK_SUCCESS) goto fail;

    VkFenceCreateInfo fCI = {.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
    if (vkCreateFence(ctx->device, &fCI, NULL, &ctx->fence) != VK_SUCCESS) goto fail;

    return ctx;

fail:
    iq_pipeline_destroy(ctx);
    return NULL;
}

// ─── Process ────────────────────────────────────────────────────────────────

int iq_pipeline_process(
    IqPipelineCtx* ctx,
    IqClientParams* params,
    const uint8_t* rawIQ,
    uint32_t inputSamples,
    uint32_t numClients,
    int16_t* outBuf,
    uint32_t* outCounts
) {
    if (!ctx || !params || !rawIQ || numClients == 0) return -1;
    if (numClients > IQ_MAX_CLIENTS) return -2;
    if (inputSamples > IQ_MAX_INPUT_SAMPLES) return -3;

    // ── Upload params ──
    void* mapped = NULL;
    uint32_t paramsSize = numClients * sizeof(IqClientParams);
    vkMapMemory(ctx->device, ctx->paramsMem, 0, paramsSize, 0, &mapped);
    memcpy(mapped, params, paramsSize);
    vkUnmapMemory(ctx->device, ctx->paramsMem);

    // ── Upload input IQ ──
    uint32_t iqSize = inputSamples * 2;
    vkMapMemory(ctx->device, ctx->inputMem, 0, iqSize, 0, &mapped);
    memcpy(mapped, rawIQ, iqSize);
    vkUnmapMemory(ctx->device, ctx->inputMem);

    // ── Record command buffer ──
    vkResetCommandBuffer(ctx->cmdBuf, 0);
    VkCommandBufferBeginInfo beginInfo = {
        .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO,
        .flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT,
    };
    vkBeginCommandBuffer(ctx->cmdBuf, &beginInfo);

    vkCmdBindPipeline(ctx->cmdBuf, VK_PIPELINE_BIND_POINT_COMPUTE, ctx->pipeline);
    vkCmdBindDescriptorSets(ctx->cmdBuf, VK_PIPELINE_BIND_POINT_COMPUTE,
        ctx->pipelineLayout, 0, 1, &ctx->descSet, 0, NULL);

    IqPushConstants pc = { .numClients = numClients, .inputSamples = inputSamples };
    vkCmdPushConstants(ctx->cmdBuf, ctx->pipelineLayout, VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(pc), &pc);

    // Dispatch: one thread per client
    vkCmdDispatch(ctx->cmdBuf, numClients, 1, 1);

    // Memory barrier: shader writes → transfer reads
    VkMemoryBarrier barrier = {
        .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER,
        .srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT,
        .dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT,
    };
    vkCmdPipelineBarrier(ctx->cmdBuf,
        VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT,
        0, 1, &barrier, 0, NULL, 0, NULL);

    // Copy output SSBO → staging for host readback
    uint32_t maxOutPerClient = inputSamples;  // worst case (decimFactor=1)
    uint32_t totalOutSize = numClients * maxOutPerClient * 4;  // int32 per sample pair
    VkBufferCopy outCopy = {0, 0, totalOutSize};
    vkCmdCopyBuffer(ctx->cmdBuf, ctx->outputBuf, ctx->outputStagingBuf, 1, &outCopy);

    // Copy meta → staging
    uint32_t metaSize = numClients * sizeof(uint32_t);
    VkBufferCopy metaCopy = {0, 0, metaSize};
    vkCmdCopyBuffer(ctx->cmdBuf, ctx->metaBuf, ctx->metaStagingBuf, 1, &metaCopy);

    vkEndCommandBuffer(ctx->cmdBuf);

    // ── Submit + wait ──
    vkResetFences(ctx->device, 1, &ctx->fence);
    VkSubmitInfo submitInfo = {
        .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO,
        .commandBufferCount = 1,
        .pCommandBuffers = &ctx->cmdBuf,
    };
    if (vkQueueSubmit(ctx->computeQueue, 1, &submitInfo, ctx->fence) != VK_SUCCESS) return -4;
    vkWaitForFences(ctx->device, 1, &ctx->fence, VK_TRUE, UINT64_MAX);

    // ── Read back params (state updated by shader) ──
    vkMapMemory(ctx->device, ctx->paramsMem, 0, paramsSize, 0, &mapped);
    memcpy(params, mapped, paramsSize);
    vkUnmapMemory(ctx->device, ctx->paramsMem);

    // ── Read back output counts ──
    vkMapMemory(ctx->device, ctx->metaStagingMem, 0, metaSize, 0, &mapped);
    memcpy(outCounts, mapped, metaSize);
    vkUnmapMemory(ctx->device, ctx->metaStagingMem);

    // ── Read back output data ──
    // Only read back what each client actually produced
    vkMapMemory(ctx->device, ctx->outputStagingMem, 0, totalOutSize, 0, &mapped);
    uint32_t maxOutSamples = inputSamples;  // per-client slot size in output buffer
    for (uint32_t c = 0; c < numClients; c++) {
        uint32_t count = outCounts[c];
        if (count > 0) {
            // Source: client's slot in the staging buffer (packed int32)
            const int32_t* src = (const int32_t*)mapped + c * maxOutSamples;
            // Dest: caller's output buffer, interleaved I,Q int16
            int16_t* dst = outBuf + c * maxOutSamples * 2;
            for (uint32_t s = 0; s < count; s++) {
                int32_t packed = src[s];
                dst[s * 2]     = (int16_t)(packed & 0xFFFF);       // I
                dst[s * 2 + 1] = (int16_t)((packed >> 16) & 0xFFFF); // Q
            }
        }
    }
    vkUnmapMemory(ctx->device, ctx->outputStagingMem);

    return 0;
}

// ─── Destroy ────────────────────────────────────────────────────────────────

void iq_pipeline_destroy(IqPipelineCtx* ctx) {
    if (!ctx) return;
    VkDevice dev = ctx->device;
    if (!dev) { free(ctx); return; }

    vkDeviceWaitIdle(dev);

    if (ctx->fence) vkDestroyFence(dev, ctx->fence, NULL);
    if (ctx->cmdBuf) vkFreeCommandBuffers(dev, ctx->commandPool, 1, &ctx->cmdBuf);
    if (ctx->descPool) vkDestroyDescriptorPool(dev, ctx->descPool, NULL);
    if (ctx->pipeline) vkDestroyPipeline(dev, ctx->pipeline, NULL);
    if (ctx->pipelineLayout) vkDestroyPipelineLayout(dev, ctx->pipelineLayout, NULL);
    if (ctx->descSetLayout) vkDestroyDescriptorSetLayout(dev, ctx->descSetLayout, NULL);
    if (ctx->shaderModule) vkDestroyShaderModule(dev, ctx->shaderModule, NULL);

    // Free buffers
    if (ctx->paramsBuf) vkDestroyBuffer(dev, ctx->paramsBuf, NULL);
    if (ctx->paramsMem) vkFreeMemory(dev, ctx->paramsMem, NULL);
    if (ctx->inputBuf) vkDestroyBuffer(dev, ctx->inputBuf, NULL);
    if (ctx->inputMem) vkFreeMemory(dev, ctx->inputMem, NULL);
    if (ctx->outputBuf) vkDestroyBuffer(dev, ctx->outputBuf, NULL);
    if (ctx->outputMem) vkFreeMemory(dev, ctx->outputMem, NULL);
    if (ctx->metaBuf) vkDestroyBuffer(dev, ctx->metaBuf, NULL);
    if (ctx->metaMem) vkFreeMemory(dev, ctx->metaMem, NULL);
    if (ctx->outputStagingBuf) vkDestroyBuffer(dev, ctx->outputStagingBuf, NULL);
    if (ctx->outputStagingMem) vkFreeMemory(dev, ctx->outputStagingMem, NULL);
    if (ctx->metaStagingBuf) vkDestroyBuffer(dev, ctx->metaStagingBuf, NULL);
    if (ctx->metaStagingMem) vkFreeMemory(dev, ctx->metaStagingMem, NULL);

    free(ctx);
}
