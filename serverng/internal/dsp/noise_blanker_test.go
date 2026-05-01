package dsp

import (
	"testing"
)

func TestNoiseBlanker_DisabledPassesThrough(t *testing.T) {
	nb := NewNoiseBlanker(10.0)
	// disabled by default

	data := []complex64{
		complex(0.5, 0.3),
		complex(-0.2, 0.8),
		complex(0.1, -0.4),
	}
	// Copy original for comparison
	orig := make([]complex64, len(data))
	copy(orig, data)

	blanked := nb.Process(data)
	if blanked != 0 {
		t.Errorf("expected 0 blanked when disabled, got %d", blanked)
	}
	for i := range data {
		if data[i] != orig[i] {
			t.Errorf("sample %d modified when NB disabled: got %v, want %v", i, data[i], orig[i])
		}
	}
}

func TestNoiseBlanker_ImpulseBlanked(t *testing.T) {
	nb := NewNoiseBlanker(5.0)
	nb.SetEnabled(true)

	// First, feed normal-level signal to build up avgMag
	normalData := make([]complex64, 200)
	for i := range normalData {
		normalData[i] = complex(0.1, 0.1) // mag ~0.141
	}
	nb.Process(normalData)

	// Now inject an impulse spike
	data := make([]complex64, 10)
	for i := range data {
		data[i] = complex(0.1, 0.1) // normal level
	}
	// Insert a huge spike at position 3
	data[3] = complex(5.0, 5.0) // mag ~7.07, well above 5x average (~0.141*5=0.707)

	blanked := nb.Process(data)

	// The spike at index 3 should be blanked
	if data[3] != 0 {
		t.Errorf("impulse at index 3 was not blanked: %v", data[3])
	}

	// Guard window: 3 more samples after the impulse should be blanked (indices 4, 5, 6)
	for i := 4; i <= 6; i++ {
		if data[i] != 0 {
			t.Errorf("guard sample at index %d was not blanked: %v", i, data[i])
		}
	}

	// At least 4 samples blanked (impulse + 3 guard)
	if blanked < 4 {
		t.Errorf("expected at least 4 blanked, got %d", blanked)
	}
}

func TestNoiseBlanker_GuardWindow(t *testing.T) {
	nb := NewNoiseBlanker(5.0)
	nb.SetEnabled(true)
	// Custom guard size: test with default (3)

	// Build up average magnitude
	warmup := make([]complex64, 300)
	for i := range warmup {
		warmup[i] = complex(0.1, 0.0) // mag = 0.1
	}
	nb.Process(warmup)

	// Inject spike followed by normal samples
	data := make([]complex64, 10)
	for i := range data {
		data[i] = complex(0.1, 0.0)
	}
	data[0] = complex(10.0, 0.0) // spike: mag=10, avg~0.1, threshold=0.5

	nb.Process(data)

	// Index 0: spike blanked
	if data[0] != 0 {
		t.Errorf("spike at index 0 not blanked: %v", data[0])
	}
	// Indices 1, 2, 3: guard window
	for i := 1; i <= 3; i++ {
		if data[i] != 0 {
			t.Errorf("guard at index %d not blanked: %v", i, data[i])
		}
	}
	// Index 4 should NOT be blanked (guard size = 3)
	if data[4] == 0 {
		t.Errorf("sample at index 4 should not be blanked")
	}
}

func TestNoiseBlanker_NormalSignalPasses(t *testing.T) {
	nb := NewNoiseBlanker(10.0)
	nb.SetEnabled(true)

	// Feed consistent normal signal — nothing should be blanked after warmup
	warmup := make([]complex64, 500)
	for i := range warmup {
		warmup[i] = complex(0.5, 0.5) // mag ~0.707
	}
	nb.Process(warmup)

	// Now process more of the same — no impulses
	data := make([]complex64, 100)
	for i := range data {
		data[i] = complex(0.5, 0.5)
	}
	orig := make([]complex64, len(data))
	copy(orig, data)

	blanked := nb.Process(data)
	if blanked != 0 {
		t.Errorf("expected 0 blanked for normal signal, got %d", blanked)
	}
	for i := range data {
		if data[i] != orig[i] {
			t.Errorf("sample %d modified for normal signal", i)
		}
	}
}

func TestNoiseBlanker_Reset(t *testing.T) {
	nb := NewNoiseBlanker(10.0)
	nb.SetEnabled(true)

	// Build up state
	data := make([]complex64, 200)
	for i := range data {
		data[i] = complex(0.5, 0.5)
	}
	nb.Process(data)

	// Reset clears state
	nb.Reset()
	if nb.avgMag != 0 {
		t.Errorf("expected avgMag 0 after reset, got %f", nb.avgMag)
	}
	if nb.blankCount != 0 {
		t.Errorf("expected blankCount 0 after reset, got %d", nb.blankCount)
	}
}

func BenchmarkNoiseBlanker(b *testing.B) {
	nb := NewNoiseBlanker(10.0)
	nb.SetEnabled(true)

	// 48000 samples (1 second at 48kHz, or 20ms at 2.4MSPS)
	data := make([]complex64, 48000)
	for i := range data {
		data[i] = complex(0.3, 0.2)
	}
	// Sprinkle a few impulses
	data[1000] = complex(10.0, 10.0)
	data[20000] = complex(8.0, 8.0)
	data[40000] = complex(12.0, 12.0)

	b.ResetTimer()
	b.ReportAllocs()
	b.SetBytes(int64(len(data)) * 8) // complex64 = 8 bytes

	for i := 0; i < b.N; i++ {
		nb.Process(data)
	}
}
