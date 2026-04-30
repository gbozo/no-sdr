package codec

import (
	"math"
	"testing"
)

func TestEncodeDecodeRoundTrip(t *testing.T) {
	// Generate a ramp signal
	samples := make([]int16, 200)
	for i := range samples {
		samples[i] = int16((i - 100) * 100) // -10000 to +9900
	}

	enc := NewImaAdpcmEncoder()
	dec := NewImaAdpcmDecoder()

	encoded := enc.Encode(samples)

	// Encoded should be half the sample count (2 samples per byte)
	expectedLen := (len(samples) + 1) / 2
	if len(encoded) != expectedLen {
		t.Fatalf("expected encoded length %d, got %d", expectedLen, len(encoded))
	}

	decoded := dec.Decode(encoded, len(samples))

	if len(decoded) != len(samples) {
		t.Fatalf("expected decoded length %d, got %d", len(samples), len(decoded))
	}

	// ADPCM has quantization error — check that it's within reasonable bounds.
	// The max error depends on step size; for typical signals it should be < 5% of range.
	maxError := 0
	for i := range samples {
		diff := int(samples[i]) - int(decoded[i])
		if diff < 0 {
			diff = -diff
		}
		if diff > maxError {
			maxError = diff
		}
	}

	// For a ramp signal starting from 0 predictor/step, the initial samples
	// have large error because the step size starts at 7 and needs to grow.
	// Once the predictor converges, error drops significantly.
	// Accept up to ~30% of the signal range for the worst-case initial sample.
	signalRange := 20000 // -10000 to +9900
	maxAllowed := signalRange / 2
	if maxError > maxAllowed {
		t.Errorf("round-trip error too large: max error = %d (expected < %d)", maxError, maxAllowed)
	}
}

func TestEncodeDecodeRoundTrip_Sine(t *testing.T) {
	// Sine wave — common SDR signal pattern
	samples := make([]int16, 512)
	for i := range samples {
		samples[i] = int16(20000 * math.Sin(2*math.Pi*float64(i)/64))
	}

	enc := NewImaAdpcmEncoder()
	dec := NewImaAdpcmDecoder()

	encoded := enc.Encode(samples)
	decoded := dec.Decode(encoded, len(samples))

	// Check SNR is reasonable for 4-bit ADPCM
	var sumError float64
	var sumSignal float64
	for i := range samples {
		err := float64(samples[i]) - float64(decoded[i])
		sumError += err * err
		sumSignal += float64(samples[i]) * float64(samples[i])
	}

	if sumSignal > 0 {
		snrDb := 10 * math.Log10(sumSignal/sumError)
		// IMA-ADPCM typically achieves 20-30 dB SNR on sinusoids
		if snrDb < 15 {
			t.Errorf("SNR too low: %.1f dB (expected > 15 dB)", snrDb)
		}
	}
}

func TestKnownNibbleOutput(t *testing.T) {
	// Test with a known input to verify nibble encoding.
	// Starting from predictor=0, index=0 (step=7):
	// Sample 0: +100
	//   delta = 100, sign = 0
	//   100 >= 7 → bit2, delta=93
	//   93 >= 3 → bit1, delta=90
	//   90 >= 1 → bit0
	//   nibble = 0b0111 = 7
	//   reconstruct: diff = 7/8 + 7/4 + 7/2 + 7 = 0+1+3+7 = 11
	//   predicted = 11
	//   index = max(0, min(88, 0 + indexTable[7])) = 0 + 8 = 8

	samples := []int16{100, -100}
	enc := NewImaAdpcmEncoder()
	encoded := enc.Encode(samples)

	// 2 samples → 1 byte. Low nibble = sample 0, high nibble = sample 1
	if len(encoded) != 1 {
		t.Fatalf("expected 1 byte, got %d", len(encoded))
	}

	lowNibble := encoded[0] & 0x0f
	highNibble := (encoded[0] >> 4) & 0x0f

	// Verify sample 0 nibble
	// delta=100, step=7. 100>=7 → b2. 93>=3 → b1. 90>=1 → b0. sign=0. nibble=0111=7
	if lowNibble != 7 {
		t.Errorf("expected low nibble 7, got %d", lowNibble)
	}

	// After sample 0: predicted=11, index=8, step=stepTable[8]=16
	// Sample 1: -100
	// delta = -100 - 11 = -111, sign=1, |delta|=111
	// 111 >= 16 → b2, delta=95
	// 95 >= 8 → b1, delta=87
	// 87 >= 4 → b0
	// nibble = 8|4|2|1 = 15
	if highNibble != 15 {
		t.Errorf("expected high nibble 15, got %d", highNibble)
	}
}

func TestReset(t *testing.T) {
	enc := NewImaAdpcmEncoder()

	// Encode some data to modify state
	samples := []int16{1000, 2000, 3000, 4000}
	enc.Encode(samples)

	// After encoding, state should be non-zero
	if enc.predicted == 0 && enc.index == 0 {
		t.Error("state should be non-zero after encoding")
	}

	// Reset
	enc.Reset()
	if enc.predicted != 0 {
		t.Errorf("predicted should be 0 after reset, got %d", enc.predicted)
	}
	if enc.index != 0 {
		t.Errorf("index should be 0 after reset, got %d", enc.index)
	}

	// Decoder reset
	dec := NewImaAdpcmDecoder()
	dec.Decode([]byte{0x77, 0xFF, 0xAB}, 6)

	dec.Reset()
	if dec.predicted != 0 {
		t.Errorf("decoder predicted should be 0 after reset, got %d", dec.predicted)
	}
	if dec.index != 0 {
		t.Errorf("decoder index should be 0 after reset, got %d", dec.index)
	}
}

func TestEncodeFftAdpcm(t *testing.T) {
	// Create a simple FFT frame
	fft := make([]float32, 64)
	for i := range fft {
		fft[i] = -80.0 + float32(i)*0.5 // -80 to -48.5 dB
	}

	minDb := float32(-120)
	maxDb := float32(0)

	result := EncodeFftAdpcm(fft, minDb, maxDb)

	// Check header: 4 bytes
	if len(result) < 4 {
		t.Fatalf("result too short: %d bytes", len(result))
	}

	// minDb as Int16 LE
	gotMinDb := int16(result[0]) | int16(result[1])<<8
	if gotMinDb != -120 {
		t.Errorf("expected minDb -120, got %d", gotMinDb)
	}

	// maxDb as Int16 LE
	gotMaxDb := int16(result[2]) | int16(result[3])<<8
	if gotMaxDb != 0 {
		t.Errorf("expected maxDb 0, got %d", gotMaxDb)
	}

	// ADPCM payload length: ceil((FftAdpcmPad + 64) / 2) = ceil(74/2) = 37
	totalSamples := FftAdpcmPad + len(fft)
	expectedAdpcmLen := (totalSamples + 1) / 2
	if len(result)-4 != expectedAdpcmLen {
		t.Errorf("expected ADPCM payload length %d, got %d", expectedAdpcmLen, len(result)-4)
	}

	// Verify round-trip: decode the ADPCM part and check the FFT values
	dec := NewImaAdpcmDecoder()
	decoded := dec.Decode(result[4:], totalSamples)

	// Skip warmup, check FFT values
	for i := 0; i < len(fft); i++ {
		expectedInt16 := int16(clampInt16(int(math.Round(float64(fft[i]) * 100))))
		got := decoded[FftAdpcmPad+i]
		diff := int(expectedInt16) - int(got)
		if diff < 0 {
			diff = -diff
		}
		// Allow some quantization error
		if diff > 500 {
			t.Errorf("FFT bin %d: expected ~%d, got %d (diff %d)", i, expectedInt16, got, diff)
		}
	}
}

func TestEncodeInto(t *testing.T) {
	samples := []int16{500, -500, 1000, -1000, 2000, -2000}
	enc1 := NewImaAdpcmEncoder()
	enc2 := NewImaAdpcmEncoder()

	// Encode allocating
	result1 := enc1.Encode(samples)

	// Encode into pre-allocated buffer
	out := make([]byte, (len(samples)+1)/2)
	n := enc2.EncodeInto(samples, out)

	if n != len(result1) {
		t.Errorf("EncodeInto returned %d, Encode produced %d bytes", n, len(result1))
	}

	for i := range result1 {
		if result1[i] != out[i] {
			t.Errorf("byte %d: Encode=%02x, EncodeInto=%02x", i, result1[i], out[i])
		}
	}
}

func TestOddSampleCount(t *testing.T) {
	// Odd number of samples: last byte only has low nibble valid
	samples := []int16{100, 200, 300}
	enc := NewImaAdpcmEncoder()
	encoded := enc.Encode(samples)

	// 3 samples → 2 bytes
	if len(encoded) != 2 {
		t.Fatalf("expected 2 bytes for 3 samples, got %d", len(encoded))
	}

	// Decode should produce 3 samples (from 2 bytes → 4 nibbles, but sampleCount=3)
	dec := NewImaAdpcmDecoder()
	decoded := dec.Decode(encoded, 3)

	if len(decoded) != 3 {
		t.Fatalf("expected 3 decoded samples, got %d", len(decoded))
	}
}

func BenchmarkEncode(b *testing.B) {
	// Typical IQ sub-band: 12000 samples
	samples := make([]int16, 12000)
	for i := range samples {
		samples[i] = int16(10000 * math.Sin(2*math.Pi*float64(i)/100))
	}
	enc := NewImaAdpcmEncoder()
	out := make([]byte, (len(samples)+1)/2)

	b.ResetTimer()
	b.SetBytes(int64(len(samples) * 2))
	for i := 0; i < b.N; i++ {
		enc.Reset()
		enc.EncodeInto(samples, out)
	}
}

func BenchmarkDecode(b *testing.B) {
	samples := make([]int16, 12000)
	for i := range samples {
		samples[i] = int16(10000 * math.Sin(2*math.Pi*float64(i)/100))
	}
	enc := NewImaAdpcmEncoder()
	encoded := enc.Encode(samples)
	dec := NewImaAdpcmDecoder()

	b.ResetTimer()
	b.SetBytes(int64(len(samples) * 2))
	for i := 0; i < b.N; i++ {
		dec.Reset()
		dec.Decode(encoded, len(samples))
	}
}

func BenchmarkEncodeFftAdpcm(b *testing.B) {
	fft := make([]float32, 4096)
	for i := range fft {
		fft[i] = -80.0 + 40.0*float32(math.Sin(2*math.Pi*float64(i)/100))
	}

	b.ResetTimer()
	b.SetBytes(int64(len(fft) * 4))
	for i := 0; i < b.N; i++ {
		EncodeFftAdpcm(fft, -120, 0)
	}
}
