package history

import (
	"sync"
	"testing"
)

func TestPushAndCount(t *testing.T) {
	buf := NewFftBuffer(10)

	// Push N frames, count is correct
	for i := 0; i < 5; i++ {
		buf.Push([]float32{float32(i)})
	}
	if got := buf.Count(); got != 5 {
		t.Errorf("Count() = %d, want 5", got)
	}
}

func TestPushOverCapacity(t *testing.T) {
	buf := NewFftBuffer(4)

	// Push more than capacity
	for i := 0; i < 7; i++ {
		buf.Push([]float32{float32(i)})
	}

	if got := buf.Count(); got != 4 {
		t.Errorf("Count() = %d, want 4 (capped at capacity)", got)
	}

	// Should contain frames 3,4,5,6 (oldest dropped)
	frames := buf.GetRange()
	if len(frames) != 4 {
		t.Fatalf("GetRange() returned %d frames, want 4", len(frames))
	}
	for i, f := range frames {
		expected := float32(i + 3)
		if f[0] != expected {
			t.Errorf("frames[%d][0] = %v, want %v", i, f[0], expected)
		}
	}
}

func TestGetFramesSubset(t *testing.T) {
	buf := NewFftBuffer(10)

	for i := 0; i < 8; i++ {
		buf.Push([]float32{float32(i * 10)})
	}

	// Get frames 2..5 (indices into time-ordered buffer)
	frames := buf.GetFrames(2, 5)
	if len(frames) != 4 {
		t.Fatalf("GetFrames(2,5) returned %d frames, want 4", len(frames))
	}

	expected := []float32{20, 30, 40, 50}
	for i, f := range frames {
		if f[0] != expected[i] {
			t.Errorf("frames[%d][0] = %v, want %v", i, f[0], expected[i])
		}
	}
}

func TestGetFramesWithWrapAround(t *testing.T) {
	buf := NewFftBuffer(4)

	// Fill and overflow
	for i := 0; i < 6; i++ {
		buf.Push([]float32{float32(i)})
	}

	// Buffer should contain [2, 3, 4, 5] in time order
	frames := buf.GetFrames(0, 3)
	if len(frames) != 4 {
		t.Fatalf("GetFrames(0,3) returned %d frames, want 4", len(frames))
	}

	expected := []float32{2, 3, 4, 5}
	for i, f := range frames {
		if f[0] != expected[i] {
			t.Errorf("frames[%d][0] = %v, want %v", i, f[0], expected[i])
		}
	}
}

func TestGetFramesInvalidRange(t *testing.T) {
	buf := NewFftBuffer(10)
	buf.Push([]float32{1.0})

	// Invalid ranges
	if frames := buf.GetFrames(-1, 0); frames != nil {
		t.Errorf("GetFrames(-1, 0) should return nil")
	}
	if frames := buf.GetFrames(0, 5); frames != nil {
		t.Errorf("GetFrames(0, 5) with count=1 should return nil")
	}
	if frames := buf.GetFrames(3, 1); frames != nil {
		t.Errorf("GetFrames(3, 1) should return nil (from > to)")
	}
}

func TestGetRangeEmpty(t *testing.T) {
	buf := NewFftBuffer(10)
	if frames := buf.GetRange(); frames != nil {
		t.Errorf("GetRange() on empty buffer should return nil, got %v", frames)
	}
}

func TestConcurrentPushAndRead(t *testing.T) {
	buf := NewFftBuffer(100)

	var wg sync.WaitGroup

	// Concurrent writers
	for w := 0; w < 4; w++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			for i := 0; i < 250; i++ {
				buf.Push([]float32{float32(workerID*1000 + i)})
			}
		}(w)
	}

	// Concurrent readers
	for r := 0; r < 4; r++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 250; i++ {
				_ = buf.Count()
				_ = buf.GetRange()
			}
		}()
	}

	wg.Wait()

	// After 4 writers * 250 pushes = 1000 total pushes, buffer should be full
	if got := buf.Count(); got != 100 {
		t.Errorf("Count() after concurrent ops = %d, want 100", got)
	}
}
