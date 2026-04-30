package dsp

import (
	"log/slog"
	"math"
	"testing"
)

func TestButterworth_DCPassthrough(t *testing.T) {
	bw := NewButterworthBlock(10000)
	err := bw.Init(BlockContext{SampleRate: 48000, Logger: slog.Default()})
	if err != nil {
		t.Fatal(err)
	}

	// DC signal (constant 1+0j) should pass through unattenuated after settling
	numSamples := 2048
	in := make([]complex64, numSamples)
	out := make([]complex64, numSamples)
	for i := range in {
		in[i] = complex(1.0, 0.5)
	}

	bw.ProcessComplex(in, out)

	// Check last 100 samples (filter has settled)
	for i := numSamples - 100; i < numSamples; i++ {
		re := float64(real(out[i]))
		im := float64(imag(out[i]))
		if math.Abs(re-1.0) > 0.001 {
			t.Fatalf("sample %d: real expected ~1.0, got %f", i, re)
		}
		if math.Abs(im-0.5) > 0.001 {
			t.Fatalf("sample %d: imag expected ~0.5, got %f", i, im)
		}
	}
}

func TestButterworth_HighFreqAttenuation(t *testing.T) {
	cutoff := 5000.0
	sampleRate := 48000.0
	bw := NewButterworthBlock(cutoff)
	err := bw.Init(BlockContext{SampleRate: sampleRate, Logger: slog.Default()})
	if err != nil {
		t.Fatal(err)
	}

	// Generate a tone at 2× cutoff (10000 Hz) — should be attenuated heavily
	toneHz := cutoff * 2.0
	numSamples := 4096
	in := make([]complex64, numSamples)
	out := make([]complex64, numSamples)

	for i := range in {
		angle := 2.0 * math.Pi * toneHz * float64(i) / sampleRate
		in[i] = complex(float32(math.Cos(angle)), 0)
	}

	bw.ProcessComplex(in, out)

	// Measure RMS of last 1024 samples (after settling)
	var rmsIn, rmsOut float64
	start := numSamples - 1024
	for i := start; i < numSamples; i++ {
		rmsIn += float64(real(in[i])) * float64(real(in[i]))
		rmsOut += float64(real(out[i])) * float64(real(out[i]))
	}
	rmsIn = math.Sqrt(rmsIn / 1024.0)
	rmsOut = math.Sqrt(rmsOut / 1024.0)

	attenuationDB := 20.0 * math.Log10(rmsOut/rmsIn)
	// 4th-order Butterworth at 2× cutoff: -24 dB per octave, at 1 octave above → -24 dB
	// Allow some tolerance
	if attenuationDB > -20.0 {
		t.Fatalf("expected >20dB attenuation at 2× cutoff, got %.1f dB", attenuationDB)
	}
	t.Logf("Attenuation at 2× cutoff: %.1f dB", attenuationDB)
}

func TestButterworth_SetCutoff(t *testing.T) {
	bw := NewButterworthBlock(5000)
	err := bw.Init(BlockContext{SampleRate: 48000, Logger: slog.Default()})
	if err != nil {
		t.Fatal(err)
	}

	origB0 := bw.sections[0].b0
	bw.SetCutoff(10000)

	if bw.sections[0].b0 == origB0 {
		t.Fatal("SetCutoff should change coefficients")
	}
	if bw.cutoffHz != 10000 {
		t.Fatalf("expected cutoffHz=10000, got %f", bw.cutoffHz)
	}
}

func TestButterworth_Reset(t *testing.T) {
	bw := NewButterworthBlock(5000)
	err := bw.Init(BlockContext{SampleRate: 48000, Logger: slog.Default()})
	if err != nil {
		t.Fatal(err)
	}

	// Process some samples to build up state
	in := make([]complex64, 256)
	out := make([]complex64, 256)
	for i := range in {
		in[i] = complex(float32(i), float32(-i))
	}
	bw.ProcessComplex(in, out)

	// Verify state is non-zero
	if bw.stateI[0].z1 == 0 && bw.stateI[0].z2 == 0 {
		t.Fatal("state should be non-zero after processing")
	}

	bw.Reset()

	if bw.stateI[0].z1 != 0 || bw.stateI[0].z2 != 0 ||
		bw.stateI[1].z1 != 0 || bw.stateI[1].z2 != 0 ||
		bw.stateQ[0].z1 != 0 || bw.stateQ[0].z2 != 0 ||
		bw.stateQ[1].z1 != 0 || bw.stateQ[1].z2 != 0 {
		t.Fatal("all state should be zero after Reset")
	}
}

func BenchmarkButterworth(b *testing.B) {
	bw := NewButterworthBlock(100000)
	bw.Init(BlockContext{SampleRate: 2400000, Logger: slog.Default()})

	in := make([]complex64, 65536)
	out := make([]complex64, 65536)
	for i := range in {
		in[i] = complex(float32(i%256)/128.0-1.0, float32((i+64)%256)/128.0-1.0)
	}

	b.SetBytes(int64(len(in)) * 8)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		bw.ProcessComplex(in, out)
	}
}
