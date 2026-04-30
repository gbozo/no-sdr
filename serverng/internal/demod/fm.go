package demod

import (
	"math"

	"github.com/gbozo/no-sdr/serverng/internal/dsp"
)

// fastAtan2 is a polynomial approximation of atan2(y, x) matching the TypeScript version.
func fastAtan2(y, x float32) float32 {
	if x == 0 && y == 0 {
		return 0
	}
	ax := float32(math.Abs(float64(x)))
	ay := float32(math.Abs(float64(y)))

	swapped := ax < ay
	var a float32
	if swapped {
		a = ax / ay
	} else {
		a = ay / ax
	}

	s := a * a
	r := ((-0.0464964749*s + 0.15931422)*s - 0.327622764) * s * a
	r += a

	if swapped {
		r = 1.5707963268 - r
	}
	if x < 0 {
		r = 3.1415926536 - r
	}
	if y < 0 {
		r = -r
	}
	return r
}

// ---------- FM Mono ----------

// FmMonoDemod implements wideband FM demodulation using a conjugate-product discriminator
// followed by a first-order IIR de-emphasis filter.
type FmMonoDemod struct {
	sampleRate  float64
	prevI       float32
	prevQ       float32
	deemphAlpha float32
	deemphState float32
	deemphTau   float64 // 50e-6 (Europe/Asia) or 75e-6 (Americas)
}

// NewFmMonoDemod creates a new FM mono demodulator.
// deemphTau is the de-emphasis time constant: 50e-6 for Europe/Asia, 75e-6 for Americas.
func NewFmMonoDemod(deemphTau float64) *FmMonoDemod {
	return &FmMonoDemod{
		deemphTau: deemphTau,
	}
}

func (f *FmMonoDemod) Name() string                            { return "fm_mono" }
func (f *FmMonoDemod) SampleRateOut(inputRate float64) float64 { return inputRate }

func (f *FmMonoDemod) Init(ctx dsp.BlockContext) error {
	f.sampleRate = ctx.SampleRate
	f.deemphAlpha = float32(1.0 - math.Exp(-1.0/(f.sampleRate*f.deemphTau)))
	f.prevI = 0
	f.prevQ = 0
	f.deemphState = 0
	return nil
}

func (f *FmMonoDemod) Process(in []complex64, out []float32) int {
	n := len(in)
	if len(out) < n {
		n = len(out)
	}

	alpha := f.deemphAlpha
	state := f.deemphState
	prevI := f.prevI
	prevQ := f.prevQ

	const invPi = float32(1.0 / math.Pi)

	for i := 0; i < n; i++ {
		// Conjugate product: in[i] * conj(prev)
		curI := real(in[i])
		curQ := imag(in[i])
		conjRe := curI*prevI + curQ*prevQ
		conjIm := curQ*prevI - curI*prevQ

		// FM discriminator
		phase := fastAtan2(conjIm, conjRe)
		sample := phase * invPi // normalize to ±1

		// De-emphasis (1st-order IIR)
		state = alpha*sample + (1-alpha)*state
		out[i] = state

		prevI = curI
		prevQ = curQ
	}

	f.prevI = prevI
	f.prevQ = prevQ
	f.deemphState = state
	return n
}

func (f *FmMonoDemod) Reset() {
	f.prevI = 0
	f.prevQ = 0
	f.deemphState = 0
}

// ---------- FM Stereo ----------

// FmStereoDemod implements FM stereo demodulation with 19kHz PLL pilot detection,
// SNR-proportional stereo blend, and independent L/R de-emphasis.
type FmStereoDemod struct {
	mono       *FmMonoDemod
	sampleRate float64

	// 19kHz PLL for pilot detection
	pllPhase float64
	pllFreq  float64
	pllAlpha float64
	pllBeta  float64

	// Smoothed pilot magnitude
	pilotLevel float32

	// Stereo blend (0.0 = mono, 1.0 = full stereo)
	blendFactor float32
	blendAlpha  float32 // smoothing for blend transitions

	// De-emphasis for L and R
	deemphStateL float32
	deemphStateR float32
	deemphAlpha  float32

	// Composite baseband buffer (reused)
	composite []float32
}

// NewFmStereoDemod creates a new FM stereo demodulator.
func NewFmStereoDemod(deemphTau float64) *FmStereoDemod {
	return &FmStereoDemod{
		mono: NewFmMonoDemod(deemphTau),
	}
}

func (f *FmStereoDemod) Name() string                            { return "fm_stereo" }
func (f *FmStereoDemod) SampleRateOut(inputRate float64) float64 { return inputRate }

func (f *FmStereoDemod) Init(ctx dsp.BlockContext) error {
	f.sampleRate = ctx.SampleRate

	// Init mono demod (we use it without de-emphasis for composite extraction)
	monoCtx := ctx
	f.mono.deemphTau = 1.0 // effectively bypass de-emphasis for composite
	if err := f.mono.Init(monoCtx); err != nil {
		return err
	}
	// Override: mono deemph alpha set to 1 means no filtering, we do deemph ourselves
	f.mono.deemphAlpha = 1.0

	// PLL: 2nd-order loop, BW ~50Hz
	// Loop bandwidth design: omegaN = 2*pi*BW, zeta = 0.707
	bw := 50.0 // Hz
	omegaN := 2.0 * math.Pi * bw / f.sampleRate
	zeta := 0.707
	f.pllAlpha = 2.0 * zeta * omegaN
	f.pllBeta = omegaN * omegaN

	// Initial PLL frequency at 19kHz
	f.pllFreq = 2.0 * math.Pi * 19000.0 / f.sampleRate
	f.pllPhase = 0

	f.pilotLevel = 0
	f.blendFactor = 0
	f.blendAlpha = float32(1.0 - math.Exp(-1.0/(f.sampleRate*0.1))) // 100ms time constant

	// De-emphasis
	deemphTau := f.mono.deemphTau
	if deemphTau == 1.0 {
		deemphTau = 50e-6 // default to Europe
	}
	f.deemphAlpha = float32(1.0 - math.Exp(-1.0 / (f.sampleRate * deemphTau)))
	f.deemphStateL = 0
	f.deemphStateR = 0

	return nil
}

func (f *FmStereoDemod) Process(in []complex64, out []float32) int {
	n := len(in)
	// out must hold 2*n samples (interleaved L, R)
	if len(out) < 2*n {
		n = len(out) / 2
	}

	// Ensure composite buffer
	if cap(f.composite) < n {
		f.composite = make([]float32, n)
	}
	f.composite = f.composite[:n]

	// Step 1: FM discriminator → composite baseband (no de-emphasis)
	f.mono.Process(in, f.composite)

	alpha := f.deemphAlpha
	stateL := f.deemphStateL
	stateR := f.deemphStateR
	pllPhase := f.pllPhase
	pllFreq := f.pllFreq
	pilotLevel := f.pilotLevel
	blendFactor := f.blendFactor
	blendAlpha := f.blendAlpha

	const pilotThreshold float32 = 0.05

	for i := 0; i < n; i++ {
		comp := f.composite[i]

		// Step 2: PLL — track 19kHz pilot
		// Phase detector: sin(2*pllPhase) is actually sin(phase) for pilot
		pilotRef := float32(math.Sin(pllPhase))
		err := float64(comp * pilotRef)
		pllFreq += f.pllBeta * err
		pllPhase += pllFreq + f.pllAlpha*err

		// Keep phase in [0, 2pi)
		if pllPhase > 2*math.Pi {
			pllPhase -= 2 * math.Pi
		} else if pllPhase < 0 {
			pllPhase += 2 * math.Pi
		}

		// Pilot magnitude tracking
		pilotCos := float32(math.Cos(pllPhase))
		pilotMag := float32(math.Abs(float64(comp * pilotCos)))
		pilotLevel = 0.999*pilotLevel + 0.001*pilotMag

		// Step 3: Mix composite with 2× pilot (38kHz) to extract L-R
		// Double the pilot phase → 38kHz reference
		sin38 := float32(math.Sin(2.0 * pllPhase))
		lMinusR := 2.0 * comp * sin38

		// Step 4: L/R matrix
		lPlusR := comp
		left := (lPlusR + lMinusR) * 0.5
		right := (lPlusR - lMinusR) * 0.5

		// Step 5: SNR-proportional blend
		var targetBlend float32
		if pilotLevel > pilotThreshold {
			targetBlend = pilotLevel / (pilotThreshold * 4)
			if targetBlend > 1.0 {
				targetBlend = 1.0
			}
		}
		blendFactor = blendAlpha*targetBlend + (1-blendAlpha)*blendFactor

		// Step 6: Blend stereo↔mono
		mono := comp
		left = blendFactor*left + (1-blendFactor)*mono
		right = blendFactor*right + (1-blendFactor)*mono

		// Step 7: De-emphasis L and R independently
		stateL = alpha*left + (1-alpha)*stateL
		stateR = alpha*right + (1-alpha)*stateR

		out[2*i] = stateL
		out[2*i+1] = stateR
	}

	f.pllPhase = pllPhase
	f.pllFreq = pllFreq
	f.pilotLevel = pilotLevel
	f.blendFactor = blendFactor
	f.deemphStateL = stateL
	f.deemphStateR = stateR

	return 2 * n
}

func (f *FmStereoDemod) Reset() {
	f.mono.Reset()
	f.pllPhase = 0
	f.pllFreq = 2.0 * math.Pi * 19000.0 / f.sampleRate
	f.pilotLevel = 0
	f.blendFactor = 0
	f.deemphStateL = 0
	f.deemphStateR = 0
}

// IsStereo returns true if the pilot tone is detected and blend factor > 0.5.
func (f *FmStereoDemod) IsStereo() bool {
	return f.blendFactor > 0.5
}

// BlendFactor returns the current stereo blend amount (0=mono, 1=stereo).
func (f *FmStereoDemod) BlendFactor() float32 {
	return f.blendFactor
}
