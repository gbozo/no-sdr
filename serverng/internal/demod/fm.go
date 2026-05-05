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
// followed by a first-order IIR de-emphasis filter and an optional post-deemph audio LPF.
type FmMonoDemod struct {
	sampleRate  float64
	prevI       float32
	prevQ       float32
	gain        float32 // = sampleRate / (2π * deviation), set in Init
	deemphAlpha float32
	deemphState float32
	deemphTau   float64 // 50e-6 (Europe/Asia) or 75e-6 (Americas)
	deviation   float64 // FM deviation in Hz: 75000 for WFM, 5000 for NFM

	// Post-deemph audio LPF (NFM bandwidth limiting).
	// Enabled by SetBandwidth; for WFM the 15kHz FIR in FmStereoDemod takes this role.
	audioLpf        *simpleFir
	audioLpfEnabled bool
	audioLpfCutoff  float64 // normalised (0..0.5) — stored so Init can restore it
}

// NewFmMonoDemod creates a new FM mono demodulator.
// deemphTau is the de-emphasis time constant: 50e-6 for Europe/Asia, 75e-6 for Americas.
// deviation is the FM frequency deviation in Hz: 75000 for WFM, 5000 for NFM.
func NewFmMonoDemod(deemphTau float64) *FmMonoDemod {
	return &FmMonoDemod{
		deemphTau: deemphTau,
		deviation: 5000, // default NFM deviation
	}
}

// NewFmMonoDemodWithDeviation creates a FM mono demodulator with explicit deviation.
func NewFmMonoDemodWithDeviation(deemphTau, deviation float64) *FmMonoDemod {
	return &FmMonoDemod{
		deemphTau: deemphTau,
		deviation: deviation,
	}
}

func (f *FmMonoDemod) Name() string                            { return "fm_mono" }
func (f *FmMonoDemod) SampleRateOut(inputRate float64) float64 { return inputRate }

func (f *FmMonoDemod) Init(ctx dsp.BlockContext) error {
	f.sampleRate = ctx.SampleRate
	// Gain: normalize so that full deviation = ±1.0 output
	// gain = sampleRate / (2π * deviation)
	if f.deviation <= 0 {
		f.deviation = 5000
	}
	f.gain = float32(f.sampleRate / (2.0 * math.Pi * f.deviation))
	f.deemphAlpha = float32(1.0 - math.Exp(-1.0/(f.sampleRate*f.deemphTau)))
	f.prevI = 0
	f.prevQ = 0
	f.deemphState = 0

	// Rebuild audio LPF at the actual sample rate if it was pre-configured.
	if f.audioLpfEnabled && f.audioLpfCutoff > 0 {
		// audioLpfCutoff may have been stored normalised to 48kHz — recompute.
		// Re-derive cutoffHz from what SetBandwidth stored.
		// We stored norm = cutoffHz / sampleRate_at_call_time.
		// If sampleRate changed, recalculate norm at current rate.
		// Simplest: keep cutoffHz = norm * 48000 if Init wasn't called before,
		// or norm * f.sampleRate if it was. We store norm always, so:
		norm := f.audioLpfCutoff // already normalised at whatever rate was active
		// Re-derive absolute Hz then re-normalise at current rate.
		// Since we always store norm * sampleRate_of_SetBandwidth call,
		// just trust the stored cutoff — it's already 0..0.5.
		if norm < 0.5 {
			if f.audioLpf == nil {
				f.audioLpf = newSimpleFir(31, norm)
			} else {
				f.audioLpf.design(norm, 31)
				f.audioLpf.reset()
			}
		} else {
			f.audioLpfEnabled = false
		}
	}

	return nil
}

func (f *FmMonoDemod) Process(in []complex64, out []float32) int {
	n := len(in)
	if len(out) < n {
		n = len(out)
	}

	gain := f.gain
	alpha := f.deemphAlpha
	state := f.deemphState
	prevI := f.prevI
	prevQ := f.prevQ

	for i := 0; i < n; i++ {
		// Conjugate product: in[i] * conj(prev)
		curI := real(in[i])
		curQ := imag(in[i])
		conjRe := curI*prevI + curQ*prevQ
		conjIm := curQ*prevI - curI*prevQ

		// FM discriminator: scaled by gain so full deviation → ±1
		phase := fastAtan2(conjIm, conjRe)
		sample := phase * gain

		// De-emphasis (1st-order IIR)
		state = alpha*sample + (1-alpha)*state
		out[i] = state

		prevI = curI
		prevQ = curQ
	}

	f.prevI = prevI
	f.prevQ = prevQ
	f.deemphState = state

	// Apply post-deemph audio LPF if enabled (NFM bandwidth limiting)
	if f.audioLpfEnabled && f.audioLpf != nil {
		for i := 0; i < n; i++ {
			out[i] = f.audioLpf.process(out[i])
		}
	}

	return n
}

func (f *FmMonoDemod) Reset() {
	f.prevI = 0
	f.prevQ = 0
	f.deemphState = 0
	if f.audioLpf != nil {
		f.audioLpf.reset()
	}
}

// SetBandwidth applies a post-deemph audio low-pass filter.
// For NFM: cutoff = min(hz/2, 4000) Hz (matches Node.js FmDemodulator.setBandwidth).
// For WFM (FmStereoDemod wraps this): call is a no-op because deemphTau==1 and
// deviation==75000; the 15kHz FIR in FmStereoDemod handles filtering instead.
func (f *FmMonoDemod) SetBandwidth(hz float64) {
	if hz <= 0 {
		f.audioLpfEnabled = false
		return
	}
	cutoffHz := hz / 2.0
	if cutoffHz > 4000 {
		cutoffHz = 4000
	}
	if f.sampleRate <= 0 {
		// Not yet initialised — store for Init to pick up
		f.audioLpfCutoff = cutoffHz / 48000.0 // assume 48kHz until Init
		f.audioLpfEnabled = true
		return
	}
	norm := cutoffHz / f.sampleRate
	if norm >= 0.5 {
		f.audioLpfEnabled = false
		return
	}
	f.audioLpfCutoff = norm
	if f.audioLpf == nil {
		f.audioLpf = newSimpleFir(31, norm)
	} else {
		f.audioLpf.design(norm, 31)
		f.audioLpf.reset()
	}
	f.audioLpfEnabled = true
}

// ---------- FM Stereo ----------

// simpleFir is a 51-tap FIR lowpass (sinc + Blackman-Harris window),
// matching the Node.js SimpleFir class used in FmStereoDemod.
// Power-of-2 circular buffer for fast modular indexing.
type simpleFir struct {
	taps    []float32
	buf     []float32
	pos     int
	bufMask int
}

// newSimpleFir creates a lowpass FIR with numTaps taps and cutoff in normalised
// frequency (0..0.5). Blackman-Harris window gives >90 dB stopband attenuation.
func newSimpleFir(numTaps int, cutoff float64) *simpleFir {
	// Round buffer up to next power-of-2 for bitwise-AND wrapping.
	bufSize := 1
	for bufSize < numTaps {
		bufSize <<= 1
	}
	f := &simpleFir{
		taps:    make([]float32, numTaps),
		buf:     make([]float32, bufSize),
		bufMask: bufSize - 1,
	}
	f.design(cutoff, numTaps)
	return f
}

func (f *simpleFir) design(cutoff float64, n int) {
	m := float64(n-1) / 2.0
	var sum float64
	for i := 0; i < n; i++ {
		x := float64(i) - m
		var sinc float64
		if math.Abs(x) < 1e-12 {
			sinc = 2 * math.Pi * cutoff
		} else {
			sinc = math.Sin(2*math.Pi*cutoff*x) / x
		}
		// Blackman-Harris window
		fi := float64(i)
		fn := float64(n - 1)
		w := 0.35875 -
			0.48829*math.Cos(2*math.Pi*fi/fn) +
			0.14128*math.Cos(4*math.Pi*fi/fn) -
			0.01168*math.Cos(6*math.Pi*fi/fn)
		f.taps[i] = float32(sinc * w)
		sum += float64(f.taps[i])
	}
	for i := range f.taps {
		f.taps[i] = float32(float64(f.taps[i]) / sum)
	}
}

func (f *simpleFir) process(x float32) float32 {
	f.buf[f.pos] = x
	var acc float32
	idx := f.pos
	for _, tap := range f.taps {
		acc += tap * f.buf[idx]
		idx = (idx - 1) & f.bufMask
	}
	f.pos = (f.pos + 1) & f.bufMask
	return acc
}

// processBatch filters an input slice into out in a single call, allowing
// the compiler to vectorize the inner MAC loop across the tap array.
// len(out) must be >= len(in).
func (f *simpleFir) processBatch(in, out []float32) {
	taps := f.taps
	buf := f.buf
	mask := f.bufMask
	pos := f.pos
	for i, x := range in {
		buf[pos] = x
		var acc float32
		idx := pos
		for _, tap := range taps {
			acc += tap * buf[idx]
			idx = (idx - 1) & mask
		}
		out[i] = acc
		pos = (pos + 1) & mask
	}
	f.pos = pos
}

func (f *simpleFir) reset() {
	for i := range f.buf {
		f.buf[i] = 0
	}
	f.pos = 0
}

// FmStereoDemod implements FM stereo demodulation with 19kHz PLL pilot detection,
// SNR-proportional stereo blend, and independent L/R de-emphasis.
// Decimation from 240kHz to 48kHz is performed inside the demod (matching Node.js).
type FmStereoDemod struct {
	mono       *FmMonoDemod
	sampleRate float64

	// Output decimation (240k→48k inside the demod, matching Node.js FmStereoDemod)
	decimFactor  int
	decimCounter int

	// 19kHz PLL for pilot detection.
	// pllSin/pllCos is the running phasor (sin φ, cos φ).
	// pllFreq is the VCO frequency in rad/sample.
	// We use an incremental phasor instead of calling math.Sin/Cos every sample:
	// each step rotates (pllSin, pllCos) by Δω using a 5th-order Taylor polynomial
	// for sin/cos, then renorms every pllRenormInterval samples to prevent drift.
	pllSin   float64
	pllCos   float64
	pllFreq  float64
	pllAlpha float64
	pllBeta  float64

	// pllPhase is the accumulated phase, kept only for Reset() to restore the
	// phasor to a consistent state without calling Init() again.
	pllPhase float64

	// Renormalisation counter for the running phasor.
	pllRenormCount int

	// Pilot BPF + energy estimator (SNR-based blend)
	pilotEnergy float32
	noiseEnergy float32
	energyAlpha float32

	// Hold counter (like Node.js holdCounter / holdSamples)
	pilotDetected bool
	holdCounter   int
	holdSamples   int

	// Stereo blend (0.0 = mono, 1.0 = full stereo)
	blendFactor float32

	// De-emphasis for L and R (tau = 75e-6, matching Node.js)
	deemphStateL float32
	deemphStateR float32
	deemphAlpha  float32

	// 51-tap FIR LPF at 15kHz for L+R and L-R — matches Node.js SimpleFir.
	// Provides >90 dB stopband → removes 19kHz pilot and 38kHz harmonics.
	lprFir *simpleFir
	lrFir  *simpleFir

	// DC block after decimation (matching Node.js dcL/dcR)
	dcPrevL    float32
	dcOutPrevL float32
	dcPrevR    float32
	dcOutPrevR float32

	// Composite baseband buffer (reused)
	composite []float32

	// Scratch buffers for batch FIR input/output
	lprInBuf  []float32
	lrInBuf   []float32
	lprOutBuf []float32
	lrOutBuf  []float32

	// Per-sample blend state for pass 2
	blendBuf []float32

	// Pre-allocated L/R output for the decimated frames
	leftOut  []float32
	rightOut []float32
}

// pllRenormInterval is the number of samples between phasor renormalisations.
// Drift at double precision is negligible over 1000 samples.
const pllRenormInterval = 1000

// sinCos5 computes sin(x) and cos(x) using 5th-order Taylor polynomials.
// Accurate to < 2×10⁻⁵ for |x| ≤ 0.6 rad (the max PLL step at 240kHz).
// Replaces math.Sin/math.Cos in the per-sample PLL inner loop.
func sinCos5(x float64) (s, c float64) {
	x2 := x * x
	x3 := x2 * x
	x4 := x2 * x2
	x5 := x4 * x
	s = x - x3/6.0 + x5/120.0
	c = 1.0 - x2/2.0 + x4/24.0
	return
}

// NewFmStereoDemod creates a new FM stereo demodulator.
func NewFmStereoDemod(deemphTau float64) *FmStereoDemod {
	return &FmStereoDemod{
		// WFM deviation is 75kHz — the mono sub-demod is used for composite extraction,
		// so it must use the WFM deviation for correct gain scaling.
		mono: NewFmMonoDemodWithDeviation(deemphTau, 75000),
	}
}

func (f *FmStereoDemod) Name() string                            { return "fm_stereo" }
func (f *FmStereoDemod) SampleRateOut(inputRate float64) float64 { return 48000 }

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

	// Output decimation: 240kHz → 48kHz = factor 5 (same as Node.js)
	f.decimFactor = int(math.Round(f.sampleRate / 48000.0))
	if f.decimFactor < 1 {
		f.decimFactor = 1
	}
	f.decimCounter = 0

	// PLL: 2nd-order loop at 19kHz, BW ~50Hz, damping=0.707 (matching Node.js)
	bw := 50.0 // Hz
	damp := 0.707
	f.pllAlpha = 2.0 * damp * bw * 2.0 * math.Pi / f.sampleRate
	f.pllBeta = math.Pow(bw*2.0*math.Pi/f.sampleRate, 2)

	// Initial PLL frequency at 19kHz; phasor starts at phase=0 (sin=0, cos=1)
	f.pllFreq = 2.0 * math.Pi * 19000.0 / f.sampleRate
	f.pllPhase = 0
	f.pllSin = 0
	f.pllCos = 1
	f.pllRenormCount = 0

	// Pilot detection (energy-based SNR, matching Node.js)
	f.energyAlpha = 0.002
	f.pilotEnergy = 0
	f.noiseEnergy = 0
	f.pilotDetected = false
	f.holdSamples = int(math.Round(f.sampleRate * 0.2))
	f.holdCounter = 0
	f.blendFactor = 0

	// 51-tap FIR LPF at 15kHz / sampleRate.
	// Provides >90 dB stopband to remove 19kHz pilot leakage into audio.
	cutoff := 15000.0 / f.sampleRate
	f.lprFir = newSimpleFir(51, cutoff)
	f.lrFir = newSimpleFir(51, cutoff)

	// De-emphasis: 75e-6 (Americas, matching Node.js Deemph(75e-6, inputRate))
	// Override any deemphTau passed in — Node.js always uses 75e-6 for WFM stereo.
	const wfmDeemphTau = 75e-6
	f.deemphAlpha = float32(1.0 - math.Exp(-1.0/(f.sampleRate*wfmDeemphTau)))
	f.deemphStateL = 0
	f.deemphStateR = 0

	// DC block state
	f.dcPrevL = 0
	f.dcOutPrevL = 0
	f.dcPrevR = 0
	f.dcOutPrevR = 0

	return nil
}

func (f *FmStereoDemod) Process(in []complex64, out []float32) int {
	n := len(in)

	// Ensure composite buffer
	if cap(f.composite) < n {
		f.composite = make([]float32, n)
	}
	f.composite = f.composite[:n]

	// Step 1: FM discriminator → composite baseband (no de-emphasis, gain=75kHz)
	f.mono.Process(in, f.composite)

	// Pre-allocate L/R output for the decimated frames (at most n/decimFactor)
	maxOut := (n + f.decimFactor - 1) / f.decimFactor
	if cap(f.leftOut) < maxOut {
		f.leftOut = make([]float32, maxOut)
		f.rightOut = make([]float32, maxOut)
	}
	f.leftOut = f.leftOut[:maxOut]
	f.rightOut = f.rightOut[:maxOut]

	// Grow FIR scratch buffers
	if cap(f.lprInBuf) < n {
		f.lprInBuf = make([]float32, n)
		f.lrInBuf = make([]float32, n)
		f.lprOutBuf = make([]float32, n)
		f.lrOutBuf = make([]float32, n)
		f.blendBuf = make([]float32, n)
	}
	lprIn := f.lprInBuf[:n]
	lrIn := f.lrInBuf[:n]
	lprOut := f.lprOutBuf[:n]
	lrOut := f.lrOutBuf[:n]
	blends := f.blendBuf[:n]

	// ---- Pass 1: PLL + build FIR inputs ----
	pllSin := f.pllSin
	pllCos := f.pllCos
	pllFreq := f.pllFreq
	pilotEnergy := f.pilotEnergy
	noiseEnergy := f.noiseEnergy
	energyAlpha := f.energyAlpha
	blendFactor := f.blendFactor
	pilotDetected := f.pilotDetected
	holdCounter := f.holdCounter
	renormCount := f.pllRenormCount

	for i := 0; i < n; i++ {
		comp := f.composite[i]

		pilotRef := float32(pllSin)
		phaseErr := float64(comp * pilotRef)
		pllFreq += f.pllBeta * phaseErr

		dw := f.pllAlpha*phaseErr + pllFreq
		sinDw, cosDw := sinCos5(dw)
		pllSin, pllCos = pllSin*cosDw+pllCos*sinDw, pllCos*cosDw-pllSin*sinDw

		renormCount++
		if renormCount >= pllRenormInterval {
			norm := 1.0 / math.Sqrt(pllSin*pllSin+pllCos*pllCos)
			pllSin *= norm
			pllCos *= norm
			renormCount = 0
		}

		cosVal := float32(pllCos)

		// Pilot energy / SNR
		bpfOut := comp * cosVal
		pilotEnergy = pilotEnergy*(1-energyAlpha) + bpfOut*bpfOut*energyAlpha
		noiseEnergy = noiseEnergy*(1-energyAlpha) + comp*comp*energyAlpha

		var snr float32
		if noiseEnergy > 1e-12 {
			snr = pilotEnergy / noiseEnergy
		}
		if snr > 0.006 {
			pilotDetected = true
			holdCounter = f.holdSamples
		} else if snr < 0.002 {
			if holdCounter > 0 {
				holdCounter--
			} else {
				pilotDetected = false
			}
		} else if pilotDetected {
			holdCounter = f.holdSamples
		}

		var targetBlend float32
		if pilotDetected {
			targetBlend = (snr - 0.002) / 0.01
			if targetBlend < 0 {
				targetBlend = 0
			} else if targetBlend > 1 {
				targetBlend = 1
			}
		}
		var blendAlpha float32 = 0.003
		if targetBlend > blendFactor {
			blendAlpha = 0.015
		}
		blendFactor += blendAlpha * (targetBlend - blendFactor)
		blends[i] = blendFactor

		// FIR input pre-computation
		lprIn[i] = comp
		carrier38 := 2*cosVal*cosVal - 1
		lrIn[i] = 2.0 * comp * carrier38
	}

	f.pllSin = pllSin
	f.pllCos = pllCos
	f.pllFreq = pllFreq
	f.pllRenormCount = renormCount
	f.pilotEnergy = pilotEnergy
	f.noiseEnergy = noiseEnergy
	f.blendFactor = blendFactor
	f.pilotDetected = pilotDetected
	f.holdCounter = holdCounter

	// ---- Batch FIR: vectorizable inner loop ----
	f.lprFir.processBatch(lprIn, lprOut)
	f.lrFir.processBatch(lrIn, lrOut)

	// ---- Pass 2: stereo matrix, de-emphasis, decimate ----
	alpha := f.deemphAlpha
	stateL := f.deemphStateL
	stateR := f.deemphStateR
	decimCounter := f.decimCounter
	outIdx := 0

	for i := 0; i < n; i++ {
		lPlusR := lprOut[i]
		lMinusR := lrOut[i]
		blend := blends[i]

		var left, right float32
		if blend > 0.001 {
			left = lPlusR + blend*lMinusR
			right = lPlusR - blend*lMinusR
		} else {
			left = lPlusR
			right = lPlusR
		}

		stateL = alpha*left + (1-alpha)*stateL
		stateR = alpha*right + (1-alpha)*stateR

		decimCounter++
		if decimCounter >= f.decimFactor {
			decimCounter = 0
			if outIdx < maxOut {
				dcOutL := stateL - f.dcPrevL + 0.995*f.dcOutPrevL
				f.dcPrevL = stateL
				f.dcOutPrevL = dcOutL

				dcOutR := stateR - f.dcPrevR + 0.995*f.dcOutPrevR
				f.dcPrevR = stateR
				f.dcOutPrevR = dcOutR

				f.leftOut[outIdx] = dcOutL
				f.rightOut[outIdx] = dcOutR
				outIdx++
			}
		}
	}

	f.decimCounter = decimCounter
	f.deemphStateL = stateL
	f.deemphStateR = stateR

	// Copy decimated interleaved L,R into out
	actualOut := outIdx * 2
	if cap(out) < actualOut {
		// caller must provide adequate buffer; return what we have
		actualOut = len(out) / 2 * 2
		outIdx = actualOut / 2
	}
	for i := 0; i < outIdx; i++ {
		out[i*2] = f.leftOut[i]
		out[i*2+1] = f.rightOut[i]
	}

	return outIdx * 2
}

func (f *FmStereoDemod) Reset() {
	f.mono.Reset()
	f.pllPhase = 0
	f.pllFreq = 2.0 * math.Pi * 19000.0 / f.sampleRate
	f.pllSin = 0
	f.pllCos = 1
	f.pllRenormCount = 0
	f.pilotEnergy = 0
	f.noiseEnergy = 0
	f.blendFactor = 0
	f.pilotDetected = false
	f.holdCounter = 0
	f.decimCounter = 0
	f.deemphStateL = 0
	f.deemphStateR = 0
	if f.lprFir != nil {
		f.lprFir.reset()
	}
	if f.lrFir != nil {
		f.lrFir.reset()
	}
	f.dcPrevL = 0
	f.dcOutPrevL = 0
	f.dcPrevR = 0
	f.dcOutPrevR = 0
}

// IsStereo returns true if the pilot tone is detected and blend factor > 0.5.
func (f *FmStereoDemod) IsStereo() bool {
	return f.blendFactor > 0.01
}

// BlendFactor returns the current stereo blend amount (0=mono, 1=stereo).
func (f *FmStereoDemod) BlendFactor() float32 {
	return f.blendFactor
}

// GetComposite returns the composite baseband buffer from the last Process() call.
// This is the FM discriminator output at the input sample rate (e.g., 240kHz for WFM),
// before stereo matrix and decimation. Valid only until the next Process() call.
// Used by RdsDecoder which requires the pre-stereo composite at the full input rate.
func (f *FmStereoDemod) GetComposite() []float32 {
	return f.composite
}

// SetBandwidth is a no-op for WFM stereo: WFM is always full-band (200kHz RF, 15kHz audio).
// The fixed 51-tap FIR LPF at 15kHz handles audio bandwidth limiting.
func (f *FmStereoDemod) SetBandwidth(_ float64) {}
