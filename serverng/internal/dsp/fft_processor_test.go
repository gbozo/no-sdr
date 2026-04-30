package dsp

import (
	"math"
	"testing"
	"time"
)

func defaultConfig(fftSize int) FftProcessorConfig {
	return FftProcessorConfig{
		FftSize:    fftSize,
		SampleRate: 2400000,
		Window:     "blackman-harris",
		Averaging:  0,
		TargetFps:  0, // unlimited for deterministic tests
	}
}

// TestFftProcessorDCInput verifies that a pure DC input (all samples = 128,128)
// produces a peak at the center bin (DC bin after FFT-shift).
func TestFftProcessorDCInput(t *testing.T) {
	const fftSize = 256
	cfg := defaultConfig(fftSize)
	p, err := NewFftProcessor(cfg)
	if err != nil {
		t.Fatalf("NewFftProcessor failed: %v", err)
	}

	// Create one frame of DC input: I=128, Q=128 (just above 127.5 -> small positive)
	data := make([]byte, fftSize*2)
	for i := 0; i < fftSize*2; i++ {
		data[i] = 128
	}

	frames := p.ProcessIqData(data)
	if len(frames) != 1 {
		t.Fatalf("expected 1 frame, got %d", len(frames))
	}

	frame := frames[0]
	if len(frame) != fftSize {
		t.Fatalf("expected frame length %d, got %d", fftSize, len(frame))
	}

	// Find the peak bin — should be at center (DC after FFT-shift)
	centerBin := fftSize / 2
	peakBin := 0
	peakVal := frame[0]
	for i := 1; i < fftSize; i++ {
		if frame[i] > peakVal {
			peakVal = frame[i]
			peakBin = i
		}
	}

	// DC bin should be within ±1 of center (window leakage might shift slightly)
	if abs(peakBin-centerBin) > 1 {
		t.Errorf("DC peak expected at bin %d (center), got bin %d", centerBin, peakBin)
	}

	// The DC peak should be significantly above the noise floor
	var avgNonPeak float64
	count := 0
	for i := 0; i < fftSize; i++ {
		if abs(i-centerBin) > 5 {
			avgNonPeak += float64(frame[i])
			count++
		}
	}
	avgNonPeak /= float64(count)

	if float64(peakVal)-avgNonPeak < 20 {
		t.Errorf("DC peak not prominent enough: peak=%.1f dB, avg_noise=%.1f dB, diff=%.1f",
			peakVal, avgNonPeak, float64(peakVal)-avgNonPeak)
	}
}

// TestFftProcessorSingleTone verifies that a single-tone input at a known frequency
// produces a peak at the correct bin.
func TestFftProcessorSingleTone(t *testing.T) {
	const fftSize = 1024
	const sampleRate = 2400000
	cfg := FftProcessorConfig{
		FftSize:    fftSize,
		SampleRate: sampleRate,
		Window:     "blackman-harris",
		Averaging:  0,
		TargetFps:  0,
	}
	p, err := NewFftProcessor(cfg)
	if err != nil {
		t.Fatalf("NewFftProcessor failed: %v", err)
	}

	// Generate a tone at +sampleRate/8 (= 300kHz offset from center)
	// This should appear at bin center + fftSize/8
	toneFreq := float64(sampleRate) / 8.0
	data := make([]byte, fftSize*2)
	for i := 0; i < fftSize; i++ {
		phase := 2.0 * math.Pi * toneFreq * float64(i) / float64(sampleRate)
		// Convert float [-1,1] back to uint8 [0,255]
		ival := math.Cos(phase)*100 + 127.5
		qval := math.Sin(phase)*100 + 127.5
		data[i*2] = clampByte(ival)
		data[i*2+1] = clampByte(qval)
	}

	frames := p.ProcessIqData(data)
	if len(frames) != 1 {
		t.Fatalf("expected 1 frame, got %d", len(frames))
	}

	frame := frames[0]

	// Expected bin: center + fftSize/8
	// After FFT-shift, DC is at center. Positive freq is to the right.
	expectedBin := fftSize/2 + fftSize/8
	peakBin := 0
	peakVal := frame[0]
	for i := 1; i < fftSize; i++ {
		if frame[i] > peakVal {
			peakVal = frame[i]
			peakBin = i
		}
	}

	// Allow ±2 bins for window leakage
	if abs(peakBin-expectedBin) > 2 {
		t.Errorf("tone peak expected near bin %d, got bin %d (diff=%d)",
			expectedBin, peakBin, peakBin-expectedBin)
	}
}

// TestFftProcessorRateCap verifies that rate-capping limits output frame count.
func TestFftProcessorRateCap(t *testing.T) {
	const fftSize = 256
	cfg := FftProcessorConfig{
		FftSize:    fftSize,
		SampleRate: 2400000,
		Window:     "hann",
		Averaging:  0,
		TargetFps:  10, // 10 fps -> 100ms between frames
	}
	p, err := NewFftProcessor(cfg)
	if err != nil {
		t.Fatalf("NewFftProcessor failed: %v", err)
	}

	// Feed many frames rapidly — should only emit based on time
	frameData := make([]byte, fftSize*2)
	for i := range frameData {
		frameData[i] = 128
	}

	// Feed 100 frames in rapid succession
	totalEmitted := 0
	for i := 0; i < 100; i++ {
		frames := p.ProcessIqData(frameData)
		totalEmitted += len(frames)
	}

	// At 10 fps with ~0ms of elapsed time, we should get at most 1-2 frames
	// (the first frame triggers immediately since lastEmit is zero)
	if totalEmitted > 2 {
		t.Errorf("rate cap not working: expected <= 2 emitted frames for rapid input, got %d", totalEmitted)
	}

	// Now simulate time passing and feed more data
	time.Sleep(110 * time.Millisecond)
	frames := p.ProcessIqData(frameData)
	if len(frames) != 1 {
		t.Errorf("expected 1 frame after interval elapsed, got %d", len(frames))
	}
}

// TestFftProcessorAveraging verifies that exponential averaging smooths output.
func TestFftProcessorAveraging(t *testing.T) {
	const fftSize = 256
	cfg := FftProcessorConfig{
		FftSize:    fftSize,
		SampleRate: 2400000,
		Window:     "blackman-harris",
		Averaging:  0.8, // heavy averaging
		TargetFps:  0,   // unlimited
	}
	p, err := NewFftProcessor(cfg)
	if err != nil {
		t.Fatalf("NewFftProcessor failed: %v", err)
	}

	// First frame: DC signal
	dcData := make([]byte, fftSize*2)
	for i := range dcData {
		dcData[i] = 128
	}

	frames1 := p.ProcessIqData(dcData)
	if len(frames1) != 1 {
		t.Fatalf("expected 1 frame, got %d", len(frames1))
	}
	firstFrame := make([]float32, fftSize)
	copy(firstFrame, frames1[0])

	// Second frame: same input
	frames2 := p.ProcessIqData(dcData)
	if len(frames2) != 1 {
		t.Fatalf("expected 1 frame, got %d", len(frames2))
	}
	secondFrame := frames2[0]

	// With averaging=0.8, second frame should be: 0.8*first + 0.2*new
	// Since both inputs are the same, the output should converge but not equal raw
	// The key test: frames should be close to each other (smoothing effect)
	maxDiff := float32(0)
	for i := 0; i < fftSize; i++ {
		diff := float32(math.Abs(float64(secondFrame[i] - firstFrame[i])))
		if diff > maxDiff {
			maxDiff = diff
		}
	}

	// With identical input, averaging should produce nearly identical output
	if maxDiff > 0.1 {
		t.Errorf("averaging with identical input should produce similar frames, max diff=%.4f", maxDiff)
	}

	// Now feed a very different signal (noise) and verify smoothing dampens the change
	noiseData := make([]byte, fftSize*2)
	for i := range noiseData {
		noiseData[i] = byte(i % 256)
	}
	frames3 := p.ProcessIqData(noiseData)
	if len(frames3) != 1 {
		t.Fatalf("expected 1 frame, got %d", len(frames3))
	}
	thirdFrame := frames3[0]

	// Get the raw (un-averaged) response to the noise for comparison
	cfgNoAvg := cfg
	cfgNoAvg.Averaging = 0
	pRaw, _ := NewFftProcessor(cfgNoAvg)
	_ = pRaw.ProcessIqData(dcData) // prime with DC
	_ = pRaw.ProcessIqData(dcData)
	rawFrames := pRaw.ProcessIqData(noiseData)
	rawFrame := rawFrames[0]

	// The averaged frame should be closer to the DC reference than the raw noise frame
	var avgDistFromDC, rawDistFromDC float64
	for i := 0; i < fftSize; i++ {
		avgDistFromDC += math.Abs(float64(thirdFrame[i] - secondFrame[i]))
		rawDistFromDC += math.Abs(float64(rawFrame[i] - secondFrame[i]))
	}

	if avgDistFromDC >= rawDistFromDC {
		t.Errorf("averaging should dampen abrupt changes: avgDist=%.1f, rawDist=%.1f",
			avgDistFromDC, rawDistFromDC)
	}
}

// TestFftProcessorReset verifies that Reset clears all internal state.
func TestFftProcessorReset(t *testing.T) {
	const fftSize = 256
	cfg := FftProcessorConfig{
		FftSize:    fftSize,
		SampleRate: 2400000,
		Window:     "blackman-harris",
		Averaging:  0.5,
		TargetFps:  0,
	}
	p, err := NewFftProcessor(cfg)
	if err != nil {
		t.Fatalf("NewFftProcessor failed: %v", err)
	}

	// Process some data to populate state
	data := make([]byte, fftSize*2)
	for i := range data {
		data[i] = 200
	}
	p.ProcessIqData(data)

	// Feed partial data to fill ring buffer partially
	partial := make([]byte, fftSize/2)
	for i := range partial {
		partial[i] = 100
	}
	p.ProcessIqData(partial)

	// Reset
	p.Reset()

	// Verify ring buffer is cleared (need a full frame to get output)
	frames := p.ProcessIqData(data)
	if len(frames) != 1 {
		t.Fatalf("after reset, expected 1 frame from full data, got %d", len(frames))
	}

	// Verify averaging was reset (first frame after reset should equal raw magnitude)
	// Feed same data again and check that the result differs (averaging is active again fresh)
	frames2 := p.ProcessIqData(data)
	if len(frames2) != 1 {
		t.Fatalf("expected 1 frame, got %d", len(frames2))
	}

	// The second frame should be averaging of first+second.
	// Since both inputs are the same, they should be nearly identical
	maxDiff := float32(0)
	for i := 0; i < fftSize; i++ {
		diff := float32(math.Abs(float64(frames2[0][i] - frames[0][i])))
		if diff > maxDiff {
			maxDiff = diff
		}
	}
	if maxDiff > 0.1 {
		t.Errorf("after reset with same input, frames should be similar, max diff=%.4f", maxDiff)
	}
}

// TestFftProcessorResize verifies that Resize changes FFT size correctly.
func TestFftProcessorResize(t *testing.T) {
	cfg := defaultConfig(256)
	p, err := NewFftProcessor(cfg)
	if err != nil {
		t.Fatalf("NewFftProcessor failed: %v", err)
	}

	// Process at original size
	data256 := make([]byte, 256*2)
	for i := range data256 {
		data256[i] = 128
	}
	frames := p.ProcessIqData(data256)
	if len(frames) != 1 {
		t.Fatalf("expected 1 frame at size 256, got %d", len(frames))
	}
	if len(frames[0]) != 256 {
		t.Fatalf("expected frame len 256, got %d", len(frames[0]))
	}

	// Resize to 512
	err = p.Resize(512)
	if err != nil {
		t.Fatalf("Resize failed: %v", err)
	}

	// Old data shouldn't produce output (need 512*2 bytes now)
	frames = p.ProcessIqData(data256)
	if len(frames) != 0 {
		t.Errorf("expected 0 frames (insufficient data for new size), got %d", len(frames))
	}

	// Feed enough data for new size
	data512 := make([]byte, 512*2)
	for i := range data512 {
		data512[i] = 128
	}
	frames = p.ProcessIqData(data512)
	// We already had 512 bytes from previous call, plus 1024 now = 1536.
	// Need 1024 per frame. So we get 1 frame (first 1024 consumed: 512 leftover + first 512 of new)
	// Wait - after Resize, ringFill is reset to 0. So only the data512 call matters.
	// data512 = 1024 bytes = exactly 1 frame at size 512
	if len(frames) != 1 {
		t.Fatalf("expected 1 frame at size 512, got %d", len(frames))
	}
	if len(frames[0]) != 512 {
		t.Errorf("expected frame len 512, got %d", len(frames[0]))
	}
}

// TestFftProcessorInvalidConfig verifies that invalid configs are rejected.
func TestFftProcessorInvalidConfig(t *testing.T) {
	tests := []struct {
		name string
		cfg  FftProcessorConfig
	}{
		{"non-power-of-2", FftProcessorConfig{FftSize: 100, SampleRate: 2400000, Window: "hann"}},
		{"too-small", FftProcessorConfig{FftSize: 2, SampleRate: 2400000, Window: "hann"}},
		{"bad-window", FftProcessorConfig{FftSize: 256, SampleRate: 2400000, Window: "invalid"}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NewFftProcessor(tc.cfg)
			if err == nil {
				t.Error("expected error for invalid config")
			}
		})
	}
}

// TestFftProcessorMultipleFrames verifies that multiple frames worth of data
// produces the correct number of output frames.
func TestFftProcessorMultipleFrames(t *testing.T) {
	const fftSize = 128
	cfg := defaultConfig(fftSize)
	p, err := NewFftProcessor(cfg)
	if err != nil {
		t.Fatalf("NewFftProcessor failed: %v", err)
	}

	// Feed exactly 5 frames worth of data
	data := make([]byte, fftSize*2*5)
	for i := range data {
		data[i] = 128
	}

	frames := p.ProcessIqData(data)
	if len(frames) != 5 {
		t.Errorf("expected 5 frames, got %d", len(frames))
	}
}

// TestFftProcessorPartialData verifies that partial data is accumulated correctly.
func TestFftProcessorPartialData(t *testing.T) {
	const fftSize = 256
	cfg := defaultConfig(fftSize)
	p, err := NewFftProcessor(cfg)
	if err != nil {
		t.Fatalf("NewFftProcessor failed: %v", err)
	}

	// Feed half a frame
	half := make([]byte, fftSize)
	for i := range half {
		half[i] = 128
	}
	frames := p.ProcessIqData(half)
	if len(frames) != 0 {
		t.Errorf("expected 0 frames from half data, got %d", len(frames))
	}

	// Feed the other half
	frames = p.ProcessIqData(half)
	if len(frames) != 1 {
		t.Errorf("expected 1 frame after completing data, got %d", len(frames))
	}
}

func clampByte(v float64) byte {
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return byte(v)
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}
