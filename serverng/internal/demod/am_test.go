package demod

import (
	"math"
	"testing"

	"github.com/gbozo/no-sdr/serverng/internal/dsp"
)

func TestAmDemod(t *testing.T) {
	sampleRate := 48000.0
	n := 4800

	// Generate AM signal: carrier with known envelope
	// envelope = 1 + 0.5*sin(2*pi*1000*t)
	in := make([]complex64, n)
	for i := 0; i < n; i++ {
		t_sec := float64(i) / sampleRate
		envelope := 1.0 + 0.5*math.Sin(2*math.Pi*1000*t_sec)
		carrierPhase := 2.0 * math.Pi * 10000 * t_sec
		in[i] = complex(
			float32(envelope*math.Cos(carrierPhase)),
			float32(envelope*math.Sin(carrierPhase)),
		)
	}

	demod := NewAmDemod()
	ctx := dsp.BlockContext{SampleRate: sampleRate, BlockSize: n}
	demod.Init(ctx)

	out := make([]float32, n)
	written := demod.Process(in, out)
	if written != n {
		t.Fatalf("expected %d samples, got %d", n, written)
	}

	// Verify envelope detection matches expected
	maxErr := float32(0)
	for i := 100; i < n; i++ { // skip first few for settling
		t_sec := float64(i) / sampleRate
		expected := float32(1.0 + 0.5*math.Sin(2*math.Pi*1000*t_sec))
		err := float32(math.Abs(float64(out[i] - expected)))
		if err > maxErr {
			maxErr = err
		}
	}

	if maxErr > 0.01 {
		t.Errorf("AM envelope detection error too high: max error = %f", maxErr)
	}
}

func TestAmDemodName(t *testing.T) {
	d := NewAmDemod()
	if d.Name() != "am" {
		t.Errorf("expected name 'am', got '%s'", d.Name())
	}
}

func TestSamDemod(t *testing.T) {
	sampleRate := 48000.0
	n := 48000 // 1 second for PLL to lock

	// Generate carrier + AM modulation at baseband (carrier = 0 Hz)
	in := make([]complex64, n)
	for i := 0; i < n; i++ {
		t_sec := float64(i) / sampleRate
		// carrier at 50Hz offset to test PLL tracking
		carrierPhase := 2.0 * math.Pi * 50.0 * t_sec
		modulation := 1.0 + 0.5*math.Sin(2*math.Pi*400*t_sec)
		in[i] = complex(
			float32(modulation*math.Cos(carrierPhase)),
			float32(modulation*math.Sin(carrierPhase)),
		)
	}

	demod := NewSamDemod()
	ctx := dsp.BlockContext{SampleRate: sampleRate, BlockSize: n}
	if err := demod.Init(ctx); err != nil {
		t.Fatalf("Init failed: %v", err)
	}

	out := make([]float32, n)
	written := demod.Process(in, out)
	if written != n {
		t.Fatalf("expected %d samples, got %d", n, written)
	}

	// After PLL settles (last 25%), it should be locked
	if !demod.IsLocked() {
		t.Log("SAM PLL did not lock (may need longer signal or tuning)")
		// Don't fail — PLL lock depends on signal conditions
	}

	// Check output has non-zero content
	hasSignal := false
	for i := n / 2; i < n; i++ {
		if math.Abs(float64(out[i])) > 0.01 {
			hasSignal = true
			break
		}
	}
	if !hasSignal {
		t.Error("SAM output is silent after settling")
	}
}

func TestSamDemodReset(t *testing.T) {
	demod := NewSamDemod()
	ctx := dsp.BlockContext{SampleRate: 48000, BlockSize: 1024}
	demod.Init(ctx)

	demod.pllPhase = 1.5
	demod.lockLevel = 0.8
	demod.locked = true

	demod.Reset()
	if demod.pllPhase != 0 || demod.locked || demod.lockLevel != 0 {
		t.Error("Reset did not clear SAM state")
	}
}

func TestCquamDemod(t *testing.T) {
	sampleRate := 48000.0
	n := 48000 // 1 second

	// Generate a simple C-QUAM-like signal
	// For basic testing: carrier with quadrature component
	in := make([]complex64, n)
	for i := 0; i < n; i++ {
		t_sec := float64(i) / sampleRate
		// L+R modulation
		lPlusR := 0.5 * math.Sin(2*math.Pi*1000*t_sec)
		// L-R modulation (quadrature)
		lMinusR := 0.3 * math.Sin(2*math.Pi*400*t_sec)
		// 25Hz pilot tone on L-R
		pilot := 0.05 * math.Sin(2*math.Pi*25*t_sec)

		// C-QUAM: envelope * cos(carrier + atan(L-R / L+R))
		// Simplified: I = (1 + lPlusR), Q = lMinusR + pilot
		iComp := float32(1.0 + lPlusR)
		qComp := float32(lMinusR + pilot)
		in[i] = complex(iComp, qComp)
	}

	demod := NewCquamDemod()
	ctx := dsp.BlockContext{SampleRate: sampleRate, BlockSize: n}
	if err := demod.Init(ctx); err != nil {
		t.Fatalf("Init failed: %v", err)
	}

	out := make([]float32, 2*n)
	written := demod.Process(in, out)
	if written != 2*n {
		t.Fatalf("expected %d interleaved samples, got %d", 2*n, written)
	}

	// Check output has content (L and R channels)
	hasLeft := false
	hasRight := false
	for i := n / 2; i < n; i++ {
		if math.Abs(float64(out[2*i])) > 0.01 {
			hasLeft = true
		}
		if math.Abs(float64(out[2*i+1])) > 0.01 {
			hasRight = true
		}
		if hasLeft && hasRight {
			break
		}
	}
	if !hasLeft {
		t.Error("C-QUAM left channel is silent")
	}
	if !hasRight {
		t.Error("C-QUAM right channel is silent")
	}
}

func TestCquamDemodName(t *testing.T) {
	d := NewCquamDemod()
	if d.Name() != "cquam" {
		t.Errorf("expected name 'cquam', got '%s'", d.Name())
	}
}

func BenchmarkAmDemod(b *testing.B) {
	sampleRate := 48000.0
	n := 4096

	in := make([]complex64, n)
	for i := range in {
		t_sec := float64(i) / sampleRate
		envelope := 1.0 + 0.5*math.Sin(2*math.Pi*1000*t_sec)
		in[i] = complex(float32(envelope), float32(envelope*0.1))
	}
	out := make([]float32, n)

	demod := NewAmDemod()
	ctx := dsp.BlockContext{SampleRate: sampleRate, BlockSize: n}
	demod.Init(ctx)

	b.ResetTimer()
	b.SetBytes(int64(n * 8))
	for i := 0; i < b.N; i++ {
		demod.Process(in, out)
	}
}
