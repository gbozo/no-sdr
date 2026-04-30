// Package dongle provides SDR data sources (hardware and simulated).
package dongle

import (
	"context"
	"math"
	"math/rand"
	"time"
)

// DemoSource generates simulated IQ data for development without hardware.
type DemoSource struct {
	sampleRate int
	signals    []simulatedSignal
	phase      float64
	noiseFloor float64
}

type simulatedSignal struct {
	offsetHz  float64 // offset from center frequency
	amplitude float64 // 0.0 - 1.0
	modType   string  // "carrier", "fm", "am"
	modFreq   float64 // modulation frequency (Hz)
	modPhase  float64 // current modulation phase
}

// DemoConfig configures the demo signal generator.
type DemoConfig struct {
	SampleRate int
	Signals    []SignalConfig
}

// SignalConfig describes a single simulated signal.
type SignalConfig struct {
	OffsetHz  float64
	Amplitude float64
	ModType   string
	ModFreq   float64
}

// NewDemoSource creates a new demo IQ signal generator.
// If cfg.Signals is empty, default signals are used.
func NewDemoSource(cfg DemoConfig) *DemoSource {
	if cfg.SampleRate <= 0 {
		cfg.SampleRate = 2400000
	}

	signals := make([]simulatedSignal, 0, len(cfg.Signals))
	if len(cfg.Signals) == 0 {
		// Default signals: carrier, FM, and weak carrier
		signals = []simulatedSignal{
			{offsetHz: 100000, amplitude: 0.8, modType: "carrier", modFreq: 0},
			{offsetHz: -200000, amplitude: 0.6, modType: "fm", modFreq: 1000},
			{offsetHz: 300000, amplitude: 0.3, modType: "carrier", modFreq: 0},
		}
	} else {
		for _, s := range cfg.Signals {
			signals = append(signals, simulatedSignal{
				offsetHz:  s.OffsetHz,
				amplitude: s.Amplitude,
				modType:   s.ModType,
				modFreq:   s.ModFreq,
			})
		}
	}

	return &DemoSource{
		sampleRate: cfg.SampleRate,
		signals:    signals,
		noiseFloor: 0.02,
	}
}

// Run starts generating IQ data, sending chunks to the output channel.
// Chunks are emitted at real-time rate (matching sample rate).
// Chunks contain uint8 interleaved IQ (I0, Q0, I1, Q1, ...).
// Cancel ctx to stop.
func (d *DemoSource) Run(ctx context.Context, out chan<- []byte) {
	samplesPerChunk := d.sampleRate / 100 // 10ms chunks → 100 chunks/sec
	chunkInterval := 10 * time.Millisecond
	ticker := time.NewTicker(chunkInterval)
	defer ticker.Stop()

	rng := rand.New(rand.NewSource(time.Now().UnixNano()))

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			chunk := d.generateChunk(samplesPerChunk, rng)
			select {
			case out <- chunk:
			case <-ctx.Done():
				return
			}
		}
	}
}

// generateChunk produces one chunk of uint8 interleaved IQ data.
func (d *DemoSource) generateChunk(samples int, rng *rand.Rand) []byte {
	buf := make([]byte, samples*2) // I + Q per sample
	invSR := 1.0 / float64(d.sampleRate)
	twoPi := 2.0 * math.Pi

	for i := 0; i < samples; i++ {
		var sumI, sumQ float64

		for si := range d.signals {
			sig := &d.signals[si]

			switch sig.modType {
			case "fm":
				// FM: phase accumulates with frequency deviation proportional to modulation
				deviation := 75000.0 // FM deviation in Hz (standard broadcast)
				sig.modPhase += twoPi * sig.modFreq * invSR
				if sig.modPhase > twoPi {
					sig.modPhase -= twoPi
				}
				instantFreq := sig.offsetHz + deviation*math.Sin(sig.modPhase)
				d.phase += twoPi * instantFreq * invSR

				sumI += sig.amplitude * math.Cos(d.phase)
				sumQ += sig.amplitude * math.Sin(d.phase)

			case "am":
				// AM: carrier with amplitude modulation
				sig.modPhase += twoPi * sig.modFreq * invSR
				if sig.modPhase > twoPi {
					sig.modPhase -= twoPi
				}
				modDepth := 0.5
				env := 1.0 + modDepth*math.Sin(sig.modPhase)
				phase := twoPi * sig.offsetHz * float64(i) * invSR
				sumI += sig.amplitude * env * math.Cos(phase)
				sumQ += sig.amplitude * env * math.Sin(phase)

			default: // "carrier"
				phase := twoPi * sig.offsetHz * float64(i) * invSR
				sumI += sig.amplitude * math.Cos(phase)
				sumQ += sig.amplitude * math.Sin(phase)
			}
		}

		// Add Gaussian noise
		noiseI := d.noiseFloor * rng.NormFloat64()
		noiseQ := d.noiseFloor * rng.NormFloat64()
		sumI += noiseI
		sumQ += noiseQ

		// Clamp to [-1, 1] and convert to uint8 [0, 255]
		sumI = clamp(sumI, -1.0, 1.0)
		sumQ = clamp(sumQ, -1.0, 1.0)

		buf[i*2] = uint8(127.5 + 127.5*sumI)
		buf[i*2+1] = uint8(127.5 + 127.5*sumQ)
	}

	return buf
}

// SampleRate returns the configured sample rate.
func (d *DemoSource) SampleRate() int {
	return d.sampleRate
}

func clamp(v, min, max float64) float64 {
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}
