package dsp

// DCBlocker removes the DC offset from a complex IQ stream using a first-order
// IIR high-pass filter with a very low corner frequency (~1 Hz at typical SDR
// sample rates). This eliminates the center-frequency DC spike that RTL-SDR
// hardware produces due to mixer LO leakage / ADC DC bias.
//
// Algorithm (applied independently to I and Q):
//
//	dcEst = alpha * dcEst + (1 - alpha) * x
//	y = x - dcEst
//
// where alpha = 1 - 2π * cornerHz / sampleRate.
// For sampleRate = 2.4 MSPS and cornerHz = 1 Hz: alpha ≈ 0.9999974.
// Time constant ≈ 1/cornerHz = 1 second.
type DCBlocker struct {
	enabled bool
	alpha   float32 // IIR coefficient ≈ 1 - 2π/sampleRate
	beta    float32 // 1 - alpha
	dcI     float32 // running DC estimate for I channel
	dcQ     float32 // running DC estimate for Q channel
}

// NewDCBlocker creates a DCBlocker for the given sample rate.
// cornerHz is the -3 dB corner of the high-pass response (typically 1.0 Hz).
// enabled controls whether the filter is active; it can be toggled at runtime.
func NewDCBlocker(sampleRate float64, cornerHz float64, enabled bool) *DCBlocker {
	alpha := float32(1.0 - (2*3.14159265358979/sampleRate)*cornerHz)
	if alpha < 0 {
		alpha = 0
	}
	if alpha > 1 {
		alpha = 1
	}
	return &DCBlocker{
		enabled: enabled,
		alpha:   alpha,
		beta:    1 - alpha,
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
	alpha := b.alpha
	beta := b.beta
	dcI := b.dcI
	dcQ := b.dcQ

	for i, s := range samples {
		rI := real(s)
		rQ := imag(s)
		dcI = alpha*dcI + beta*rI
		dcQ = alpha*dcQ + beta*rQ
		samples[i] = complex(rI-dcI, rQ-dcQ)
	}

	b.dcI = dcI
	b.dcQ = dcQ
}
