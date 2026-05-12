/*
 * vkfft_wrapper.c — GPU FFT implementation using VkFFT
 *
 * Pipeline:
 *   1. Host→GPU: upload raw uint8 IQ (fftSize*2 bytes) via staging buffer
 *   2. GPU preprocessing shader: uint8→cfloat32 + Hann window
 *   3. VkFFT C2C forward FFT (in-place on float32 complex SSBO)
 *   4. GPU→Host: download float32 complex spectrum (fftSize * 8 bytes)
 *   5. CPU: magnitude + 10*log10 → dB[] (fftSize/2 bins)
 *
 * All persistent Vulkan objects (buffers, memory, descriptors, command buffers)
 * are allocated once in vk_fft_create and reused across frames.
 */

#define VKFFT_BACKEND 0  /* Vulkan backend */
#include "vulkan_probe.h"    /* device_type_priority, for portability */
#include "vulkan_device.h"
#include "vkfft_wrapper.h"

#ifdef __APPLE__
#define VK_ENABLE_BETA_EXTENSIONS
#endif

#include <vulkan/vulkan.h>

/*
 * VkFFT requires glslang for runtime SPIR-V compilation.
 * Include the SDK's glslang C interface header.
 */
#include "glslang_c_interface.h"
#include "glslang/Public/resource_limits_c.h"

/* Define VKFFT_STATIC to avoid linking issues with header-only lib */
#define VKFFT_STATIC
#include "vkFFT/vkFFT.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

/* ── SPIR-V preprocessing shader (GLSL 450) ──────────────────────────────── */
/*
 * Converts uint8 IQ to float32 complex with Hann window applied.
 * Input:  binding 0 = uint8[] (fftSize*2 packed bytes)
 * Output: binding 1 = vec2[]  (fftSize complex float32 samples)
 *
 * The uint8 IQ range [0,255] is normalized to [-1.0, 1.0] by subtracting 127.5
 * and dividing by 127.5 — standard RTL-SDR uint8 mapping.
 */
/*
 * Preprocessing shader: uint8 IQ → float32 complex + Hann window.
 *
 * The IQ data is stored as a uint[] buffer (4 bytes per element).
 * We extract individual bytes using bit-shifts to avoid requiring
 * GL_EXT_shader_explicit_arithmetic_types_int8 / VK_KHR_shader_8bit_storage.
 *
 * RTL-SDR uint8 IQ: value range [0,255], bias 127.5 → [-1, +1] float.
 * Hann window: w[n] = 0.5 * (1 − cos(2π·n / N))
 */
static const char *kPreprocessGLSL =
    "#version 450\n"
    "layout(local_size_x = 256) in;\n"
    /* IQ buffer: packed uint8 pairs stored as uint32 words.
     * Word at index w contains bytes: [w*4], [w*4+1], [w*4+2], [w*4+3] */
    "layout(binding = 0, std430) readonly buffer IQ { uint iq_words[]; };\n"
    "layout(binding = 1, std430) writeonly buffer Spectrum { vec2 spectrum[]; };\n"
    "layout(push_constant) uniform PC { uint fftSize; } pc;\n"
    "\n"
    "uint extract_byte(uint byteIndex) {\n"
    "    uint wordIndex = byteIndex >> 2u;\n"              /* byteIndex / 4 */
    "    uint shift     = (byteIndex & 3u) << 3u;\n"       /* (byteIndex % 4) * 8 */
    "    return (iq_words[wordIndex] >> shift) & 0xFFu;\n"
    "}\n"
    "\n"
    "void main() {\n"
    "    uint idx = gl_GlobalInvocationID.x;\n"
    "    if (idx >= pc.fftSize) return;\n"
    "    float fi = (float(extract_byte(idx * 2u))     - 127.5) / 127.5;\n"
    "    float fq = (float(extract_byte(idx * 2u + 1u)) - 127.5) / 127.5;\n"
    "    float n = float(idx);\n"
    "    float N = float(pc.fftSize);\n"
    "    float w = 0.5 * (1.0 - cos(6.283185307 * n / N));\n"
    "    spectrum[idx] = vec2(fi * w, fq * w);\n"
    "}\n";

/* ── Helper: find memory type ─────────────────────────────────────────────── */
static int find_memory_type(VkPhysicalDevice pdev,
                            uint32_t typeBits,
                            VkMemoryPropertyFlags props,
                            uint32_t *outTypeIndex)
{
    VkPhysicalDeviceMemoryProperties mp;
    vkGetPhysicalDeviceMemoryProperties(pdev, &mp);
    for (uint32_t i = 0; i < mp.memoryTypeCount; i++) {
        if ((typeBits & (1u << i)) &&
            (mp.memoryTypes[i].propertyFlags & props) == props) {
            *outTypeIndex = i;
            return 0;
        }
    }
    return -1;
}

/* ── Helper: create a buffer + allocate memory ───────────────────────────── */
static int create_buffer(VkDeviceContext *dev,
                         VkDeviceSize size,
                         VkBufferUsageFlags usage,
                         VkMemoryPropertyFlags memProps,
                         VkBuffer *outBuf,
                         VkDeviceMemory *outMem)
{
    VkBufferCreateInfo bci = {
        .sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO,
        .size  = size,
        .usage = usage,
        .sharingMode = VK_SHARING_MODE_EXCLUSIVE,
    };
    if (vkCreateBuffer(dev->device, &bci, NULL, outBuf) != VK_SUCCESS)
        return -1;

    VkMemoryRequirements mr;
    vkGetBufferMemoryRequirements(dev->device, *outBuf, &mr);

    uint32_t memType;
    if (find_memory_type(dev->physicalDevice, mr.memoryTypeBits, memProps, &memType) != 0) {
        vkDestroyBuffer(dev->device, *outBuf, NULL);
        return -2;
    }

    VkMemoryAllocateInfo ai = {
        .sType           = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
        .allocationSize  = mr.size,
        .memoryTypeIndex = memType,
    };
    if (vkAllocateMemory(dev->device, &ai, NULL, outMem) != VK_SUCCESS) {
        vkDestroyBuffer(dev->device, *outBuf, NULL);
        return -3;
    }
    vkBindBufferMemory(dev->device, *outBuf, *outMem, 0);
    return 0;
}

/* ── Helper: compile GLSL → SPIR-V via glslang C interface ───────────────── */
static uint32_t *compile_glsl_to_spirv(const char *glsl, size_t *outWords) {
    glslang_initialize_process();

    glslang_input_t input = {
        .language                          = GLSLANG_SOURCE_GLSL,
        .stage                             = GLSLANG_STAGE_COMPUTE,
        .client                            = GLSLANG_CLIENT_VULKAN,
        .client_version                    = GLSLANG_TARGET_VULKAN_1_2,
        .target_language                   = GLSLANG_TARGET_SPV,
        .target_language_version           = GLSLANG_TARGET_SPV_1_5,
        .code                              = glsl,
        .default_version                   = 450,
        .default_profile                   = GLSLANG_CORE_PROFILE,
        .force_default_version_and_profile = 0,
        .forward_compatible                = 0,
        .messages                          = GLSLANG_MSG_DEFAULT_BIT,
        .resource                          = glslang_default_resource(),
    };

    glslang_shader_t *shader = glslang_shader_create(&input);
    if (!glslang_shader_preprocess(shader, &input) ||
        !glslang_shader_parse(shader, &input)) {
        fprintf(stderr, "vkfft_wrapper: GLSL preprocess/parse error: %s\n",
                glslang_shader_get_info_log(shader));
        glslang_shader_delete(shader);
        return NULL;
    }

    glslang_program_t *program = glslang_program_create();
    glslang_program_add_shader(program, shader);
    if (!glslang_program_link(program, GLSLANG_MSG_SPV_RULES_BIT | GLSLANG_MSG_VULKAN_RULES_BIT)) {
        fprintf(stderr, "vkfft_wrapper: GLSL link error: %s\n",
                glslang_program_get_info_log(program));
        glslang_program_delete(program);
        glslang_shader_delete(shader);
        return NULL;
    }
    glslang_program_SPIRV_generate(program, GLSLANG_STAGE_COMPUTE);

    size_t nwords = glslang_program_SPIRV_get_size(program);
    uint32_t *spirv = (uint32_t *)malloc(nwords * sizeof(uint32_t));
    if (spirv) {
        glslang_program_SPIRV_get(program, spirv);
        *outWords = nwords;
    }

    glslang_program_delete(program);
    glslang_shader_delete(shader);
    return spirv;
}

/* ── VkFftContext definition ─────────────────────────────────────────────── */
struct VkFftContext {
    VkDeviceContext *dev;
    uint32_t         fftSize;

    /* Staging buffer (CPU-visible, used for IQ upload + spectrum download) */
    VkBuffer       stagingBuf;
    VkDeviceMemory stagingMem;
    VkDeviceSize   stagingSize;

    /* IQ byte buffer (GPU-local, input to preprocess shader) */
    VkBuffer       iqBuf;
    VkDeviceMemory iqMem;

    /* Spectrum complex float32 buffer (GPU-local, VkFFT in/out) */
    VkBuffer       specBuf;
    VkDeviceMemory specMem;
    VkDeviceSize   specBufSize; /* stored here so VkFFT can keep a persistent pointer */

    /* Download buffer (CPU-visible, spectrum readback) */
    VkBuffer       dlBuf;
    VkDeviceMemory dlMem;

    /* Preprocessing compute pipeline */
    VkShaderModule        preprocModule;
    VkDescriptorSetLayout preprocDSL;
    VkDescriptorPool      preprocPool;
    VkDescriptorSet       preprocDS;
    VkPipelineLayout      preprocLayout;
    VkPipeline            preprocPipeline;

    /* VkFFT application — must outlive any VkFFTAppend calls */
    VkFFTApplication vkfftApp;
    VkFFTConfiguration vkfftCfg; /* stored in ctx so pointer fields remain valid */
    int              vkfftReady;

    /* Command buffer for the full pipeline */
    VkCommandBuffer cmdBuf;
    VkFence         fence;
};

/* ── vk_fft_create ───────────────────────────────────────────────────────── */
VkFftContext *vk_fft_create(VkDeviceContext *dev, uint32_t fftSize) {
    VkFftContext *ctx = (VkFftContext *)calloc(1, sizeof(VkFftContext));
    if (!ctx) return NULL;
    ctx->dev     = dev;
    ctx->fftSize = fftSize;

    VkDevice    d = dev->device;
    VkDeviceSize iqBytes   = (VkDeviceSize)fftSize * 2;         /* uint8 IQ */
    VkDeviceSize specBytes = (VkDeviceSize)fftSize * 8;         /* 2× float32 per bin */
    ctx->stagingSize = iqBytes > specBytes ? iqBytes : specBytes;

    /* ── Staging buffer (host coherent) ── */
    if (create_buffer(dev, ctx->stagingSize,
                      VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT,
                      VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT,
                      &ctx->stagingBuf, &ctx->stagingMem) != 0)
        goto fail;

    /* ── IQ buffer (device local, transfer dst + storage) ── */
    if (create_buffer(dev, iqBytes,
                      VK_BUFFER_USAGE_TRANSFER_DST_BIT | VK_BUFFER_USAGE_STORAGE_BUFFER_BIT,
                      VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT,
                      &ctx->iqBuf, &ctx->iqMem) != 0)
        goto fail;

    /* ── Spectrum buffer (device local, storage + transfer src) ── */
    if (create_buffer(dev, specBytes,
                      VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT,
                      VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT,
                      &ctx->specBuf, &ctx->specMem) != 0)
        goto fail;

    /* On unified memory (Apple M-series), use HOST_VISIBLE for download buf */
    if (create_buffer(dev, specBytes,
                      VK_BUFFER_USAGE_TRANSFER_DST_BIT,
                      VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT,
                      &ctx->dlBuf, &ctx->dlMem) != 0)
        goto fail;

    /* ── Preprocessing shader ── */
    size_t nwords = 0;
    uint32_t *spirv = compile_glsl_to_spirv(kPreprocessGLSL, &nwords);
    if (!spirv) goto fail;

    VkShaderModuleCreateInfo smci = {
        .sType    = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO,
        .codeSize = nwords * sizeof(uint32_t),
        .pCode    = spirv,
    };
    VkResult r = vkCreateShaderModule(d, &smci, NULL, &ctx->preprocModule);
    free(spirv);
    if (r != VK_SUCCESS) goto fail;

    /* Descriptor set layout: binding 0 = IQ (storage), binding 1 = Spectrum (storage) */
    VkDescriptorSetLayoutBinding bindings[2] = {
        { .binding=0, .descriptorType=VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
          .descriptorCount=1, .stageFlags=VK_SHADER_STAGE_COMPUTE_BIT },
        { .binding=1, .descriptorType=VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
          .descriptorCount=1, .stageFlags=VK_SHADER_STAGE_COMPUTE_BIT },
    };
    VkDescriptorSetLayoutCreateInfo dslci = {
        .sType        = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
        .bindingCount = 2,
        .pBindings    = bindings,
    };
    if (vkCreateDescriptorSetLayout(d, &dslci, NULL, &ctx->preprocDSL) != VK_SUCCESS)
        goto fail;

    VkDescriptorPoolSize poolSize = {
        .type            = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
        .descriptorCount = 2,
    };
    VkDescriptorPoolCreateInfo dpci = {
        .sType         = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO,
        .maxSets       = 1,
        .poolSizeCount = 1,
        .pPoolSizes    = &poolSize,
    };
    if (vkCreateDescriptorPool(d, &dpci, NULL, &ctx->preprocPool) != VK_SUCCESS)
        goto fail;

    VkDescriptorSetAllocateInfo dsai = {
        .sType              = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
        .descriptorPool     = ctx->preprocPool,
        .descriptorSetCount = 1,
        .pSetLayouts        = &ctx->preprocDSL,
    };
    if (vkAllocateDescriptorSets(d, &dsai, &ctx->preprocDS) != VK_SUCCESS)
        goto fail;

    /* Update descriptors */
    VkDescriptorBufferInfo iqBI   = { .buffer=ctx->iqBuf,   .offset=0, .range=VK_WHOLE_SIZE };
    VkDescriptorBufferInfo specBI = { .buffer=ctx->specBuf, .offset=0, .range=VK_WHOLE_SIZE };
    VkWriteDescriptorSet writes[2] = {
        { .sType=VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet=ctx->preprocDS,
          .dstBinding=0, .descriptorCount=1, .descriptorType=VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
          .pBufferInfo=&iqBI },
        { .sType=VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet=ctx->preprocDS,
          .dstBinding=1, .descriptorCount=1, .descriptorType=VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
          .pBufferInfo=&specBI },
    };
    vkUpdateDescriptorSets(d, 2, writes, 0, NULL);

    /* Push constant: fftSize (uint32) */
    VkPushConstantRange pcRange = {
        .stageFlags = VK_SHADER_STAGE_COMPUTE_BIT,
        .offset     = 0,
        .size       = sizeof(uint32_t),
    };
    VkPipelineLayoutCreateInfo plci = {
        .sType                  = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
        .setLayoutCount         = 1,
        .pSetLayouts            = &ctx->preprocDSL,
        .pushConstantRangeCount = 1,
        .pPushConstantRanges    = &pcRange,
    };
    if (vkCreatePipelineLayout(d, &plci, NULL, &ctx->preprocLayout) != VK_SUCCESS)
        goto fail;

    VkComputePipelineCreateInfo cpci = {
        .sType  = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
        .stage  = {
            .sType  = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
            .stage  = VK_SHADER_STAGE_COMPUTE_BIT,
            .module = ctx->preprocModule,
            .pName  = "main",
        },
        .layout = ctx->preprocLayout,
    };
    if (vkCreateComputePipelines(d, VK_NULL_HANDLE, 1, &cpci, NULL, &ctx->preprocPipeline) != VK_SUCCESS)
        goto fail;

    /* ── VkFFT application ── */
    VkFFTConfiguration *vkfftCfg = &ctx->vkfftCfg;
    memset(vkfftCfg, 0, sizeof(*vkfftCfg));
    vkfftCfg->FFTdim              = 1;
    vkfftCfg->size[0]             = fftSize;
    vkfftCfg->numberBatches       = 1;
    vkfftCfg->device              = &dev->device;
    vkfftCfg->queue               = &dev->computeQueue;
    vkfftCfg->commandPool         = &dev->commandPool;
    vkfftCfg->physicalDevice      = &dev->physicalDevice;
    vkfftCfg->isCompilerInitialized = 1;                   /* glslang already inited */

    /* Point VkFFT at our spectrum buffer (it will use it as in/out).
     * specBufSize must remain valid for the lifetime of vkfftApp — store in ctx. */
    ctx->specBufSize = specBytes;
    vkfftCfg->buffer            = &ctx->specBuf;
    vkfftCfg->bufferSize        = &ctx->specBufSize;

    /* Create fence */
    VkFenceCreateInfo fci = { .sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO };
    if (vkCreateFence(d, &fci, NULL, &ctx->fence) != VK_SUCCESS)
        goto fail;
    vkfftCfg->fence = &ctx->fence;

    VkFFTResult vr = initializeVkFFT(&ctx->vkfftApp, *vkfftCfg);
    if (vr != VKFFT_SUCCESS) {
        fprintf(stderr, "vkfft_wrapper: initializeVkFFT failed: %d\n", (int)vr);
        goto fail;
    }
    /* Validate that VkFFT created its internal plan — if localFFTPlan is NULL,
     * VkFFTAppend will SIGSEGV. This guards against silent failures. */
    if (ctx->vkfftApp.localFFTPlan == NULL) {
        fprintf(stderr, "vkfft_wrapper: initializeVkFFT produced NULL localFFTPlan\n");
        goto fail;
    }
    ctx->vkfftReady = 1;

    /* ── Allocate command buffer ── */
    VkCommandBufferAllocateInfo cbai = {
        .sType              = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
        .commandPool        = dev->commandPool,
        .level              = VK_COMMAND_BUFFER_LEVEL_PRIMARY,
        .commandBufferCount = 1,
    };
    if (vkAllocateCommandBuffers(d, &cbai, &ctx->cmdBuf) != VK_SUCCESS)
        goto fail;

    return ctx;

fail:
    vk_fft_destroy(ctx);
    return NULL;
}

/* ── vk_fft_process ──────────────────────────────────────────────────────── */
int vk_fft_process(VkFftContext *ctx, const uint8_t *iqData, float *outDb) {
    VkDeviceContext *dev = ctx->dev;
    VkDevice         d   = dev->device;
    uint32_t fftSize     = ctx->fftSize;

    if (!ctx->vkfftReady) return -1;

    /* Upload IQ data into staging buffer */
    void *mapped = NULL;
    if (vkMapMemory(d, ctx->stagingMem, 0, (VkDeviceSize)fftSize * 2, 0, &mapped) != VK_SUCCESS)
        return 1;
    memcpy(mapped, iqData, (size_t)fftSize * 2);
    vkUnmapMemory(d, ctx->stagingMem);

    /* Reset + record command buffer */
    vkResetCommandBuffer(ctx->cmdBuf, 0);
    VkCommandBufferBeginInfo cbbi = {
        .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO,
        .flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT,
    };
    vkBeginCommandBuffer(ctx->cmdBuf, &cbbi);

    /* 1. Copy staging → IQ buffer */
    VkBufferCopy copyRegion = { .size = (VkDeviceSize)fftSize * 2 };
    vkCmdCopyBuffer(ctx->cmdBuf, ctx->stagingBuf, ctx->iqBuf, 1, &copyRegion);

    /* Barrier: transfer → compute */
    VkBufferMemoryBarrier barrier = {
        .sType               = VK_STRUCTURE_TYPE_BUFFER_MEMORY_BARRIER,
        .srcAccessMask       = VK_ACCESS_TRANSFER_WRITE_BIT,
        .dstAccessMask       = VK_ACCESS_SHADER_READ_BIT,
        .srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED,
        .dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED,
        .buffer              = ctx->iqBuf,
        .offset              = 0,
        .size                = VK_WHOLE_SIZE,
    };
    vkCmdPipelineBarrier(ctx->cmdBuf,
        VK_PIPELINE_STAGE_TRANSFER_BIT,
        VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
        0, 0, NULL, 1, &barrier, 0, NULL);

    /* 2. Preprocess: uint8 IQ → float32 complex + Hann window */
    vkCmdBindPipeline(ctx->cmdBuf, VK_PIPELINE_BIND_POINT_COMPUTE, ctx->preprocPipeline);
    vkCmdBindDescriptorSets(ctx->cmdBuf, VK_PIPELINE_BIND_POINT_COMPUTE,
                            ctx->preprocLayout, 0, 1, &ctx->preprocDS, 0, NULL);
    vkCmdPushConstants(ctx->cmdBuf, ctx->preprocLayout,
                       VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(uint32_t), &fftSize);
    uint32_t groups = (fftSize + 255) / 256;
    vkCmdDispatch(ctx->cmdBuf, groups, 1, 1);

    /* Barrier: compute write → VkFFT read */
    VkBufferMemoryBarrier barrier2 = {
        .sType               = VK_STRUCTURE_TYPE_BUFFER_MEMORY_BARRIER,
        .srcAccessMask       = VK_ACCESS_SHADER_WRITE_BIT,
        .dstAccessMask       = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT,
        .srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED,
        .dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED,
        .buffer              = ctx->specBuf,
        .offset              = 0,
        .size                = VK_WHOLE_SIZE,
    };
    vkCmdPipelineBarrier(ctx->cmdBuf,
        VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
        VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
        0, 0, NULL, 1, &barrier2, 0, NULL);

    vkEndCommandBuffer(ctx->cmdBuf);

    /* Submit preprocessing pass */
    VkSubmitInfo si = {
        .sType              = VK_STRUCTURE_TYPE_SUBMIT_INFO,
        .commandBufferCount = 1,
        .pCommandBuffers    = &ctx->cmdBuf,
    };
    vkResetFences(d, 1, &ctx->fence);
    if (vkQueueSubmit(dev->computeQueue, 1, &si, ctx->fence) != VK_SUCCESS) return 2;
    vkWaitForFences(d, 1, &ctx->fence, VK_TRUE, UINT64_MAX);

    /* 3. VkFFT forward C2C FFT — record into a fresh command buffer, then submit+wait */
    vkResetCommandBuffer(ctx->cmdBuf, 0);
    vkBeginCommandBuffer(ctx->cmdBuf, &cbbi);
    VkFFTLaunchParams lp = VKFFT_ZERO_INIT;
    lp.commandBuffer = &ctx->cmdBuf;

    VkFFTResult vr = VkFFTAppend(&ctx->vkfftApp, -1, &lp);
    if (vr != VKFFT_SUCCESS) {
        fprintf(stderr, "vkfft_wrapper: VkFFTAppend failed: %d\n", (int)vr);
        vkEndCommandBuffer(ctx->cmdBuf);
        return 3;
    }
    vkEndCommandBuffer(ctx->cmdBuf);

    vkResetFences(d, 1, &ctx->fence);
    if (vkQueueSubmit(dev->computeQueue, 1, &si, ctx->fence) != VK_SUCCESS) return 3;
    vkWaitForFences(d, 1, &ctx->fence, VK_TRUE, UINT64_MAX);

    /* 4. Copy spectrum buffer → download buffer */
    vkResetCommandBuffer(ctx->cmdBuf, 0);
    vkBeginCommandBuffer(ctx->cmdBuf, &cbbi);
    VkBufferCopy dlCopy = { .size = (VkDeviceSize)fftSize * 8 };
    vkCmdCopyBuffer(ctx->cmdBuf, ctx->specBuf, ctx->dlBuf, 1, &dlCopy);
    vkEndCommandBuffer(ctx->cmdBuf);

    vkResetFences(d, 1, &ctx->fence);
    if (vkQueueSubmit(dev->computeQueue, 1, &si, ctx->fence) != VK_SUCCESS) return 4;
    vkWaitForFences(d, 1, &ctx->fence, VK_TRUE, UINT64_MAX);

    /* 5. Read back + compute dB magnitudes (ALL fftSize bins, no shift) */
    float *spec = NULL;
    if (vkMapMemory(d, ctx->dlMem, 0, (VkDeviceSize)fftSize * 8, 0, (void **)&spec) != VK_SUCCESS)
        return 5;

    for (uint32_t k = 0; k < fftSize; k++) {
        float re = spec[k * 2];
        float im = spec[k * 2 + 1];
        float power = re * re + im * im;
        /* Match CPU path: output 10*log10(power), caller applies FFT-shift
         * and subtracts normDbVal (20*log10(N) + windowCorrection). */
        outDb[k] = power > 1e-20f ? 10.0f * log10f(power) : -200.0f;
    }
    vkUnmapMemory(d, ctx->dlMem);

    return 0;
}

/* ── vk_fft_destroy ──────────────────────────────────────────────────────── */
void vk_fft_destroy(VkFftContext *ctx) {
    if (!ctx) return;
    VkDevice d = ctx->dev ? ctx->dev->device : VK_NULL_HANDLE;
    if (d == VK_NULL_HANDLE) { free(ctx); return; }

    if (ctx->cmdBuf != VK_NULL_HANDLE)
        vkFreeCommandBuffers(d, ctx->dev->commandPool, 1, &ctx->cmdBuf);

    if (ctx->vkfftReady)
        deleteVkFFT(&ctx->vkfftApp);

    if (ctx->fence != VK_NULL_HANDLE)         vkDestroyFence(d, ctx->fence, NULL);
    if (ctx->preprocPipeline != VK_NULL_HANDLE) vkDestroyPipeline(d, ctx->preprocPipeline, NULL);
    if (ctx->preprocLayout != VK_NULL_HANDLE)   vkDestroyPipelineLayout(d, ctx->preprocLayout, NULL);
    if (ctx->preprocPool != VK_NULL_HANDLE)     vkDestroyDescriptorPool(d, ctx->preprocPool, NULL);
    if (ctx->preprocDSL != VK_NULL_HANDLE)      vkDestroyDescriptorSetLayout(d, ctx->preprocDSL, NULL);
    if (ctx->preprocModule != VK_NULL_HANDLE)   vkDestroyShaderModule(d, ctx->preprocModule, NULL);

    if (ctx->dlBuf   != VK_NULL_HANDLE) vkDestroyBuffer(d, ctx->dlBuf,   NULL);
    if (ctx->dlMem   != VK_NULL_HANDLE) vkFreeMemory(d, ctx->dlMem,      NULL);
    if (ctx->specBuf != VK_NULL_HANDLE) vkDestroyBuffer(d, ctx->specBuf, NULL);
    if (ctx->specMem != VK_NULL_HANDLE) vkFreeMemory(d, ctx->specMem,    NULL);
    if (ctx->iqBuf   != VK_NULL_HANDLE) vkDestroyBuffer(d, ctx->iqBuf,   NULL);
    if (ctx->iqMem   != VK_NULL_HANDLE) vkFreeMemory(d, ctx->iqMem,      NULL);
    if (ctx->stagingBuf != VK_NULL_HANDLE) vkDestroyBuffer(d, ctx->stagingBuf, NULL);
    if (ctx->stagingMem != VK_NULL_HANDLE) vkFreeMemory(d, ctx->stagingMem,    NULL);

    free(ctx);
}
