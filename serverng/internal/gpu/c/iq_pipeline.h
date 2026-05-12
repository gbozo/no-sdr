#ifndef IQ_PIPELINE_H
#define IQ_PIPELINE_H

#include <vulkan/vulkan.h>

// Maximum concurrent clients supported by the IQ pipeline
#define IQ_MAX_CLIENTS 64

// Maximum input samples per chunk (24000 = 10ms @ 2.4 MSPS)
#define IQ_MAX_INPUT_SAMPLES 32768

// ClientParams mirrors the GLSL struct (must be 128 bytes, std430 layout)
typedef struct {
    // NCO (8 bytes)
    float phaseInit;
    float phaseInc;
    // Butterworth section 0 (20 bytes)
    float b0_0, b1_0, b2_0, a1_0, a2_0;
    // Butterworth section 1 (20 bytes)
    float b0_1, b1_1, b2_1, a1_1, a2_1;
    // Butterworth state I (16 bytes)
    float stI0_z1, stI0_z2, stI1_z1, stI1_z2;
    // Butterworth state Q (16 bytes)
    float stQ0_z1, stQ0_z2, stQ1_z1, stQ1_z2;
    // Decimation (4 bytes)
    uint32_t decimFactor;
    // DC blocker (16 bytes)
    float dcAlpha;
    float dcI;
    float dcQ;
    uint32_t dcEnabled;
    // Padding (4 bytes to reach nice alignment)
    float _pad0;
} IqClientParams;  // Total: 108 bytes — padded to 112 for std430

// Push constants for the dispatch
typedef struct {
    uint32_t numClients;
    uint32_t inputSamples;
} IqPushConstants;

// Opaque context for the IQ pipeline
typedef struct IqPipelineCtx IqPipelineCtx;

// Create the IQ pipeline compute shader context.
// dev: initialized VkDeviceContext
// Returns NULL on failure.
IqPipelineCtx* iq_pipeline_create(void* dev);

// Dispatch the IQ pipeline for a batch of clients.
//
// ctx:          pipeline context
// params:      array of IqClientParams[numClients] — state is READ and WRITTEN back
// rawIQ:       input uint8 IQ data (shared by all clients), length = inputSamples * 2
// inputSamples: number of complex samples in the input chunk
// numClients:  number of active clients (1..IQ_MAX_CLIENTS)
// outBuf:      output buffer for int16 IQ data, size >= numClients * maxOutSamples * 4
// outCounts:   output array[numClients] — number of complex samples per client
//
// Returns 0 on success, non-zero on failure.
int iq_pipeline_process(
    IqPipelineCtx* ctx,
    IqClientParams* params,
    const uint8_t* rawIQ,
    uint32_t inputSamples,
    uint32_t numClients,
    int16_t* outBuf,
    uint32_t* outCounts
);

// Destroy the IQ pipeline, releasing all GPU resources.
void iq_pipeline_destroy(IqPipelineCtx* ctx);

#endif // IQ_PIPELINE_H
