package dongle

import (
	"math/rand"
	"sync"
	"testing"

	"github.com/gbozo/no-sdr/serverng/internal/codec"
	"github.com/gbozo/no-sdr/serverng/internal/demod"
	"github.com/gbozo/no-sdr/serverng/internal/dsp"
)

// BenchmarkEndToEndPipeline measures the full per-client DSP pipeline:
// raw uint8 IQ → IqExtractor (NCO + Butterworth + decimate) → FM demod + downmix.
// This covers everything except the final Opus encode (which requires -tags opus).
//
// Run with: go test -bench=BenchmarkEndToEndPipeline -benchmem
func BenchmarkEndToEndPipeline(b *testing.B) {
	const (
		inputRate  = 2400000
		outputRate = 240000 // WFM: 240kHz sub-band
	)

	ext, err := dsp.NewIqExtractor(dsp.IqExtractorConfig{
		InputSampleRate:  inputRate,
		OutputSampleRate: outputRate,
		TuneOffset:       100000,
	})
	if err != nil {
		b.Fatal("IqExtractor:", err)
	}

	// FM stereo demodulator — same as OpusPipeline uses for WFM
	fmDemod := demod.NewFmStereoDemod(50e-6)
	if err := fmDemod.Init(dsp.BlockContext{SampleRate: float64(outputRate)}); err != nil {
		b.Fatal("FmStereoDemod init:", err)
	}

	// 10ms of raw uint8 IQ at 2.4 MSPS
	chunkSize := inputRate / 100 * 2 // 48000 bytes
	rng := rand.New(rand.NewSource(42))
	iqRaw := make([]byte, chunkSize)
	for i := range iqRaw {
		iqRaw[i] = byte(rng.Intn(256))
	}

	audioBuf := make([]float32, outputRate/100*2) // generous stereo output buffer

	b.SetBytes(int64(chunkSize))
	b.ReportAllocs()
	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		subBand := ext.Process(iqRaw)
		if len(subBand) > 0 {
			// Convert int16 to complex64 (same as OpusPipeline.Process step 1)
			nSamples := len(subBand) / 2
			complexBuf := make([]complex64, nSamples)
			for j := 0; j < nSamples; j++ {
				iVal := float32(subBand[j*2]) / 32768.0
				qVal := float32(subBand[j*2+1]) / 32768.0
				complexBuf[j] = complex(iVal, qVal)
			}
			// FM demodulate
			fmDemod.Process(complexBuf, audioBuf)
		}
	}
}

// BenchmarkEndToEndPipelineNFM benchmarks the NFM path (48kHz, mono).
func BenchmarkEndToEndPipelineNFM(b *testing.B) {
	const (
		inputRate  = 2400000
		outputRate = 48000
	)

	ext, err := dsp.NewIqExtractor(dsp.IqExtractorConfig{
		InputSampleRate:  inputRate,
		OutputSampleRate: outputRate,
		TuneOffset:       0,
	})
	if err != nil {
		b.Fatal("IqExtractor:", err)
	}

	nfmDemod := demod.NewFmMonoDemod(75e-6)
	if err := nfmDemod.Init(dsp.BlockContext{SampleRate: float64(outputRate)}); err != nil {
		b.Fatal("FmMonoDemod init:", err)
	}

	chunkSize := inputRate / 100 * 2
	rng := rand.New(rand.NewSource(99))
	iqRaw := make([]byte, chunkSize)
	for i := range iqRaw {
		iqRaw[i] = byte(rng.Intn(256))
	}

	audioBuf := make([]float32, outputRate/100+16)

	b.SetBytes(int64(chunkSize))
	b.ReportAllocs()
	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		subBand := ext.Process(iqRaw)
		if len(subBand) > 0 {
			nSamples := len(subBand) / 2
			complexBuf := make([]complex64, nSamples)
			for j := 0; j < nSamples; j++ {
				iVal := float32(subBand[j*2]) / 32768.0
				qVal := float32(subBand[j*2+1]) / 32768.0
				complexBuf[j] = complex(iVal, qVal)
			}
			nfmDemod.Process(complexBuf, audioBuf)
		}
	}
}

// BenchmarkMultiClientContention measures throughput under N-client load.
// All clients process the same IQ chunk concurrently (matching the real fan-out model).
func BenchmarkMultiClientContention(b *testing.B) {
	for _, numClients := range []int{1, 2, 5, 10} {
		numClients := numClients
		b.Run(itoa(numClients)+"_clients", func(b *testing.B) {
			benchMultiClient(b, numClients)
		})
	}
}

func benchMultiClient(b *testing.B, numClients int) {
	const (
		inputRate  = 2400000
		outputRate = 240000
	)

	type clientPipe struct {
		ext      *dsp.IqExtractor
		fmDemod  *demod.FmStereoDemod
		audioBuf []float32
	}
	clients := make([]clientPipe, numClients)
	for i := range clients {
		ext, err := dsp.NewIqExtractor(dsp.IqExtractorConfig{
			InputSampleRate:  inputRate,
			OutputSampleRate: outputRate,
			TuneOffset:       i * 50000,
		})
		if err != nil {
			b.Fatal(err)
		}
		fm := demod.NewFmStereoDemod(50e-6)
		if err := fm.Init(dsp.BlockContext{SampleRate: float64(outputRate)}); err != nil {
			b.Fatal(err)
		}
		clients[i] = clientPipe{
			ext:      ext,
			fmDemod:  fm,
			audioBuf: make([]float32, outputRate/100*2+16),
		}
	}

	chunkSize := inputRate / 100 * 2
	rng := rand.New(rand.NewSource(7))
	iqRaw := make([]byte, chunkSize)
	for i := range iqRaw {
		iqRaw[i] = byte(rng.Intn(256))
	}

	b.SetBytes(int64(chunkSize) * int64(numClients))
	b.ReportAllocs()
	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		var wg sync.WaitGroup
		wg.Add(numClients)
		for j := range clients {
			go func(cp *clientPipe) {
				defer wg.Done()
				subBand := cp.ext.Process(iqRaw)
				if len(subBand) > 0 {
					nSamples := len(subBand) / 2
					complexBuf := make([]complex64, nSamples)
					for k := 0; k < nSamples; k++ {
						iVal := float32(subBand[k*2]) / 32768.0
						qVal := float32(subBand[k*2+1]) / 32768.0
						complexBuf[k] = complex(iVal, qVal)
					}
					cp.fmDemod.Process(complexBuf, cp.audioBuf)
				}
			}(&clients[j])
		}
		wg.Wait()
	}

	b.ReportMetric(float64(numClients), "clients")
}

// itoa converts a small int to string without importing strconv.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [10]byte
	pos := len(buf)
	for n > 0 {
		pos--
		buf[pos] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[pos:])
}

// BenchmarkAdpcmEncodeIQ measures ADPCM encoding throughput on a 20ms IQ chunk.
// This is the hot path for the IQ codec path (non-Opus clients).
func BenchmarkAdpcmEncodeIQ(b *testing.B) {
	const chunkSamples = 1920
	samples := make([]int16, chunkSamples)
	rng := rand.New(rand.NewSource(13))
	for i := range samples {
		samples[i] = int16(rng.Intn(65536) - 32768)
	}

	enc := codec.NewImaAdpcmEncoder()

	b.SetBytes(int64(chunkSamples * 2))
	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		_ = enc.Encode(samples)
	}
}
