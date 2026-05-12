package demod

import (
	"math"

	"github.com/gbozo/no-sdr/serverng/internal/dsp"
)

// invSqrt32 computes an approximation of 1/sqrt(x) for float32.
// Uses the classic bit-hack (Quake/Doom fast inverse square root) with one
// Newton-Raphson refinement iteration, giving ~0.175% relative error.
// This is sufficient for VCO phasor renormalization in the C-QUAM PLL —
// the PLL corrects any residual magnitude error within a few samples.
//
// On modern amd64 this avoids SQRTSD+DIVSD in the per-sample hot path.
// math.Float32bits/Float32frombits provide type-safe bit reinterpretation.
func invSqrt32(x float32) float32 {
	i := math.Float32bits(x)
	i = 0x5f3759df - (i >> 1)
	y := math.Float32frombits(i)
	// One Newton-Raphson refinement: y = y * (1.5 - 0.5*x*y*y)
	y = y * (1.5 - 0.5*x*y*y)
	return y
}

// sqrtMag32 computes sqrt(re²+im²) for a complex64 sample.
func sqrtMag32(re, im float32) float32 {
	return float32(math.Sqrt(float64(re*re + im*im)))
}

// CquamDemod implements Motorola C-QUAM AM Stereo demodulation.
// It uses a PLL for carrier recovery and Goertzel-based 25Hz pilot detection.
// Output is interleaved L, R float32 samples.
type CquamDemod struct {
	sampleRate float64

	// PLL VCO state (complex)
	vcoRe, vcoIm float32
	omega2       float32 // VCO frequency accumulator
	alpha, beta  float32 // PLL loop gains

	// cos(gamma) from C-QUAM decode
	cosGamma float32

	// 25Hz Goertzel pilot detection
	gCoeff       float32
	gS1, gS2     float32
	gBlockSize   int
	gSampleCount int
	pilotMag     float32
	lockLevel    float32

	// DC blocking filter per channel: y = x - x_prev + 0.995 * y_prev
	dcPrevL, dcPrevOutL float32
	dcPrevR, dcPrevOutR float32

	// AGC per channel (same params as AmDemod: target=0.3)
	agcGainL, agcGainR float32
	agcTarget          float32
	agcAttack          float32
	agcDecay           float32
	agcMax             float32

	// Audio LPF per channel (post-AGC, bandwidth-limiting)
	audioLpfL       *simpleFir
	audioLpfR       *simpleFir
	audioLpfEnabled bool
}

func NewCquamDemod() *CquamDemod {
	return &CquamDemod{
		agcGainL:  1.0,
		agcGainR:  1.0,
		agcTarget: 0.3,
		agcAttack: 0.01,
		agcDecay:  0.0001,
		agcMax:    100.0,
	}
}

func (c *CquamDemod) Name() string                            { return "cquam" }
func (c *CquamDemod) SampleRateOut(inputRate float64) float64 { return inputRate }

func (c *CquamDemod) Init(ctx dsp.BlockContext) error {
	c.sampleRate = ctx.SampleRate

	// PLL: 2nd-order, zeta=0.707, omegaN=100 rad/s
	omegaN := 100.0 / c.sampleRate
	zeta := 0.707
	c.alpha = float32(2.0 * zeta * omegaN)
	c.beta = float32(omegaN * omegaN)

	// Initialize VCO at unity magnitude, zero phase
	c.vcoRe = 1.0
	c.vcoIm = 0.0
	c.omega2 = 0

	c.cosGamma = 1.0

	// 25Hz Goertzel: block size for ~25Hz resolution
	// Block size = sampleRate / targetFreq for one full cycle detection
	c.gBlockSize = int(c.sampleRate / 25.0)
	if c.gBlockSize < 64 {
		c.gBlockSize = 64
	}
	// Goertzel coefficient for 25Hz
	k := 25.0 * float64(c.gBlockSize) / c.sampleRate
	c.gCoeff = float32(2.0 * math.Cos(2.0*math.Pi*k/float64(c.gBlockSize)))
	c.gS1 = 0
	c.gS2 = 0
	c.gSampleCount = 0
	c.pilotMag = 0
	c.lockLevel = 0

	// DC blockers
	c.dcPrevL = 0
	c.dcPrevOutL = 0
	c.dcPrevR = 0
	c.dcPrevOutR = 0

	// AGC
	c.agcGainL = 1.0
	c.agcGainR = 1.0

	return nil
}

func (c *CquamDemod) Process(in []complex64, out []float32) int {
	n := len(in)
	if len(out) < 2*n {
		n = len(out) / 2
	}

	vcoRe := c.vcoRe
	vcoIm := c.vcoIm
	omega2 := c.omega2
	alpha := c.alpha
	beta := c.beta
	gS1 := c.gS1
	gS2 := c.gS2
	gCount := c.gSampleCount
	pilotMag := c.pilotMag

	// DC blocker state
	dcPrevL := c.dcPrevL
	dcPrevOutL := c.dcPrevOutL
	dcPrevR := c.dcPrevR
	dcPrevOutR := c.dcPrevOutR

	// AGC state
	gainL := c.agcGainL
	gainR := c.agcGainR
	target := c.agcTarget
	attack := c.agcAttack
	decay := c.agcDecay
	maxGain := c.agcMax

	for i := 0; i < n; i++ {
		inRe := real(in[i])
		inIm := imag(in[i])

		// PLL: mix input with VCO (complex conjugate multiply)
		mixRe := inRe*vcoRe + inIm*vcoIm
		mixIm := -inRe*vcoIm + inIm*vcoRe

		// Phase error (approximation for small angles, full atan2 for robustness)
		err := fastAtan2(mixIm, mixRe)

		// Loop filter
		omega2 += beta * err
		phaseDelta := omega2 + alpha*err

		// Update VCO: rotate by phaseDelta
		cosD := float32(math.Cos(float64(phaseDelta)))
		sinD := float32(math.Sin(float64(phaseDelta)))
		newRe := vcoRe*cosD - vcoIm*sinD
		newIm := vcoRe*sinD + vcoIm*cosD

		// Normalize VCO magnitude to prevent drift.

		mag := invSqrt32(newRe*newRe + newIm*newIm)
		vcoRe = newRe * mag
		vcoIm = newIm * mag

		// C-QUAM decode
		envelope := sqrtMag32(inRe, inIm)
		if envelope < 1e-10 {
			envelope = 1e-10
		}
		cosGamma := mixRe / envelope
		lPlusR := envelope * cosGamma
		lMinusR := mixIm

		left := (lPlusR + lMinusR) * 0.5
		right := (lPlusR - lMinusR) * 0.5

		// DC block L: y = x - x_prev + 0.995*y_prev
		dcOutL := left - dcPrevL + 0.995*dcPrevOutL
		dcPrevL = left
		dcPrevOutL = dcOutL

		// DC block R: y = x - x_prev + 0.995*y_prev
		dcOutR := right - dcPrevR + 0.995*dcPrevOutR
		dcPrevR = right
		dcPrevOutR = dcOutR

		// AGC L
		absL := dcOutL * gainL
		if absL < 0 {
			absL = -absL
		}
		if absL > target {
			gainL *= (1 - attack)
		} else {
			gainL *= (1 + decay)
		}
		if gainL > maxGain {
			gainL = maxGain
		} else if gainL < 0.001 {
			gainL = 0.001
		}

		// AGC R
		absR := dcOutR * gainR
		if absR < 0 {
			absR = -absR
		}
		if absR > target {
			gainR *= (1 - attack)
		} else {
			gainR *= (1 + decay)
		}
		if gainR > maxGain {
			gainR = maxGain
		} else if gainR < 0.001 {
			gainR = 0.001
		}

		out[2*i] = dcOutL * gainL
		out[2*i+1] = dcOutR * gainR

		// 25Hz Goertzel on L-R signal for pilot detection
		s0 := lMinusR + c.gCoeff*gS1 - gS2
		gS2 = gS1
		gS1 = s0
		gCount++

		if gCount >= c.gBlockSize {
			// Compute magnitude from Goertzel power output.
			power := gS1*gS1 + gS2*gS2 - c.gCoeff*gS1*gS2
			if power < 0 {
				power = -power
			}
			pilotMag = float32(math.Sqrt(float64(power))) / float32(c.gBlockSize)
			gS1 = 0
			gS2 = 0
			gCount = 0
		}
	}

	c.vcoRe = vcoRe
	c.vcoIm = vcoIm
	c.omega2 = omega2

	c.gS1 = gS1
	c.gS2 = gS2
	c.gSampleCount = gCount
	c.pilotMag = pilotMag

	// Lock level based on pilot magnitude
	const lockThreshold float32 = 0.01
	if pilotMag > lockThreshold {
		c.lockLevel = 0.99*c.lockLevel + 0.01
	} else {
		c.lockLevel = 0.99 * c.lockLevel
	}

	return 2 * n
}

func (c *CquamDemod) Reset() {
	c.vcoRe = 1.0
	c.vcoIm = 0.0
	c.omega2 = 0
	c.cosGamma = 1.0
	c.gS1 = 0
	c.gS2 = 0
	c.gSampleCount = 0
	c.pilotMag = 0
	c.lockLevel = 0
}

// IsLocked returns true if the C-QUAM 25Hz pilot tone has been detected.
func (c *CquamDemod) IsLocked() bool {
	return c.lockLevel > 0.5
}
