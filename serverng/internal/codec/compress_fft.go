package codec

// CompressFft quantizes float32 dB magnitudes to uint8 (0-255).
// Maps [minDb, maxDb] range linearly to [0, 255].
// Values outside the range are clamped.
func CompressFft(fft []float32, minDb, maxDb float32) []byte {
	out := make([]byte, len(fft))
	compressFftInto(fft, minDb, maxDb, out)
	return out
}

// compressFftInto quantizes into a pre-allocated buffer (zero-alloc path).
func compressFftInto(fft []float32, minDb, maxDb float32, out []byte) {
	rangeDb := maxDb - minDb
	if rangeDb <= 0 {
		// Degenerate case: everything maps to 0
		for i := range out {
			out[i] = 0
		}
		return
	}

	scale := 255.0 / float32(rangeDb)
	for i, v := range fft {
		normalized := (v - minDb) * scale
		if normalized < 0 {
			out[i] = 0
		} else if normalized > 255 {
			out[i] = 255
		} else {
			out[i] = byte(normalized + 0.5) // round
		}
	}
}

// DeltaEncode delta-encodes a uint8 slice.
// out[0] = data[0], out[i] = (data[i] - data[i-1]) & 0xFF
// Returns a new slice; the input is not modified.
func DeltaEncode(data []byte) []byte {
	if len(data) == 0 {
		return nil
	}
	out := make([]byte, len(data))
	out[0] = data[0]
	for i := 1; i < len(data); i++ {
		out[i] = data[i] - data[i-1] // uint8 wraps naturally
	}
	return out
}

// DeltaDecode reverses DeltaEncode.
// out[0] = data[0], out[i] = (out[i-1] + data[i]) & 0xFF
func DeltaDecode(data []byte) []byte {
	if len(data) == 0 {
		return nil
	}
	out := make([]byte, len(data))
	out[0] = data[0]
	for i := 1; i < len(data); i++ {
		out[i] = out[i-1] + data[i]
	}
	return out
}
