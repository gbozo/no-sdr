#ifndef FM_STEREO_H
#define FM_STEREO_H

#include <vulkan/vulkan.h>
#include <stdint.h>

// Maximum concurrent WFM stereo clients
#define FM_MAX_CLIENTS 32

// Maximum input samples per chunk at 240kHz (4ms = 960, 10ms = 2400, 20ms = 4800)
#define FM_MAX_INPUT_SAMPLES 8192

// Maximum FIR tap count
#define FM_MAX_TAPS 64

// FIR buffer size (power of 2, >= FM_MAX_TAPS)
#define FM_FIR_BUF_SIZE 64

// Per-client state — mirrors GLSL ClientState struct (scalar layout)
typedef struct {
    // FIR delay line for L+R (64 floats)
    float lprBuf[FM_FIR_BUF_SIZE];
    // FIR delay line for L-R (64 floats)
    float lrBuf[FM_FIR_BUF_SIZE];
    // FIR write positions
    int32_t lprPos;
    int32_t lrPos;
    // De-emphasis state
    float deemphL;
    float deemphR;
    // De-emphasis alpha (1 - exp(-1/(sampleRate × tau)))
    float deemphAlpha;
    // DC block state (post-decimation)
    float dcPrevL;
    float dcOutPrevL;
    float dcPrevR;
    float dcOutPrevR;
    // Decimation counter
    int32_t decimCounter;
    // Padding
    float _pad[2];
} FmClientState;

// Push constants
typedef struct {
    uint32_t numClients;
    uint32_t numSamples;
    uint32_t decimFactor;
    uint32_t numTaps;
} FmPushConstants;

// Opaque pipeline context
typedef struct FmStereoPipelineCtx FmStereoPipelineCtx;

// Create the FM stereo FIR pipeline.
// dev: pointer to initialized VkDeviceContext
// taps: FIR coefficients (51 typical), numTaps values
// numTaps: number of taps
// Returns NULL on failure.
FmStereoPipelineCtx* fm_stereo_create(void* dev, const float* taps, uint32_t numTaps);

// Dispatch the FM stereo pipeline for a batch of WFM clients.
//
// ctx:          pipeline context
// states:       array of FmClientState[numClients] — state is READ and WRITTEN back
// composite:    array of float[numClients * numSamples] — FM discriminator output
// carrier38:    array of float[numClients * numSamples] — 2×cos(2×pilotPhase)
// blends:       array of float[numClients * numSamples] — stereo blend factors [0,1]
// numSamples:   number of input samples per client (at 240kHz)
// numClients:   number of active WFM clients (1..FM_MAX_CLIENTS)
// decimFactor:  decimation factor (typically 5 for 240k→48k)
// outAudio:     output buffer for float32 interleaved L,R — size >= numClients * (numSamples/decimFactor) * 2
// outCounts:    output array[numClients] — number of stereo frames per client
//
// Returns 0 on success, non-zero on failure.
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
);

// Destroy the FM stereo pipeline, releasing all GPU resources.
void fm_stereo_destroy(FmStereoPipelineCtx* ctx);

#endif // FM_STEREO_H
