package dsp

// NoiseBlanker blanks impulse noise from complex IQ samples.
// Operates BEFORE filtering to prevent filter ringing on short impulses.
//
// Dual-threshold detection:
//   - Above "blank" threshold: sample is impulse, blank immediately.
//   - Above "detect" threshold but below "blank": probable impulse,
//     blank with confidence proportional to excess.
//   - Below both: pass through.
//
// Guard window blanks additional samples after each impulse to account
// for the filter's transient recovery time.
type NoiseBlanker struct {
	enabled       bool
	threshold     float32 // high threshold: definite impulse blanking (default 10.0)
	thresholdLow  float32 // low threshold: probable impulse (default 4.0)
	thresholdSq   float32 // high threshold squared
	thresholdLowSq float32 // low threshold squared
	avgMagSq      float32 // EMA of squared signal magnitude (I²+Q²)
	alpha         float32 // EMA coefficient (fast tracking)
	blankCount    int     // remaining samples to blank (guard window)
	guardSize     int     // samples to blank after impulse detection
}

// NewNoiseBlanker creates a noise blanker with the given high threshold multiplier.
// The blanker is disabled by default — call SetEnabled(true) to activate.
func NewNoiseBlanker(threshold float32) *NoiseBlanker {
	lowThresh := threshold * 0.4
	if lowThresh < 3.0 {
		lowThresh = 3.0
	}
	return &NoiseBlanker{
		enabled:        false,
		threshold:      threshold,
		thresholdLow:   lowThresh,
		thresholdSq:    threshold * threshold,
		thresholdLowSq: lowThresh * lowThresh,
		alpha:          0.01,
		guardSize:      8,
	}
}

// SetEnabled enables or disables the noise blanker.
func (nb *NoiseBlanker) SetEnabled(enabled bool) { nb.enabled = enabled }

// SetThreshold sets the impulse detection threshold (multiplier over average magnitude).
// The low threshold is automatically set to 40% of this value.
func (nb *NoiseBlanker) SetThreshold(t float32) {
	nb.threshold = t
	nb.thresholdSq = t * t
	lowThresh := t * 0.4
	if lowThresh < 3.0 {
		lowThresh = 3.0
	}
	nb.thresholdLow = lowThresh
	nb.thresholdLowSq = lowThresh * lowThresh
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
	threshLowSq := nb.thresholdLowSq
	guard := nb.guardSize

	for i := range data {
		re := real(data[i])
		im := imag(data[i])
		magSq := re*re + im*im

		nb.avgMagSq = nb.avgMagSq + nb.alpha*(magSq-nb.avgMagSq)

		if nb.blankCount > 0 {
			data[i] = 0
			nb.blankCount--
			blanked++
		} else if nb.avgMagSq > 0 && magSq > nb.avgMagSq*threshSq {
			data[i] = 0
			nb.blankCount = guard
			blanked++
		} else if nb.avgMagSq > 0 && magSq > nb.avgMagSq*threshLowSq {
			excess := (magSq - nb.avgMagSq*threshLowSq) / (nb.avgMagSq * (threshSq - threshLowSq))
			if excess > 0.5 {
				data[i] = 0
				nb.blankCount = guard
				blanked++
			}
		}
	}
	return blanked
}

// Reset clears the NB state.
func (nb *NoiseBlanker) Reset() {
	nb.avgMagSq = 0
	nb.blankCount = 0
}
