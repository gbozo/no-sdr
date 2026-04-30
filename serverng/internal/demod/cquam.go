package demod

import (
	"math"

	"github.com/gbozo/no-sdr/serverng/internal/dsp"
)

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
	gS1, gS2    float32
	gBlockSize   int
	gSampleCount int
	pilotMag     float32
	lockLevel    float32
}

func NewCquamDemod() *CquamDemod {
	return &CquamDemod{}
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

		// Normalize VCO magnitude to prevent drift
		mag := float32(1.0 / math.Sqrt(float64(newRe*newRe+newIm*newIm)))
		vcoRe = newRe * mag
		vcoIm = newIm * mag

		// C-QUAM decode
		envelope := float32(math.Sqrt(float64(inRe*inRe + inIm*inIm)))
		if envelope < 1e-10 {
			envelope = 1e-10
		}
		cosGamma := mixRe / envelope
		lPlusR := envelope * cosGamma
		lMinusR := mixIm

		left := (lPlusR + lMinusR) * 0.5
		right := (lPlusR - lMinusR) * 0.5

		out[2*i] = left
		out[2*i+1] = right

		// 25Hz Goertzel on L-R signal for pilot detection
		s0 := lMinusR + c.gCoeff*gS1 - gS2
		gS2 = gS1
		gS1 = s0
		gCount++

		if gCount >= c.gBlockSize {
			// Compute magnitude
			power := gS1*gS1 + gS2*gS2 - c.gCoeff*gS1*gS2
			pilotMag = float32(math.Sqrt(float64(math.Abs(float64(power))))) / float32(c.gBlockSize)
			gS1 = 0
			gS2 = 0
			gCount = 0
		}
	}

	c.vcoRe = vcoRe
	c.vcoIm = vcoIm
	c.omega2 = omega2
	c.cosGamma = c.cosGamma // preserve last
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
