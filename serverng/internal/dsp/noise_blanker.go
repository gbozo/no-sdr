package dsp

// NoiseBlanker blanks impulse noise from complex IQ samples.
// Operates BEFORE filtering to prevent filter ringing on short impulses.
//
// Optimization: tracks avgMagSq (average of I²+Q²) and compares
// squared magnitudes directly — no sqrt needed in the hot path.
type NoiseBlanker struct {
	enabled    bool
	threshold  float32 // multiplier over average magnitude (default 10.0)
	thresholdSq float32 // threshold² — precomputed for squared comparison
	avgMagSq   float32 // EMA of squared signal magnitude (I²+Q²)
	alpha      float32 // EMA coefficient (fast tracking)
	blankCount int     // remaining samples to blank (guard window)
	guardSize  int     // samples to blank after impulse detection
}

// NewNoiseBlanker creates a noise blanker with the given threshold multiplier.
// The blanker is disabled by default — call SetEnabled(true) to activate.
func NewNoiseBlanker(threshold float32) *NoiseBlanker {
	return &NoiseBlanker{
		enabled:     false,
		threshold:   threshold,
		thresholdSq: threshold * threshold,
		alpha:       0.01, // fast EMA — tracks average in ~100 samples
		guardSize:   3,    // blank 3 additional samples after impulse
	}
}

// SetEnabled enables or disables the noise blanker.
func (nb *NoiseBlanker) SetEnabled(enabled bool) { nb.enabled = enabled }

// SetThreshold sets the impulse detection threshold (multiplier over average magnitude).
func (nb *NoiseBlanker) SetThreshold(t float32) {
	nb.threshold = t
	nb.thresholdSq = t * t
}

// IsEnabled returns whether the noise blanker is active.
func (nb *NoiseBlanker) IsEnabled() bool { return nb.enabled }

// Process blanks impulses in-place on complex64 IQ data.
// Returns the number of samples blanked (for diagnostics).
func (nb *NoiseBlanker) Process(data []complex64) int {
	if !nb.enabled {
		return 0
	}

	blanked := 0
	threshSq := nb.thresholdSq
	for i := range data {
		re := real(data[i])
		im := imag(data[i])
		magSq := re*re + im*im

		// Update EMA of squared magnitude — no sqrt needed
		nb.avgMagSq = nb.avgMagSq + nb.alpha*(magSq-nb.avgMagSq)

		if nb.blankCount > 0 {
			// Still in guard window — blank this sample
			data[i] = 0
			nb.blankCount--
			blanked++
		} else if nb.avgMagSq > 0 && magSq > nb.avgMagSq*threshSq {
			// Impulse detected — blank this sample + start guard window
			// Equivalent to: mag > avgMag*threshold, but avoids two sqrts
			data[i] = 0
			nb.blankCount = nb.guardSize
			blanked++
		}
	}
	return blanked
}

// Reset clears the NB state.
func (nb *NoiseBlanker) Reset() {
	nb.avgMagSq = 0
	nb.blankCount = 0
}
