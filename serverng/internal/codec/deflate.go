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
}

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
