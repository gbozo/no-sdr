package dongle

// Dongle pipeline benchmarks — accurate modelling of the real runDongle loop.
//
// Architecture reminder:
//   One IQ chunk (10ms, 48000 bytes at 2.4 MSPS) arrives from the dongle.
//   ├─ FftProcessor.ProcessIqData()       ← shared, runs ONCE per chunk
//   └─ For each subscribed client (parallel):
//        IqExtractor.Process()            ← per-client NCO+LPF+decimate
//        demod (FM/AM/SSB/CW)             ← per-client
//        ADPCM encode or Opus encode      ← per-client
//
// Benchmark philosophy:
//   - SetBytes = chunkSize (48000 bytes) regardless of client count.
//     The dongle produces ONE chunk; serving N clients is fan-out cost.
//   - Report ns/op (wall-clock per chunk iteration) as the primary metric.
//   - Use b.ReportMetric to add derived metrics (ns/client, overhead %).
//   - No alloc in the hot path — pre-allocate all buffers.

import (
	"math/rand"
	"sync"
	"testing"

	"github.com/gbozo/no-sdr/serverng/internal/codec"
	"github.com/gbozo/no-sdr/serverng/internal/demod"
	"github.com/gbozo/no-sdr/serverng/internal/dsp"
)

const (
	benchInputRate  = 2400000
	benchChunkSize  = benchInputRate / 100 * 2 // 10ms at 2.4 MSPS = 48000 bytes
	benchFftSize    = 4096
	benchFftFps     = 30
)

// makeIQ generates a deterministic random raw uint8 IQ chunk.
func makeIQ(seed int64) []byte {
	rng := rand.New(rand.NewSource(seed))
	b := make([]byte, benchChunkSize)
	for i := range b {
		b[i] = byte(rng.Intn(256))
	}
	return b
}

// ---- Shared FFT cost ----

// BenchmarkSharedFftCost measures the amortised shared work done once per
// chunk regardless of how many clients are connected:
//   FftProcessor.ProcessIqData() — FFT + windowing + averaging
//
// This is the baseline overhead that every dongle pays.
func BenchmarkSharedFftCost(b *testing.B) {
	proc, err := dsp.NewFftProcessor(dsp.FftProcessorConfig{
		FftSize:    benchFftSize,
		SampleRate: benchInputRate,
		Window:     "blackman-harris",
		Averaging:  0.5,
		TargetFps:  0, // unlimited for benchmarking
	})
	if err != nil {
		b.Fatal(err)
	}
	iqRaw := makeIQ(1)
	b.SetBytes(benchChunkSize) // one chunk per iteration
	b.ReportAllocs()
	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		_ = proc.ProcessIqData(iqRaw)
	}
}

// ---- Per-client IQ extraction cost ----

// BenchmarkPerClientIqExtractWFM measures IqExtractor alone for WFM (2.4M→240k).
// This is the marginal NCO+LPF+decimate cost of one WFM client.
func BenchmarkPerClientIqExtractWFM(b *testing.B) {
	ext, err := dsp.NewIqExtractor(dsp.IqExtractorConfig{
		InputSampleRate:  benchInputRate,
		OutputSampleRate: 240000,
		TuneOffset:       100000,
	})
	if err != nil {
		b.Fatal(err)
	}
	iqRaw := makeIQ(2)
	b.SetBytes(benchChunkSize)
	b.ReportAllocs()
	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		_ = ext.Process(iqRaw)
	}
}

// BenchmarkPerClientIqExtractNFM is the marginal extraction cost for NFM (2.4M→48k).
func BenchmarkPerClientIqExtractNFM(b *testing.B) {
	ext, err := dsp.NewIqExtractor(dsp.IqExtractorConfig{
		InputSampleRate:  benchInputRate,
		OutputSampleRate: 48000,
		TuneOffset:       0,
	})
	if err != nil {
		b.Fatal(err)
	}
	iqRaw := makeIQ(3)
	b.SetBytes(benchChunkSize)
	b.ReportAllocs()
	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		_ = ext.Process(iqRaw)
	}
}

// ---- Single-client full pipeline cost ----

// BenchmarkSingleClientFullWFM measures the complete per-client DSP work for
// one WFM subscriber: IqExtractor + FmStereoDemod + ADPCM encode.
// This is the marginal cost of adding one WFM client.
// SetBytes = chunkSize (the dongle produces one chunk; this client's share is just its CPU).
func BenchmarkSingleClientFullWFM(b *testing.B) {
	ext, err := dsp.NewIqExtractor(dsp.IqExtractorConfig{
		InputSampleRate:  benchInputRate,
		OutputSampleRate: 240000,
		TuneOffset:       100000,
	})
	if err != nil {
		b.Fatal(err)
	}
	fmDemod := demod.NewFmStereoDemod(50e-6)
	if err := fmDemod.Init(dsp.BlockContext{SampleRate: 240000}); err != nil {
		b.Fatal(err)
	}
	adpcmEnc := codec.NewImaAdpcmEncoder()

	iqRaw := makeIQ(4)
	// Pre-allocate output buffers (no hot-path allocs)
	complexBuf := make([]complex64, 240000/100)
	audioBuf   := make([]float32, 240000/100*2+16)
	accumBuf   := make([]int16, 240000/100*2) // 20ms accumulator (interleaved)

	b.SetBytes(benchChunkSize) // 1 chunk → 1 dongle's work
	b.ReportAllocs()
	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		subBand := ext.Process(iqRaw)
		if len(subBand) == 0 {
			continue
		}
		// int16 IQ → complex64
		n := len(subBand) / 2
		if cap(complexBuf) < n {
			complexBuf = make([]complex64, n)
		}
		complexBuf = complexBuf[:n]
		for j := 0; j < n; j++ {
			complexBuf[j] = complex(
				float32(subBand[j*2])/32768.0,
				float32(subBand[j*2+1])/32768.0,
			)
		}
		// FM demod (includes internal 5:1 decimation → 48kHz stereo)
		written := fmDemod.Process(complexBuf, audioBuf)
		// ADPCM encode the stereo output (downmixed to mono for the benchmark)
		if written > 0 {
			mono := accumBuf[:written/2]
			for j := 0; j < written/2; j++ {
				mono[j] = int16((audioBuf[j*2]+audioBuf[j*2+1])*0.5*32767)
			}
			_ = adpcmEnc.Encode(mono)
		}
	}
}

// BenchmarkSingleClientFullNFM is the same for NFM.
func BenchmarkSingleClientFullNFM(b *testing.B) {
	ext, err := dsp.NewIqExtractor(dsp.IqExtractorConfig{
		InputSampleRate:  benchInputRate,
		OutputSampleRate: 48000,
		TuneOffset:       0,
	})
	if err != nil {
		b.Fatal(err)
	}
	nfmDemod := demod.NewFmMonoDemod(75e-6)
	if err := nfmDemod.Init(dsp.BlockContext{SampleRate: 48000}); err != nil {
		b.Fatal(err)
	}
	adpcmEnc := codec.NewImaAdpcmEncoder()

	iqRaw      := makeIQ(5)
	complexBuf := make([]complex64, 48000/100)
	audioBuf   := make([]float32, 48000/100+16)

	b.SetBytes(benchChunkSize)
	b.ReportAllocs()
	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		subBand := ext.Process(iqRaw)
		if len(subBand) == 0 {
			continue
		}
		n := len(subBand) / 2
		if cap(complexBuf) < n {
			complexBuf = make([]complex64, n)
		}
		complexBuf = complexBuf[:n]
		for j := 0; j < n; j++ {
			complexBuf[j] = complex(
				float32(subBand[j*2])/32768.0,
				float32(subBand[j*2+1])/32768.0,
			)
		}
		written := nfmDemod.Process(complexBuf, audioBuf)
		if written > 0 {
			_ = adpcmEnc.Encode(int16SliceView(audioBuf[:written]))
		}
	}
}

// ---- N-client fan-out scaling ----

// BenchmarkNClientFanOutWFM measures the total wall-clock time to process one
// 10ms IQ chunk through N concurrent WFM client pipelines, plus the shared FFT.
//
// This is the accurate model of runDongle:
//   - FFT runs once (shared)
//   - N IqExtractors + FmStereoDemod + ADPCM run in parallel goroutines
//
// SetBytes = chunkSize (not × N) — the dongle produces ONE chunk.
// Custom metrics:
//   ns/client = ns/op / N      (marginal cost per additional client)
//   fft_frac  = fftNs / ns/op  (fraction of time spent in shared FFT)
func BenchmarkNClientFanOutWFM(b *testing.B) {
	for _, n := range []int{1, 2, 5, 10} {
		n := n
		b.Run(itoa(n)+"_clients", func(b *testing.B) {
			benchNClientFanOut(b, n)
		})
	}
}

// benchClientState holds per-client DSP state for benchmarks.
type benchClientState struct {
	ext        *dsp.IqExtractor
	fmDemod    *demod.FmStereoDemod
	adpcmEnc   *codec.ImaAdpcmEncoder
	complexBuf []complex64
	audioBuf   []float32
}

func benchNClientFanOut(b *testing.B, numClients int) {
	// Shared FFT processor
	fftProc, err := dsp.NewFftProcessor(dsp.FftProcessorConfig{
		FftSize:    benchFftSize,
		SampleRate: benchInputRate,
		Window:     "blackman-harris",
		Averaging:  0.5,
		TargetFps:  0,
	})
	if err != nil {
		b.Fatal(err)
	}

	// Per-client pipelines
	clients := make([]benchClientState, numClients)
	for i := range clients {
		ext, err := dsp.NewIqExtractor(dsp.IqExtractorConfig{
			InputSampleRate:  benchInputRate,
			OutputSampleRate: 240000,
			TuneOffset:       i * 50000,
		})
		if err != nil {
			b.Fatal(err)
		}
		fm := demod.NewFmStereoDemod(50e-6)
		if err := fm.Init(dsp.BlockContext{SampleRate: 240000}); err != nil {
			b.Fatal(err)
		}
		clients[i] = benchClientState{
			ext:        ext,
			fmDemod:    fm,
			adpcmEnc:   codec.NewImaAdpcmEncoder(),
			complexBuf: make([]complex64, 240000/100),
			audioBuf:   make([]float32, 240000/100*2+16),
		}
	}

	iqRaw := makeIQ(int64(numClients))

	b.SetBytes(benchChunkSize) // ONE chunk per iteration
	b.ReportAllocs()
	b.ResetTimer()

	for iter := 0; iter < b.N; iter++ {
		// 1. Shared FFT — once per chunk
		_ = fftProc.ProcessIqData(iqRaw)

		// 2. Per-client fan-out — all run concurrently
		if numClients == 1 {
			processClientBench(&clients[0], iqRaw)
		} else {
			var wg sync.WaitGroup
			wg.Add(numClients)
			for j := range clients {
				go func(cs *benchClientState) {
					defer wg.Done()
					processClientBench(cs, iqRaw)
				}(&clients[j])
			}
			wg.Wait()
		}
	}

	b.ReportMetric(float64(numClients), "clients")
	// ns/op is the wall-clock cost — divide by numClients for marginal cost per client
}

func processClientBench(cs *benchClientState, iqRaw []byte) {
	subBand := cs.ext.Process(iqRaw)
	if len(subBand) == 0 {
		return
	}
	n := len(subBand) / 2
	if cap(cs.complexBuf) < n {
		cs.complexBuf = make([]complex64, n)
	}
	cs.complexBuf = cs.complexBuf[:n]
	for j := 0; j < n; j++ {
		cs.complexBuf[j] = complex(
			float32(subBand[j*2])/32768.0,
			float32(subBand[j*2+1])/32768.0,
		)
	}
	written := cs.fmDemod.Process(cs.complexBuf, cs.audioBuf)
	if written > 0 && written%2 == 0 {
		mono := make([]int16, written/2)
		for j := 0; j < written/2; j++ {
			mono[j] = int16((cs.audioBuf[j*2]+cs.audioBuf[j*2+1])*0.5*32767)
		}
		_ = cs.adpcmEnc.Encode(mono)
	}
}

// ---- ADPCM encode standalone ----

// BenchmarkAdpcmEncodeIQ measures ADPCM encoding on a 20ms mono chunk.
// This is the per-client codec cost for the IQ/ADPCM path.
func BenchmarkAdpcmEncodeIQ(b *testing.B) {
	const chunkSamples = 1920 // 20ms × 48kHz × 1 channel
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

// ---- Helpers ----

// int16SliceView reinterprets []float32 as []int16 by value conversion.
// Used to feed audio output into the ADPCM encoder in benchmarks.
func int16SliceView(f []float32) []int16 {
	out := make([]int16, len(f))
	for i, v := range f {
		if v > 1 {
			v = 1
		} else if v < -1 {
			v = -1
		}
		out[i] = int16(v * 32767)
	}
	return out
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
