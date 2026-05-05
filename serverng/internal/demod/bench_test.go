package demod

import (
	"math"
	"math/rand"
	"testing"

	"github.com/gbozo/no-sdr/serverng/internal/dsp"
)

// generateTestIQ creates complex64 samples simulating an FM-modulated signal.
func generateTestIQ(n int, sampleRate float64, rng *rand.Rand) []complex64 {
	buf := make([]complex64, n)
	phase := 0.0
	modPhase := 0.0
	modFreq := 1000.0   // 1kHz audio tone
	deviation := 75000.0 // FM deviation
	twoPi := 2 * math.Pi

	for i := 0; i < n; i++ {
		modPhase += twoPi * modFreq / sampleRate
		if modPhase > twoPi {
			modPhase -= twoPi
		}
		instantFreq := deviation * math.Sin(modPhase)
		phase += twoPi * instantFreq / sampleRate
		if phase > twoPi {
			phase -= twoPi
		}

		// Signal + noise
		re := float32(math.Cos(phase)) + float32(rng.NormFloat64())*0.01
		im := float32(math.Sin(phase)) + float32(rng.NormFloat64())*0.01
		buf[i] = complex(re, im)
	}
	return buf
}

// BenchmarkFmMonoPipeline benchmarks FM mono demodulation at 48kHz.
func BenchmarkFmMonoPipeline(b *testing.B) {
	const sampleRate = 48000.0
	const blockSize = 960 // 20ms at 48kHz

	demod := NewFmMonoDemod(50e-6) // Europe
	if err := demod.Init(dsp.BlockContext{SampleRate: sampleRate}); err != nil {
		b.Fatal(err)
	}

	rng := rand.New(rand.NewSource(42))
	input := generateTestIQ(blockSize, sampleRate, rng)
	output := make([]float32, blockSize)

	b.SetBytes(int64(blockSize * 8)) // complex64 = 8 bytes
	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		demod.Process(input, output)
	}
}

// BenchmarkFmStereoPipeline benchmarks the complete FM stereo demod
// (48k complex64 input → interleaved float32 L/R output).
func BenchmarkFmStereoPipeline(b *testing.B) {
	const sampleRate = 240000.0 // WFM rate for stereo
	const blockSize = 4800      // 20ms at 240kHz

	demod := NewFmStereoDemod(50e-6) // Europe
	if err := demod.Init(dsp.BlockContext{SampleRate: sampleRate}); err != nil {
		b.Fatal(err)
	}

	rng := rand.New(rand.NewSource(42))
	input := generateTestIQ(blockSize, sampleRate, rng)
	output := make([]float32, blockSize*2) // stereo L/R interleaved

	b.SetBytes(int64(blockSize * 8))
	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		demod.Process(input, output)
	}
}

// BenchmarkAmPipeline benchmarks AM envelope detection at 48kHz.
func BenchmarkAmPipeline(b *testing.B) {
	const sampleRate = 48000.0
	const blockSize = 960 // 20ms

	demod := NewAmDemod()
	if err := demod.Init(dsp.BlockContext{SampleRate: sampleRate}); err != nil {
		b.Fatal(err)
	}

	rng := rand.New(rand.NewSource(42))
	// Generate AM-like IQ: varying magnitude
	input := make([]complex64, blockSize)
	for i := range input {
		mag := 0.5 + 0.3*math.Sin(2*math.Pi*1000*float64(i)/sampleRate)
		phase := 2 * math.Pi * float64(i) * 10000 / sampleRate
		re := float32(mag*math.Cos(phase)) + float32(rng.NormFloat64())*0.01
		im := float32(mag*math.Sin(phase)) + float32(rng.NormFloat64())*0.01
		input[i] = complex(re, im)
	}
	output := make([]float32, blockSize)

	b.SetBytes(int64(blockSize * 8))
	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		demod.Process(input, output)
	}
}

// BenchmarkSsbPipeline benchmarks SSB demodulation (real extraction) at 24kHz.
func BenchmarkSsbPipeline(b *testing.B) {
	const sampleRate = 24000.0
	const blockSize = 480 // 20ms

	demod := NewSsbDemod("usb")
	if err := demod.Init(dsp.BlockContext{SampleRate: sampleRate}); err != nil {
		b.Fatal(err)
	}

	rng := rand.New(rand.NewSource(42))
	input := generateTestIQ(blockSize, sampleRate, rng)
	output := make([]float32, blockSize)

	b.SetBytes(int64(blockSize * 8))
	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		demod.Process(input, output)
	}
}

// BenchmarkDemodPipeline benchmarks a combined IQ extraction + FM demod path
// (simulates the full per-client demodulation flow without Opus encoding).
func BenchmarkDemodPipeline(b *testing.B) {
	const inputRate = 2400000
	const outputRate = 48000
	const tuneOffset = 100000

	ext, err := dsp.NewIqExtractor(dsp.IqExtractorConfig{
		InputSampleRate:  inputRate,
		OutputSampleRate: outputRate,
		TuneOffset:       tuneOffset,
	})
	if err != nil {
		b.Fatal(err)
	}

	demod := NewFmMonoDemod(50e-6)
	if err := demod.Init(dsp.BlockContext{SampleRate: float64(ext.OutputSampleRate())}); err != nil {
		b.Fatal(err)
	}

	// 10ms of raw IQ
	chunkSize := inputRate / 100 * 2
	rng := rand.New(rand.NewSource(42))
	iqData := make([]byte, chunkSize)
	for i := range iqData {
		iqData[i] = byte(rng.Intn(256))
	}

	// Pre-allocate demod output buffer
	maxOutput := outputRate / 100 * 2 // generous
	demodOut := make([]float32, maxOutput)

	b.SetBytes(int64(chunkSize))
	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		subBand := ext.Process(iqData)
		if subBand == nil {
			continue
		}
		// Convert int16 subband to complex64 for demod
		nSamples := len(subBand) / 2
		complexBuf := make([]complex64, nSamples)
		for j := 0; j < nSamples; j++ {
			re := float32(subBand[j*2]) / 32768.0
			im := float32(subBand[j*2+1]) / 32768.0
			complexBuf[j] = complex(re, im)
		}
		demod.Process(complexBuf, demodOut[:nSamples])
	}
}

// BenchmarkRdsDecoder measures the CPU cost of RDS decoding alone.
// Input is a 20ms block of composite audio at 240kHz (4800 float32 samples).
// This is what gets added to the WFM Opus pipeline per 20ms frame.
func BenchmarkRdsDecoder(b *testing.B) {
	const sampleRate = 240000.0
	const blockSize = 4800 // 20ms at 240kHz

	rng := rand.New(rand.NewSource(42))
	// Synthesize realistic composite: noise + pilot at 19kHz + RDS subcarrier at 57kHz
	composite := make([]float32, blockSize)
	for i := range composite {
		t := float64(i) / sampleRate
		pilot := 0.09 * math.Sin(2*math.Pi*19000*t)
		rds := 0.04 * math.Sin(2*math.Pi*57000*t)
		noise := rng.NormFloat64() * 0.02
		composite[i] = float32(pilot + rds + noise)
	}

	dec := NewRdsDecoder(sampleRate)

	b.SetBytes(int64(blockSize * 4)) // float32 = 4 bytes
	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		dec.Process(composite)
	}
}

// BenchmarkFmStereoWithRds measures the combined cost of FmStereoDemod + RDS decoding,
// which is exactly the hot path added to the WFM Opus pipeline.
// Compare to BenchmarkFmStereoPipeline to see the marginal overhead.
func BenchmarkFmStereoWithRds(b *testing.B) {
	const sampleRate = 240000.0
	const blockSize = 4800 // 20ms at 240kHz

	fmDemod := NewFmStereoDemod(50e-6)
	if err := fmDemod.Init(dsp.BlockContext{SampleRate: sampleRate}); err != nil {
		b.Fatal(err)
	}
	rdsDecoder := NewRdsDecoder(sampleRate)

	rng := rand.New(rand.NewSource(42))
	input := generateTestIQ(blockSize, sampleRate, rng)
	output := make([]float32, blockSize*2)

	b.SetBytes(int64(blockSize * 8))
	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		fmDemod.Process(input, output)
		composite := fmDemod.GetComposite()
		rdsDecoder.Process(composite)
	}
}
