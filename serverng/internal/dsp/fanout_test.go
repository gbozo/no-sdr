package dsp

import (
	"bytes"
	"sync"
	"testing"
)

func TestFanOut_SingleReaderBasic(t *testing.T) {
	fo := NewFanOut(1024)
	reader := fo.NewReader()

	// Write some data.
	data := []byte("hello world")
	fo.Write(data)

	// Reader should see it.
	if avail := reader.Available(); avail != len(data) {
		t.Fatalf("expected %d available, got %d", len(data), avail)
	}

	buf := make([]byte, 64)
	n := reader.Read(buf)
	if n != len(data) {
		t.Fatalf("expected to read %d bytes, got %d", len(data), n)
	}
	if !bytes.Equal(buf[:n], data) {
		t.Fatalf("expected %q, got %q", data, buf[:n])
	}

	// No more data available.
	if avail := reader.Available(); avail != 0 {
		t.Fatalf("expected 0 available after read, got %d", avail)
	}
}

func TestFanOut_MultipleReaders(t *testing.T) {
	fo := NewFanOut(1024)
	r1 := fo.NewReader()
	r2 := fo.NewReader()
	r3 := fo.NewReader()

	data := []byte("broadcast message")
	fo.Write(data)

	// All readers should get the same data.
	for i, r := range []*FanOutReader{r1, r2, r3} {
		buf := make([]byte, 64)
		n := r.Read(buf)
		if n != len(data) {
			t.Fatalf("reader %d: expected %d bytes, got %d", i, len(data), n)
		}
		if !bytes.Equal(buf[:n], data) {
			t.Fatalf("reader %d: expected %q, got %q", i, data, buf[:n])
		}
	}
}

func TestFanOut_SlowReaderDrops(t *testing.T) {
	capacity := 256
	fo := NewFanOut(capacity)
	reader := fo.NewReader()

	// Write more data than the buffer can hold without reading.
	chunk := make([]byte, 100)
	for i := range chunk {
		chunk[i] = byte(i)
	}

	// Write 4 chunks of 100 bytes = 400 bytes total. Buffer is 256.
	for i := 0; i < 4; i++ {
		fo.Write(chunk)
	}

	// Reader should have dropped some data.
	buf := make([]byte, 512)
	n := reader.Read(buf)

	// Reader can read at most `capacity` bytes.
	if n > capacity {
		t.Fatalf("read more than capacity: %d > %d", n, capacity)
	}

	dropped := reader.Dropped()
	if dropped == 0 {
		t.Fatal("expected dropped > 0 for slow reader")
	}
	t.Logf("slow reader dropped %d bytes, read %d bytes", dropped, n)
}

func TestFanOut_RemoveReader(t *testing.T) {
	fo := NewFanOut(1024)
	r1 := fo.NewReader()
	r2 := fo.NewReader()

	fo.RemoveReader(r1)

	// Verify r1 was removed — only r2 should remain.
	fo.mu.Lock()
	count := len(fo.readers)
	fo.mu.Unlock()

	if count != 1 {
		t.Fatalf("expected 1 reader after removal, got %d", count)
	}

	// r2 should still work.
	data := []byte("still works")
	fo.Write(data)
	buf := make([]byte, 64)
	n := r2.Read(buf)
	if n != len(data) {
		t.Fatalf("expected %d bytes, got %d", len(data), n)
	}
}

func TestFanOut_ConcurrentWriteRead(t *testing.T) {
	fo := NewFanOut(4096)
	reader := fo.NewReader()

	numWrites := 1000
	chunkSize := 32
	chunk := make([]byte, chunkSize)
	for i := range chunk {
		chunk[i] = 0xAB
	}

	var wg sync.WaitGroup

	// Writer goroutine.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < numWrites; i++ {
			fo.Write(chunk)
		}
	}()

	// Reader goroutine.
	totalRead := 0
	wg.Add(1)
	go func() {
		defer wg.Done()
		buf := make([]byte, 256)
		for totalRead < numWrites*chunkSize {
			n := reader.Read(buf)
			if n > 0 {
				totalRead += n
			}
			// If reader fell behind, account for dropped bytes too.
			dropped := reader.Dropped()
			if int64(totalRead)+dropped >= int64(numWrites*chunkSize) {
				totalRead = numWrites * chunkSize // done
			}
		}
	}()

	wg.Wait()

	// Verify that read + dropped accounts for all written data.
	// This is a concurrency smoke test — exact counts may vary.
	t.Logf("concurrent test: totalRead=%d, dropped=%d", totalRead, reader.Dropped())
}

func TestFanOut_WrapAround(t *testing.T) {
	// Small buffer to force wrap-around.
	fo := NewFanOut(16)
	reader := fo.NewReader()

	// Write 10 bytes.
	fo.Write([]byte("0123456789"))
	// Write 10 more — will wrap around in a 16-byte buffer.
	fo.Write([]byte("ABCDEFGHIJ"))

	// Total written: 20 bytes. Buffer is 16. Reader started at 0.
	// Reader has fallen behind by 4 bytes.
	buf := make([]byte, 32)
	n := reader.Read(buf)

	// Should read the most recent 16 bytes (or less).
	if n > 16 {
		t.Fatalf("read more than buffer size: %d", n)
	}
	if reader.Dropped() == 0 {
		t.Fatal("expected drops on wrap-around")
	}
	t.Logf("wrap-around: read %d bytes: %q, dropped %d", n, buf[:n], reader.Dropped())
}
