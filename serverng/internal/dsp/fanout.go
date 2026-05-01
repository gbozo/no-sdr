package dsp

import (
	"sync"
	"sync/atomic"
)

// FanOut distributes data from a single writer to multiple readers.
// Each reader has an independent cursor. Slow readers skip forward.
// Uses ring buffer semantics: one writer (dongle goroutine), N readers (client goroutines).
type FanOut struct {
	mu       sync.RWMutex // protects buf; write=Write, read=Read
	buf      []byte
	size     int
	writePos atomic.Int64
	readerMu sync.Mutex // protects readers slice
	readers  []*FanOutReader
}

// FanOutReader is a reader handle for a FanOut buffer.
type FanOutReader struct {
	fanout  *FanOut
	readPos int64
	dropped atomic.Int64 // frames dropped due to slow reading
}

// NewFanOut creates a fan-out buffer with the given capacity in bytes.
func NewFanOut(capacity int) *FanOut {
	if capacity <= 0 {
		capacity = 65536
	}
	return &FanOut{
		buf:  make([]byte, capacity),
		size: capacity,
	}
}

// Write appends data to the buffer. All readers can access it.
// Overwrites oldest data if buffer is full (ring buffer semantics).
func (f *FanOut) Write(data []byte) {
	if len(data) == 0 {
		return
	}

	// If data is larger than buffer, only keep the tail that fits.
	if len(data) > f.size {
		data = data[len(data)-f.size:]
	}

	writePos := f.writePos.Load()
	start := int(writePos % int64(f.size))

	// Exclusive write lock while copying into the ring buffer.
	f.mu.Lock()
	if start+len(data) <= f.size {
		copy(f.buf[start:], data)
	} else {
		firstPart := f.size - start
		copy(f.buf[start:], data[:firstPart])
		copy(f.buf[0:], data[firstPart:])
	}
	f.mu.Unlock()

	f.writePos.Add(int64(len(data)))
}

// NewReader creates a new reader starting at the current write position.
func (f *FanOut) NewReader() *FanOutReader {
	r := &FanOutReader{
		fanout:  f,
		readPos: f.writePos.Load(),
	}
	f.readerMu.Lock()
	f.readers = append(f.readers, r)
	f.readerMu.Unlock()
	return r
}

// RemoveReader removes a reader from the fan-out.
func (f *FanOut) RemoveReader(r *FanOutReader) {
	f.readerMu.Lock()
	defer f.readerMu.Unlock()
	for i, reader := range f.readers {
		if reader == r {
			f.readers = append(f.readers[:i], f.readers[i+1:]...)
			return
		}
	}
}

// Read copies available data into dst. Returns bytes read.
// If reader has fallen behind, skips to current position (increments dropped counter).
func (r *FanOutReader) Read(dst []byte) int {
	f := r.fanout
	writePos := f.writePos.Load()

	// Check how much data is available.
	available := writePos - r.readPos
	if available <= 0 {
		return 0
	}

	// If reader has fallen behind (data overwritten), skip forward.
	if available > int64(f.size) {
		skipped := available - int64(f.size)
		r.dropped.Add(skipped)
		r.readPos = writePos - int64(f.size)
		available = int64(f.size)
	}

	// Only read up to dst capacity.
	toRead := int(available)
	if toRead > len(dst) {
		toRead = len(dst)
	}

	start := int(r.readPos % int64(f.size))

	// Shared read lock while copying from the ring buffer.
	f.mu.RLock()
	if start+toRead <= f.size {
		copy(dst[:toRead], f.buf[start:start+toRead])
	} else {
		firstPart := f.size - start
		copy(dst[:firstPart], f.buf[start:])
		copy(dst[firstPart:toRead], f.buf[0:])
	}
	f.mu.RUnlock()

	r.readPos += int64(toRead)
	return toRead
}

// Available returns bytes available to read without blocking.
func (r *FanOutReader) Available() int {
	f := r.fanout
	writePos := f.writePos.Load()

	available := writePos - r.readPos
	if available <= 0 {
		return 0
	}
	if available > int64(f.size) {
		// Data was overwritten; actual available is the full buffer.
		return f.size
	}
	return int(available)
}

// Dropped returns the number of bytes this reader has missed.
func (r *FanOutReader) Dropped() int64 {
	return r.dropped.Load()
}
