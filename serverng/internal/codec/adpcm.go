// Package codec implements audio and signal compression codecs for node-sdr.
//
// IMA-ADPCM (Interactive Multimedia Association) codec provides 4:1
// compression of Int16 PCM data into 4-bit nibbles (2 samples per byte).
//
// Streaming-safe: state (predictor, stepIndex) persists across
// Encode()/Decode() calls. Call Reset() on stream start/reconnect.
//
// Used for both IQ sub-band and FFT compression paths.
package codec

import "math"

// IMA-ADPCM step index adjustment table (4-bit nibble → index delta)
var indexTable = [16]int{
	-1, -1, -1, -1, 2, 4, 6, 8,
	-1, -1, -1, -1, 2, 4, 6, 8,
}

// IMA-ADPCM step size table (89 entries, index 0–88)
var stepTable = [89]int{
	7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
	19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
	50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
	130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
	337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
	876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
	2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
	5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
	15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
}

// FftAdpcmPad is the number of warmup samples prepended to each FFT ADPCM frame.
const FftAdpcmPad = 10

// ImaAdpcmEncoder is a streaming IMA-ADPCM encoder.
// State persists across Encode() calls for seamless streaming.
type ImaAdpcmEncoder struct {
	predicted int
	index     int
}

// NewImaAdpcmEncoder creates a new encoder with zeroed state.
func NewImaAdpcmEncoder() *ImaAdpcmEncoder {
	return &ImaAdpcmEncoder{}
}

// Reset clears the encoder state (call on stream start or reconnect).
func (e *ImaAdpcmEncoder) Reset() {
	e.predicted = 0
	e.index = 0
}

// Encode encodes Int16 PCM samples to ADPCM nibbles (4:1 compression).
// Returns a new byte slice of length ceil(len(samples)/2).
func (e *ImaAdpcmEncoder) Encode(samples []int16) []byte {
	outLen := (len(samples) + 1) / 2
	out := make([]byte, outLen)
	e.EncodeInto(samples, out)
	return out
}

// EncodeInto encodes samples into the provided output buffer (zero-alloc).
// out must have length >= ceil(len(samples)/2).
// Returns the number of bytes written.
func (e *ImaAdpcmEncoder) EncodeInto(samples []int16, out []byte) int {
	n := len(samples)
	outLen := (n + 1) / 2

	for i := 0; i < n; i++ {
		nibble := e.encodeNibble(int(samples[i]))
		if i&1 == 1 {
			out[i>>1] |= byte(nibble << 4)
		} else {
			out[i>>1] = byte(nibble & 0x0f)
		}
	}

	return outLen
}

// encodeNibble encodes a single sample and returns a 4-bit nibble.
func (e *ImaAdpcmEncoder) encodeNibble(sample int) int {
	step := stepTable[e.index]
	delta := sample - e.predicted
	nibble := 0

	if delta < 0 {
		nibble = 8
		delta = -delta
	}
	if delta >= step {
		nibble |= 4
		delta -= step
	}
	if delta >= step>>1 {
		nibble |= 2
		delta -= step >> 1
	}
	if delta >= step>>2 {
		nibble |= 1
	}

	// Reconstruct exactly what the decoder will produce (avoids drift)
	diff := step >> 3
	if nibble&1 != 0 {
		diff += step >> 2
	}
	if nibble&2 != 0 {
		diff += step >> 1
	}
	if nibble&4 != 0 {
		diff += step
	}
	if nibble&8 != 0 {
		diff = -diff
	}

	e.predicted = clampInt16(e.predicted + diff)
	e.index = clampIndex(e.index + indexTable[nibble&0x0f])

	return nibble
}

// ImaAdpcmDecoder is a streaming IMA-ADPCM decoder.
// State persists across Decode() calls for seamless streaming.
type ImaAdpcmDecoder struct {
	predicted int
	index     int
}

// NewImaAdpcmDecoder creates a new decoder with zeroed state.
func NewImaAdpcmDecoder() *ImaAdpcmDecoder {
	return &ImaAdpcmDecoder{}
}

// Reset clears the decoder state (call on stream start or reconnect).
func (d *ImaAdpcmDecoder) Reset() {
	d.predicted = 0
	d.index = 0
}

// Decode decodes ADPCM nibbles back to Int16 PCM samples.
// sampleCount specifies the exact number of output samples desired.
// Each input byte produces 2 samples (low nibble first, high nibble second).
func (d *ImaAdpcmDecoder) Decode(data []byte, sampleCount int) []int16 {
	out := make([]int16, sampleCount)
	outIdx := 0

	for _, b := range data {
		if outIdx >= sampleCount {
			break
		}
		// Low nibble first
		out[outIdx] = int16(d.decodeNibble(int(b & 0x0f)))
		outIdx++

		if outIdx >= sampleCount {
			break
		}
		// High nibble second
		out[outIdx] = int16(d.decodeNibble(int((b >> 4) & 0x0f)))
		outIdx++
	}

	return out
}

// decodeNibble decodes a single 4-bit nibble and returns the predicted sample.
func (d *ImaAdpcmDecoder) decodeNibble(nibble int) int {
	step := stepTable[d.index]
	d.index = clampIndex(d.index + indexTable[nibble])

	diff := step >> 3
	if nibble&1 != 0 {
		diff += step >> 2
	}
	if nibble&2 != 0 {
		diff += step >> 1
	}
	if nibble&4 != 0 {
		diff += step
	}
	if nibble&8 != 0 {
		diff = -diff
	}

	d.predicted = clampInt16(d.predicted + diff)
	return d.predicted
}

// EncodeFftAdpcm encodes an FFT frame (Float32 dB values) to ADPCM.
//
// The encoder is reset per frame (stateless — no inter-frame dependency).
// Warmup padding (FftAdpcmPad samples) is prepended so the predictor converges
// before the real data begins.
//
// Returns: [Int16 minDb LE][Int16 maxDb LE][ADPCM nibbles for (pad + fftSize) samples]
func EncodeFftAdpcm(fft []float32, minDb, maxDb float32) []byte {
	fftLen := len(fft)
	totalSamples := FftAdpcmPad + fftLen

	// Convert to Int16 (dB × 100)
	int16Buf := make([]int16, totalSamples)
	firstVal := clampInt16(int(math.Round(float64(fft[0]) * 100)))
	for i := 0; i < FftAdpcmPad; i++ {
		int16Buf[i] = int16(firstVal)
	}
	for i := 0; i < fftLen; i++ {
		int16Buf[FftAdpcmPad+i] = int16(clampInt16(int(math.Round(float64(fft[i]) * 100))))
	}

	// Encode with a fresh encoder (reset per frame)
	enc := NewImaAdpcmEncoder()
	adpcm := enc.Encode(int16Buf)

	// Build result: 4-byte header + ADPCM payload
	result := make([]byte, 4+len(adpcm))
	// Int16 minDb LE
	minDbI16 := int16(math.Round(float64(minDb)))
	maxDbI16 := int16(math.Round(float64(maxDb)))
	result[0] = byte(minDbI16)
	result[1] = byte(minDbI16 >> 8)
	result[2] = byte(maxDbI16)
	result[3] = byte(maxDbI16 >> 8)
	copy(result[4:], adpcm)

	return result
}

// clampInt16 clamps a value to the range [-32768, 32767].
func clampInt16(v int) int {
	if v < -32768 {
		return -32768
	}
	if v > 32767 {
		return 32767
	}
	return v
}

// clampIndex clamps a step index to [0, 88].
func clampIndex(v int) int {
	if v < 0 {
		return 0
	}
	if v > 88 {
		return 88
	}
	return v
}
