// Package history provides ring-buffer storage for recent FFT frames.
package history

import "sync"

// FftBuffer stores recent FFT frames for seek-back.
type FftBuffer struct {
	frames   [][]float32
	size     int // max frames to keep
	writeIdx int
	count    int
	mu       sync.RWMutex
}

// NewFftBuffer creates a new ring buffer with the given max capacity.
func NewFftBuffer(maxFrames int) *FftBuffer {
	if maxFrames <= 0 {
		maxFrames = 1
	}
	return &FftBuffer{
		frames: make([][]float32, maxFrames),
		size:   maxFrames,
	}
}

// Push adds a new FFT frame to the buffer.
// The frame slice is stored directly (not copied) for performance.
func (b *FftBuffer) Push(frame []float32) {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.frames[b.writeIdx] = frame
	b.writeIdx = (b.writeIdx + 1) % b.size
	if b.count < b.size {
		b.count++
	}
}

// Count returns number of frames stored.
func (b *FftBuffer) Count() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.count
}

// GetFrames returns frames in time order (oldest first).
// from and to are indices (0 = oldest available, count-1 = newest).
// Returns nil if from > to or indices are out of range.
func (b *FftBuffer) GetFrames(from, to int) [][]float32 {
	b.mu.RLock()
	defer b.mu.RUnlock()

	if from < 0 || to < 0 || from > to || from >= b.count || to >= b.count {
		return nil
	}

	result := make([][]float32, 0, to-from+1)
	// Calculate the actual start index in the ring buffer.
	// The oldest frame is at (writeIdx - count + size) % size
	startIdx := (b.writeIdx - b.count + b.size) % b.size

	for i := from; i <= to; i++ {
		idx := (startIdx + i) % b.size
		result = append(result, b.frames[idx])
	}
	return result
}

// GetRange returns all frames in the buffer in time order (oldest first).
func (b *FftBuffer) GetRange() [][]float32 {
	b.mu.RLock()
	defer b.mu.RUnlock()

	if b.count == 0 {
		return nil
	}

	result := make([][]float32, b.count)
	startIdx := (b.writeIdx - b.count + b.size) % b.size

	for i := 0; i < b.count; i++ {
		idx := (startIdx + i) % b.size
		result[i] = b.frames[idx]
	}
	return result
}
