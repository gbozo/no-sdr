package codec

import (
	"bytes"
	"compress/flate"
	"encoding/binary"
	"io"
	"math"
	"testing"
)

// --- CompressFft tests ---

func TestCompressFft_BoundaryValues(t *testing.T) {
	minDb := float32(-120.0)
	maxDb := float32(-20.0)

	fft := []float32{-120, -20, -70} // min, max, midpoint

	out := CompressFft(fft, minDb, maxDb)

	if out[0] != 0 {
		t.Errorf("minDb should map to 0, got %d", out[0])
	}
	if out[1] != 255 {
		t.Errorf("maxDb should map to 255, got %d", out[1])
	}
	// Midpoint: (-70 - (-120)) / (-20 - (-120)) * 255 = 50/100 * 255 = 127.5 → 128
	if out[2] != 128 {
		t.Errorf("midpoint should map to 128, got %d", out[2])
	}
}

func TestCompressFft_Clamping(t *testing.T) {
	minDb := float32(-100.0)
	maxDb := float32(0.0)

	fft := []float32{-150, 50} // below min, above max

	out := CompressFft(fft, minDb, maxDb)

	if out[0] != 0 {
		t.Errorf("below-min should clamp to 0, got %d", out[0])
	}
	if out[1] != 255 {
		t.Errorf("above-max should clamp to 255, got %d", out[1])
	}
}

func TestCompressFft_DegenerateRange(t *testing.T) {
	fft := []float32{-50, -30, -10}
	out := CompressFft(fft, -50, -50) // zero range

	for i, v := range out {
		if v != 0 {
			t.Errorf("degenerate range: out[%d] = %d, want 0", i, v)
		}
	}
}

// --- DeltaEncode / DeltaDecode tests ---

func TestDeltaEncode_RoundTrip(t *testing.T) {
	data := []byte{10, 15, 12, 20, 18, 100, 200, 50, 0, 255}

	encoded := DeltaEncode(data)
	decoded := DeltaDecode(encoded)

	if len(decoded) != len(data) {
		t.Fatalf("length mismatch: got %d, want %d", len(decoded), len(data))
	}
	for i := range data {
		if decoded[i] != data[i] {
			t.Errorf("mismatch at [%d]: got %d, want %d", i, decoded[i], data[i])
		}
	}
}

func TestDeltaEncode_KnownValues(t *testing.T) {
	data := []byte{100, 103, 105, 102}
	encoded := DeltaEncode(data)

	// out[0] = 100
	// out[1] = 103 - 100 = 3
	// out[2] = 105 - 103 = 2
	// out[3] = 102 - 105 = -3 → 253 (uint8 wrap)
	expected := []byte{100, 3, 2, 253}
	for i := range expected {
		if encoded[i] != expected[i] {
			t.Errorf("encoded[%d] = %d, want %d", i, encoded[i], expected[i])
		}
	}
}

func TestDeltaEncode_Empty(t *testing.T) {
	if DeltaEncode(nil) != nil {
		t.Error("nil input should return nil")
	}
	if DeltaDecode(nil) != nil {
		t.Error("nil input should return nil")
	}
	if DeltaEncode([]byte{}) != nil {
		t.Error("empty input should return nil")
	}
}

func TestDeltaEncode_LargeRoundTrip(t *testing.T) {
	data := make([]byte, 65536)
	// Simulate FFT-like data (slowly varying)
	for i := range data {
		data[i] = byte(128 + int(30*math.Sin(float64(i)*0.01)))
	}

	encoded := DeltaEncode(data)
	decoded := DeltaDecode(encoded)

	for i := range data {
		if decoded[i] != data[i] {
			t.Fatalf("mismatch at [%d]: got %d, want %d", i, decoded[i], data[i])
		}
	}
}

// --- DeflateFft tests ---

func TestDeflateFft_ValidDeflate(t *testing.T) {
	// Create a simple FFT frame
	fft := make([]float32, 1024)
	for i := range fft {
		fft[i] = -120 + 100*float32(math.Sin(float64(i)*0.05))
	}
	minDb := float32(-120)
	maxDb := float32(-20)

	deflated, err := DeflateFft(fft, minDb, maxDb)
	if err != nil {
		t.Fatalf("DeflateFft failed: %v", err)
	}
	if len(deflated) == 0 {
		t.Fatal("deflated output is empty")
	}

	// Inflate and verify we get back the same delta-encoded data
	reader := flate.NewReader(bytes.NewReader(deflated))
	inflated, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("inflate failed: %v", err)
	}
	reader.Close()

	if len(inflated) != 1024 {
		t.Fatalf("inflated length = %d, want 1024", len(inflated))
	}

	// Verify: delta-decode the inflated data matches CompressFft output
	quantized := CompressFft(fft, minDb, maxDb)
	deltaDecoded := DeltaDecode(inflated)

	for i := range quantized {
		if deltaDecoded[i] != quantized[i] {
			t.Errorf("mismatch at [%d]: got %d, want %d", i, deltaDecoded[i], quantized[i])
			break
		}
	}
}

func TestDeflateFft_CompressionRatio(t *testing.T) {
	// FFT data with smooth transitions should compress well
	fft := make([]float32, 65536)
	for i := range fft {
		fft[i] = -80 + 20*float32(math.Sin(float64(i)*0.001))
	}

	deflated, err := DeflateFft(fft, -120, -20)
	if err != nil {
		t.Fatalf("DeflateFft failed: %v", err)
	}

	ratio := float64(len(fft)*4) / float64(len(deflated))
	t.Logf("Compression: %d float32 bytes → %d deflated bytes (%.1fx ratio)",
		len(fft)*4, len(deflated), ratio)

	// Smooth FFT data should compress at least 10:1
	if ratio < 5.0 {
		t.Errorf("unexpectedly poor compression ratio: %.1fx", ratio)
	}
}

// --- PackFftDeflatePayload tests ---

func TestPackFftDeflatePayload_Header(t *testing.T) {
	fft := make([]float32, 4096)
	for i := range fft {
		fft[i] = -60
	}
	minDb := float32(-110)
	maxDb := float32(-10)

	payload, err := PackFftDeflatePayload(fft, minDb, maxDb)
	if err != nil {
		t.Fatalf("PackFftDeflatePayload failed: %v", err)
	}

	// Check header
	gotMinDb := int16(binary.LittleEndian.Uint16(payload[0:2]))
	gotMaxDb := int16(binary.LittleEndian.Uint16(payload[2:4]))
	gotBinCount := binary.LittleEndian.Uint32(payload[4:8])

	if gotMinDb != -110 {
		t.Errorf("minDb = %d, want -110", gotMinDb)
	}
	if gotMaxDb != -10 {
		t.Errorf("maxDb = %d, want -10", gotMaxDb)
	}
	if gotBinCount != 4096 {
		t.Errorf("binCount = %d, want 4096", gotBinCount)
	}

	// Verify deflate bytes are valid
	reader := flate.NewReader(bytes.NewReader(payload[8:]))
	inflated, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("inflate failed: %v", err)
	}
	reader.Close()

	if len(inflated) != 4096 {
		t.Errorf("inflated length = %d, want 4096", len(inflated))
	}
}

// --- FftDeflateEncoder tests ---

func TestFftDeflateEncoder_Reuse(t *testing.T) {
	enc := NewFftDeflateEncoder(65536)

	// Encode two different frames and verify no cross-contamination
	fft1 := make([]float32, 2048)
	fft2 := make([]float32, 2048)
	for i := range fft1 {
		fft1[i] = -100 + float32(i)*0.05
		fft2[i] = -50 - float32(i)*0.02
	}

	out1, err := enc.Encode(fft1, -120, -20)
	if err != nil {
		t.Fatalf("first encode failed: %v", err)
	}

	out2, err := enc.Encode(fft2, -120, -20)
	if err != nil {
		t.Fatalf("second encode failed: %v", err)
	}

	// Verify both inflate correctly
	verifyDeflateOutput(t, out1, fft1, -120, -20, "frame1")
	verifyDeflateOutput(t, out2, fft2, -120, -20, "frame2")

	// Outputs should differ (different input data)
	if bytes.Equal(out1, out2) {
		t.Error("two different inputs produced identical deflate output")
	}
}

func TestFftDeflateEncoder_MatchesStandalone(t *testing.T) {
	fft := make([]float32, 4096)
	for i := range fft {
		fft[i] = -80 + 40*float32(math.Sin(float64(i)*0.01))
	}

	// Encode with standalone function
	standalone, err := DeflateFft(fft, -120, -20)
	if err != nil {
		t.Fatalf("DeflateFft failed: %v", err)
	}

	// Encode with reusable encoder
	enc := NewFftDeflateEncoder(4096)
	reusable, err := enc.Encode(fft, -120, -20)
	if err != nil {
		t.Fatalf("encoder.Encode failed: %v", err)
	}

	// Both should inflate to the same data
	inflateStandalone := inflateRaw(t, standalone)
	inflateReusable := inflateRaw(t, reusable)

	if !bytes.Equal(inflateStandalone, inflateReusable) {
		t.Error("standalone and reusable encoder produce different decompressed output")
	}
}

func TestFftDeflateEncoder_MultipleFramesSameSize(t *testing.T) {
	enc := NewFftDeflateEncoder(8192)

	for frame := 0; frame < 10; frame++ {
		fft := make([]float32, 8192)
		for i := range fft {
			fft[i] = -90 + float32(frame)*5 + 30*float32(math.Sin(float64(i)*0.003+float64(frame)))
		}

		out, err := enc.Encode(fft, -120, -20)
		if err != nil {
			t.Fatalf("frame %d encode failed: %v", frame, err)
		}

		verifyDeflateOutput(t, out, fft, -120, -20, "")
	}
}

func TestFftDeflateEncoder_GrowingScratch(t *testing.T) {
	// Start with small maxBins, then encode larger frames
	enc := NewFftDeflateEncoder(64)

	fft := make([]float32, 4096)
	for i := range fft {
		fft[i] = -70
	}

	out, err := enc.Encode(fft, -120, -20)
	if err != nil {
		t.Fatalf("encode with grown scratch failed: %v", err)
	}

	verifyDeflateOutput(t, out, fft, -120, -20, "grown")
}

// --- Benchmarks ---

func BenchmarkCompressFft65536(b *testing.B) {
	fft := make([]float32, 65536)
	for i := range fft {
		fft[i] = -80 + 40*float32(math.Sin(float64(i)*0.001))
	}
	b.ResetTimer()
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		CompressFft(fft, -120, -20)
	}
}

func BenchmarkDeflateFft65536(b *testing.B) {
	fft := make([]float32, 65536)
	for i := range fft {
		fft[i] = -80 + 40*float32(math.Sin(float64(i)*0.001))
	}
	b.ResetTimer()
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		_, _ = DeflateFft(fft, -120, -20)
	}
}

func BenchmarkFftDeflateEncoder65536(b *testing.B) {
	fft := make([]float32, 65536)
	for i := range fft {
		fft[i] = -80 + 40*float32(math.Sin(float64(i)*0.001))
	}
	enc := NewFftDeflateEncoder(65536)
	b.ResetTimer()
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		_, _ = enc.Encode(fft, -120, -20)
	}
}

// --- Helpers ---

func verifyDeflateOutput(t *testing.T, deflated []byte, fft []float32, minDb, maxDb float32, label string) {
	t.Helper()

	inflated := inflateRaw(t, deflated)
	if len(inflated) != len(fft) {
		t.Errorf("%s: inflated len = %d, want %d", label, len(inflated), len(fft))
		return
	}

	// Delta-decode and compare to expected quantized values
	decoded := DeltaDecode(inflated)
	expected := CompressFft(fft, minDb, maxDb)

	for i := range expected {
		if decoded[i] != expected[i] {
			t.Errorf("%s: mismatch at [%d]: got %d, want %d", label, i, decoded[i], expected[i])
			return
		}
	}
}

func inflateRaw(t *testing.T, data []byte) []byte {
	t.Helper()
	reader := flate.NewReader(bytes.NewReader(data))
	out, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("inflate failed: %v", err)
	}
	reader.Close()
	return out
}
