package dsp

import (
	"math/rand"
	"testing"
)

// BenchmarkFullFFTPipeline simulates the complete FFT path:
// uint8 IQ → FftProcessor → magnitude frames.
// Uses N=65536 with rate cap disabled for pure throughput measurement.
func BenchmarkFullFFTPipeline(b *testing.B) {
	const fftSize = 65536
	const sampleRate = 2400000

	proc, err := NewFftProcessor(FftProcessorConfig{
		FftSize:    fftSize,
		SampleRate: sampleRate,
		Window:     "blackman-harris",
		Averaging:  0.5,
		TargetFps:  0, // unlimited — measure raw throughput
	})
	if err != nil {
		b.Fatal(err)
	}

	// Generate 10ms of random uint8 IQ data
	chunkSize := sampleRate / 100 * 2 // 10ms = 24000 samples × 2 bytes
	rng := rand.New(rand.NewSource(42))
	iqData := make([]byte, chunkSize)
	for i := range iqData {
		iqData[i] = byte(rng.Intn(256))
	}

	b.SetBytes(int64(chunkSize))
	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		_ = proc.ProcessIqData(iqData)
	}
}

// BenchmarkFullFFTPipeline4096 benchmarks with a smaller FFT for comparison.
func BenchmarkFullFFTPipeline4096(b *testing.B) {
	const fftSize = 4096
	const sampleRate = 2400000

	proc, err := NewFftProcessor(FftProcessorConfig{
		FftSize:    fftSize,
		SampleRate: sampleRate,
		Window:     "blackman-harris",
		Averaging:  0.5,
		TargetFps:  0,
	})
	if err != nil {
		b.Fatal(err)
	}

	chunkSize := sampleRate / 100 * 2
	rng := rand.New(rand.NewSource(42))
	iqData := make([]byte, chunkSize)
	for i := range iqData {
		iqData[i] = byte(rng.Intn(256))
	}

	b.SetBytes(int64(chunkSize))
	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		_ = proc.ProcessIqData(iqData)
	}
}

// BenchmarkIqExtractorNFM benchmarks NCO+filter+decimate for NFM (2.4M→48k).
func BenchmarkIqExtractorNFM(b *testing.B) {
	const inputRate = 2400000
	const outputRate = 48000
	const tuneOffset = 100000

	ext, err := NewIqExtractor(IqExtractorConfig{
		InputSampleRate:  inputRate,
		OutputSampleRate: outputRate,
		TuneOffset:       tuneOffset,
	})
	if err != nil {
		b.Fatal(err)
	}

	// 10ms of uint8 IQ data
	chunkSize := inputRate / 100 * 2
	rng := rand.New(rand.NewSource(42))
	iqData := make([]byte, chunkSize)
	for i := range iqData {
		iqData[i] = byte(rng.Intn(256))
	}

	b.SetBytes(int64(chunkSize))
	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		_ = ext.Process(iqData)
	}
}

// BenchmarkIqExtractorWFM benchmarks NCO+filter+decimate for WFM (2.4M→240k).
func BenchmarkIqExtractorWFM(b *testing.B) {
	const inputRate = 2400000
	const outputRate = 240000
	const tuneOffset = -200000

	ext, err := NewIqExtractor(IqExtractorConfig{
		InputSampleRate:  inputRate,
		OutputSampleRate: outputRate,
		TuneOffset:       tuneOffset,
	})
	if err != nil {
		b.Fatal(err)
	}

	// 10ms of uint8 IQ data
	chunkSize := inputRate / 100 * 2
	rng := rand.New(rand.NewSource(42))
	iqData := make([]byte, chunkSize)
	for i := range iqData {
		iqData[i] = byte(rng.Intn(256))
	}

	b.SetBytes(int64(chunkSize))
	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		_ = ext.Process(iqData)
	}
}

// BenchmarkIqExtractorSSB benchmarks NCO+filter+decimate for SSB (2.4M→24k).
func BenchmarkIqExtractorSSB(b *testing.B) {
	const inputRate = 2400000
	const outputRate = 24000
	const tuneOffset = 50000

	ext, err := NewIqExtractor(IqExtractorConfig{
		InputSampleRate:  inputRate,
		OutputSampleRate: outputRate,
		TuneOffset:       tuneOffset,
	})
	if err != nil {
		b.Fatal(err)
	}

	chunkSize := inputRate / 100 * 2
	rng := rand.New(rand.NewSource(42))
	iqData := make([]byte, chunkSize)
	for i := range iqData {
		iqData[i] = byte(rng.Intn(256))
	}

	b.SetBytes(int64(chunkSize))
	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		_ = ext.Process(iqData)
	}
}
