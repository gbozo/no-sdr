package dsp

// DCBlocker removes the DC offset from a complex IQ stream using a leaky
// integrator (first-order IIR high-pass) with a very low corner frequency
// (~1 Hz at typical SDR sample rates). This eliminates the center-frequency
// DC spike that RTL-SDR hardware produces due to mixer LO leakage / ADC DC
// bias.
//
// Algorithm (applied independently to I and Q):
//
//	y = x - dcEst
//	dcEst += beta * y
//
// where beta = 2π * cornerHz / sampleRate.
// For sampleRate = 2.4 MSPS and cornerHz = 1 Hz: beta ≈ 2.618e-6.
// Time constant ≈ 1/cornerHz = 1 second.
//
// This is the standard leaky integrator form — it saves one multiply per
// sample compared to the equivalent alpha/beta formulation.
type DCBlocker struct {
	enabled bool
	beta    float32 // 1 - alpha ≈ 2π * cornerHz / sampleRate
	dcI     float32 // running DC estimate for I channel
	dcQ     float32 // running DC estimate for Q channel
}

// NewDCBlocker creates a DCBlocker for the given sample rate.
// cornerHz is the -3 dB corner of the high-pass response (typically 1.0 Hz).
// enabled controls whether the filter is active; it can be toggled at runtime.
func NewDCBlocker(sampleRate float64, cornerHz float64, enabled bool) *DCBlocker {
	beta := float32((2 * 3.14159265358979 / sampleRate) * cornerHz)
	if beta < 0 {
		beta = 0
	}
	if beta > 1 {
		beta = 1
	}
	return &DCBlocker{
		enabled: enabled,
		beta:    beta,
	}
}

// SetEnabled enables or disables DC removal without resetting the DC estimate.
func (b *DCBlocker) SetEnabled(enabled bool) {
	b.enabled = enabled
}

// IsEnabled reports whether DC removal is currently active.
func (b *DCBlocker) IsEnabled() bool {
	return b.enabled
}

// Reset clears the DC estimates (useful after large frequency jumps).
func (b *DCBlocker) Reset() {
	b.dcI = 0
	b.dcQ = 0
}

// Process applies the DC blocker to samples in-place.
// samples is a []complex64 slice of interleaved I/Q values.
// If disabled, the slice is unchanged.
func (b *DCBlocker) Process(samples []complex64) {
	if !b.enabled {
		return
	}
	beta := b.beta
	dcI := b.dcI
	dcQ := b.dcQ

	for i, s := range samples {
		rI := real(s)
		rQ := imag(s)
		// y = x - dcEst; dcEst += beta * y
		yI := rI - dcI
		yQ := rQ - dcQ
		dcI += beta * yI
		dcQ += beta * yQ
		samples[i] = complex(yI, yQ)
	}

	b.dcI = dcI
	b.dcQ = dcQ
}
