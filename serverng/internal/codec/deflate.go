package codec

import (
	"bytes"
	"compress/flate"
	"encoding/binary"
	"fmt"
	"math"
)

// DeflateFft compresses FFT data using delta-encoding + flate (deflate level 6).
// Pipeline: float32 dB → uint8 quantize → delta encode → deflate (raw, no zlib header).
// Returns the raw deflated bytes matching Node.js deflateRaw behavior.
func DeflateFft(fft []float32, minDb, maxDb float32) ([]byte, error) {
	// Step 1: Quantize to uint8
	quantized := CompressFft(fft, minDb, maxDb)

	// Step 2: Delta encode
	delta := DeltaEncode(quantized)

	// Step 3: Deflate (raw — no zlib wrapper)
	var buf bytes.Buffer
	w, err := flate.NewWriter(&buf, 6)
	if err != nil {
		return nil, fmt.Errorf("flate.NewWriter: %w", err)
	}
	if _, err := w.Write(delta); err != nil {
		return nil, fmt.Errorf("flate write: %w", err)
	}
	if err := w.Close(); err != nil {
		return nil, fmt.Errorf("flate close: %w", err)
	}
	return buf.Bytes(), nil
}

// PackFftDeflatePayload creates the full message payload (without the type byte):
// [Int16 minDb LE][Int16 maxDb LE][Uint32 binCount LE][deflate bytes]
func PackFftDeflatePayload(fft []float32, minDb, maxDb float32) ([]byte, error) {
	deflated, err := DeflateFft(fft, minDb, maxDb)
	if err != nil {
		return nil, err
	}

	// Header: 2 + 2 + 4 = 8 bytes
	payload := make([]byte, 8+len(deflated))

	minDbI16 := int16(math.Round(float64(minDb)))
	maxDbI16 := int16(math.Round(float64(maxDb)))

	binary.LittleEndian.PutUint16(payload[0:2], uint16(minDbI16))
	binary.LittleEndian.PutUint16(payload[2:4], uint16(maxDbI16))
	binary.LittleEndian.PutUint32(payload[4:8], uint32(len(fft)))
	copy(payload[8:], deflated)

	return payload, nil
}

// FftDeflateEncoder is a reusable encoder that avoids per-frame allocations.
// It pools the scratch buffer, output buffer, and flate writer for zero-alloc
// steady-state encoding of FFT frames.
type FftDeflateEncoder struct {
	scratch []byte       // reusable buffer for uint8 quantized + delta
	buf     bytes.Buffer // reusable output buffer
	writer  *flate.Writer

	// Noise floor EMA state (for deflate-floor mode)
	noiseFloorEma float64
	noiseFloorSet bool
}

// Noise floor constants (match Node.js ws-manager.ts)
const (
	noiseFloorPercentile = 5    // 5th percentile
	noiseFloorEmaAlpha   = 0.05 // slow-tracking EMA
)

// NewFftDeflateEncoder creates a new reusable FFT deflate encoder.
// maxBins is the maximum FFT bin count expected (used to pre-allocate scratch).
func NewFftDeflateEncoder(maxBins int) *FftDeflateEncoder {
	e := &FftDeflateEncoder{
		scratch: make([]byte, maxBins),
	}
	// Pre-create the writer; it will be reset on each Encode call.
	e.writer, _ = flate.NewWriter(&e.buf, 6)
	return e
}

// Reset clears the encoder state. Call between unrelated streams if needed.
func (e *FftDeflateEncoder) Reset() {
	e.buf.Reset()
	e.writer.Reset(&e.buf)
}

// Encode compresses an FFT frame using the reusable encoder.
// Returns a newly allocated byte slice containing the raw deflated output.
// The internal buffers are reused across calls.
func (e *FftDeflateEncoder) Encode(fft []float32, minDb, maxDb float32) ([]byte, error) {
	n := len(fft)

	// Grow scratch if needed
	if cap(e.scratch) < n {
		e.scratch = make([]byte, n)
	}
	scratch := e.scratch[:n]

	// Step 1: Quantize in-place into scratch
	compressFftInto(fft, minDb, maxDb, scratch)

	// Step 2: Delta encode in-place
	// We can do this in-place since we iterate forward
	for i := n - 1; i > 0; i-- {
		scratch[i] = scratch[i] - scratch[i-1]
	}
	// scratch[0] stays as-is

	// Step 3: Deflate using pooled writer
	e.buf.Reset()
	e.writer.Reset(&e.buf)

	if _, err := e.writer.Write(scratch); err != nil {
		return nil, fmt.Errorf("flate write: %w", err)
	}
	if err := e.writer.Close(); err != nil {
		return nil, fmt.Errorf("flate close: %w", err)
	}

	// Copy out (caller owns the slice; we reuse buf next call)
	out := make([]byte, e.buf.Len())
	copy(out, e.buf.Bytes())
	return out, nil
}

// EncodePayload encodes and packs the full payload (without type byte).
// [Int16 minDb LE][Int16 maxDb LE][Uint32 binCount LE][deflate bytes]
func (e *FftDeflateEncoder) EncodePayload(fft []float32, minDb, maxDb float32) ([]byte, error) {
	deflated, err := e.Encode(fft, minDb, maxDb)
	if err != nil {
		return nil, err
	}

	payload := make([]byte, 8+len(deflated))
	minDbI16 := int16(math.Round(float64(minDb)))
	maxDbI16 := int16(math.Round(float64(maxDb)))

	binary.LittleEndian.PutUint16(payload[0:2], uint16(minDbI16))
	binary.LittleEndian.PutUint16(payload[2:4], uint16(maxDbI16))
	binary.LittleEndian.PutUint32(payload[4:8], uint32(len(fft)))
	copy(payload[8:], deflated)

	return payload, nil
}

// EncodeMessage encodes a full wire message in a single allocation:
// [msgType][Int16 minDb LE][Int16 maxDb LE][Uint32 binCount LE][deflate bytes]
// This avoids the make+copy that would otherwise be needed to prepend the type byte.
func (e *FftDeflateEncoder) EncodeMessage(msgType byte, fft []float32, minDb, maxDb float32) ([]byte, error) {
	n := len(fft)

	// Grow scratch if needed
	if cap(e.scratch) < n {
		e.scratch = make([]byte, n)
	}
	scratch := e.scratch[:n]

	compressFftInto(fft, minDb, maxDb, scratch)

	for i := n - 1; i > 0; i-- {
		scratch[i] = scratch[i] - scratch[i-1]
	}

	e.buf.Reset()
	e.writer.Reset(&e.buf)
	if _, err := e.writer.Write(scratch); err != nil {
		return nil, fmt.Errorf("flate write: %w", err)
	}
	if err := e.writer.Close(); err != nil {
		return nil, fmt.Errorf("flate close: %w", err)
	}

	// Single allocation: 1 (type) + 8 (header) + deflated
	msg := make([]byte, 1+8+e.buf.Len())
	msg[0] = msgType
	minDbI16 := int16(math.Round(float64(minDb)))
	maxDbI16 := int16(math.Round(float64(maxDb)))
	binary.LittleEndian.PutUint16(msg[1:3], uint16(minDbI16))
	binary.LittleEndian.PutUint16(msg[3:5], uint16(maxDbI16))
	binary.LittleEndian.PutUint32(msg[5:9], uint32(n))
	copy(msg[9:], e.buf.Bytes())
	return msg, nil
}

// EncodePayloadFloor encodes with noise-floor clamping for better compression.
// Bins below the EMA-smoothed noise floor are clamped to the floor value,
// reducing delta variance in the noise region.
func (e *FftDeflateEncoder) EncodePayloadFloor(fft []float32, minDb, maxDb float32) ([]byte, error) {
	n := len(fft)

	// Grow scratch if needed
	if cap(e.scratch) < n {
		e.scratch = make([]byte, n)
	}
	scratch := e.scratch[:n]

	// Step 1: Quantize into scratch
	compressFftInto(fft, minDb, maxDb, scratch)

	// Step 2: Compute noise floor via histogram + percentile
	var hist [256]int
	for i := 0; i < n; i++ {
		hist[scratch[i]]++
	}
	target := (n*noiseFloorPercentile + 99) / 100 // ceil(n * 5 / 100)
	cumulative := 0
	percentileIdx := 0
	for b := 0; b < 256; b++ {
		cumulative += hist[b]
		if cumulative >= target {
			percentileIdx = b
			break
		}
	}

	// Step 3: EMA smooth the noise floor across frames
	if !e.noiseFloorSet {
		e.noiseFloorEma = float64(percentileIdx)
		e.noiseFloorSet = true
	} else {
		e.noiseFloorEma += noiseFloorEmaAlpha * (float64(percentileIdx) - e.noiseFloorEma)
	}
	floorIdx := int(e.noiseFloorEma + 0.5)
	if floorIdx < 0 {
		floorIdx = 0
	} else if floorIdx > 255 {
		floorIdx = 255
	}
	floorByte := byte(floorIdx)

	// Step 4: Clamp bins below floor
	for i := 0; i < n; i++ {
		if scratch[i] < floorByte {
			scratch[i] = floorByte
		}
	}

	// Step 5: Delta encode in-place
	for i := n - 1; i > 0; i-- {
		scratch[i] = scratch[i] - scratch[i-1]
	}

	// Step 6: Deflate
	e.buf.Reset()
	e.writer.Reset(&e.buf)
	if _, err := e.writer.Write(scratch); err != nil {
		return nil, fmt.Errorf("flate write: %w", err)
	}
	if err := e.writer.Close(); err != nil {
		return nil, fmt.Errorf("flate close: %w", err)
	}

	// Single allocation: 8 (header) + deflated
	payload := make([]byte, 8+e.buf.Len())
	minDbI16 := int16(math.Round(float64(minDb)))
	maxDbI16 := int16(math.Round(float64(maxDb)))
	binary.LittleEndian.PutUint16(payload[0:2], uint16(minDbI16))
	binary.LittleEndian.PutUint16(payload[2:4], uint16(maxDbI16))
	binary.LittleEndian.PutUint32(payload[4:8], uint32(n))
	copy(payload[8:], e.buf.Bytes())

	return payload, nil
}

// EncodeMessageFloor encodes with noise-floor clamping and returns a full wire
// message in a single allocation:
// [msgType][Int16 minDb LE][Int16 maxDb LE][Uint32 binCount LE][deflate bytes]
func (e *FftDeflateEncoder) EncodeMessageFloor(msgType byte, fft []float32, minDb, maxDb float32) ([]byte, error) {
	n := len(fft)

	if cap(e.scratch) < n {
		e.scratch = make([]byte, n)
	}
	scratch := e.scratch[:n]

	compressFftInto(fft, minDb, maxDb, scratch)

	var hist [256]int
	for i := 0; i < n; i++ {
		hist[scratch[i]]++
	}
	target := (n*noiseFloorPercentile + 99) / 100
	cumulative := 0
	percentileIdx := 0
	for b := 0; b < 256; b++ {
		cumulative += hist[b]
		if cumulative >= target {
			percentileIdx = b
			break
		}
	}

	if !e.noiseFloorSet {
		e.noiseFloorEma = float64(percentileIdx)
		e.noiseFloorSet = true
	} else {
		e.noiseFloorEma += noiseFloorEmaAlpha * (float64(percentileIdx) - e.noiseFloorEma)
	}
	floorIdx := int(e.noiseFloorEma + 0.5)
	if floorIdx < 0 {
		floorIdx = 0
	} else if floorIdx > 255 {
		floorIdx = 255
	}
	floorByte := byte(floorIdx)

	for i := 0; i < n; i++ {
		if scratch[i] < floorByte {
			scratch[i] = floorByte
		}
	}

	for i := n - 1; i > 0; i-- {
		scratch[i] = scratch[i] - scratch[i-1]
	}

	e.buf.Reset()
	e.writer.Reset(&e.buf)
	if _, err := e.writer.Write(scratch); err != nil {
		return nil, fmt.Errorf("flate write: %w", err)
	}
	if err := e.writer.Close(); err != nil {
		return nil, fmt.Errorf("flate close: %w", err)
	}

	// Single allocation: 1 (type) + 8 (header) + deflated
	msg := make([]byte, 1+8+e.buf.Len())
	msg[0] = msgType
	minDbI16 := int16(math.Round(float64(minDb)))
	maxDbI16 := int16(math.Round(float64(maxDb)))
	binary.LittleEndian.PutUint16(msg[1:3], uint16(minDbI16))
	binary.LittleEndian.PutUint16(msg[3:5], uint16(maxDbI16))
	binary.LittleEndian.PutUint32(msg[5:9], uint32(n))
	copy(msg[9:], e.buf.Bytes())
	return msg, nil
}
