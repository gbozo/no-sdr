//! Ring-buffer storage for recent FFT frames.
//!
//! Mirrors `serverng/internal/history/fft_buffer.go`.

use parking_lot::RwLock;

struct Inner {
    frames: Vec<Vec<f32>>,
    write_idx: usize,
    count: usize,
    fft_size: usize,
}

/// Stores recent FFT frames for waterfall seek-back.
///
/// Frame storage is pre-allocated lazily; pushes copy data into the next slot
/// so the caller may reuse its buffer.
pub struct FftBuffer {
    inner: RwLock<Inner>,
    size: usize,
}

impl FftBuffer {
    /// Creates a new ring buffer holding at most `max_frames` frames.
    pub fn new(max_frames: usize) -> Self {
        let size = max_frames.max(1);
        Self {
            inner: RwLock::new(Inner {
                frames: vec![Vec::new(); size],
                write_idx: 0,
                count: 0,
                fft_size: 0,
            }),
            size,
        }
    }

    /// Pre-allocates frame buffers for the given FFT size.
    ///
    /// Idempotent; safe to call again after the FFT size changes. Must not be
    /// called concurrently with `push`.
    pub fn init_frames(&self, fft_size: usize) {
        let mut inner = self.inner.write();
        inner.fft_size = fft_size;
        for frame in inner.frames.iter_mut() {
            if frame.len() != fft_size {
                *frame = vec![0.0; fft_size];
            }
        }
    }

    /// Copies a new FFT frame into the next slot.
    pub fn push(&self, frame: &[f32]) {
        let mut inner = self.inner.write();
        let idx = inner.write_idx;
        if inner.frames[idx].len() != frame.len() {
            inner.frames[idx] = vec![0.0; frame.len()];
        }
        inner.frames[idx].copy_from_slice(frame);
        inner.write_idx = (inner.write_idx + 1) % self.size;
        if inner.count < self.size {
            inner.count += 1;
        }
    }

    /// Returns the number of stored frames.
    pub fn count(&self) -> usize {
        self.inner.read().count
    }

    /// FFT size last passed to `init_frames` (0 when never initialised).
    pub fn fft_size(&self) -> usize {
        self.inner.read().fft_size
    }

    /// Returns frames in time order (oldest first), inclusive range.
    ///
    /// Returns `None` when the range is invalid.
    pub fn get_frames(&self, from: usize, to: usize) -> Option<Vec<Vec<f32>>> {
        let inner = self.inner.read();
        if from > to || from >= inner.count || to >= inner.count {
            return None;
        }

        let start_idx = (inner.write_idx + self.size - inner.count) % self.size;
        let mut result = Vec::with_capacity(to - from + 1);
        for i in from..=to {
            let idx = (start_idx + i) % self.size;
            result.push(inner.frames[idx].clone());
        }
        Some(result)
    }

    /// Returns all stored frames in time order (oldest first).
    pub fn get_range(&self) -> Vec<Vec<f32>> {
        let inner = self.inner.read();
        if inner.count == 0 {
            return Vec::new();
        }

        let start_idx = (inner.write_idx + self.size - inner.count) % self.size;
        let mut result = Vec::with_capacity(inner.count);
        for i in 0..inner.count {
            let idx = (start_idx + i) % self.size;
            result.push(inner.frames[idx].clone());
        }
        result
    }

    /// Clears all frames, keeping pre-allocated buffers.
    pub fn reset(&self) {
        let mut inner = self.inner.write();
        inner.write_idx = 0;
        inner.count = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_and_orders_frames() {
        let buf = FftBuffer::new(4);
        buf.init_frames(3);
        assert_eq!(buf.count(), 0);

        for i in 0..3 {
            buf.push(&[i as f32; 3]);
        }
        assert_eq!(buf.count(), 3);

        let frames = buf.get_range();
        assert_eq!(frames.len(), 3);
        assert_eq!(frames[0][0], 0.0);
        assert_eq!(frames[2][0], 2.0);
    }

    #[test]
    fn wraps_and_keeps_newest() {
        let buf = FftBuffer::new(3);
        for i in 0..5 {
            buf.push(&[i as f32]);
        }
        assert_eq!(buf.count(), 3);
        let frames = buf.get_range();
        assert_eq!(frames[0][0], 2.0);
        assert_eq!(frames[1][0], 3.0);
        assert_eq!(frames[2][0], 4.0);
    }

    #[test]
    fn get_frames_bounds() {
        let buf = FftBuffer::new(4);
        for i in 0..3 {
            buf.push(&[i as f32]);
        }
        assert!(buf.get_frames(1, 2).is_some());
        assert!(buf.get_frames(2, 1).is_none());
        assert!(buf.get_frames(0, 3).is_none());
        assert!(buf.get_frames(3, 3).is_none());
    }

    #[test]
    fn reset_clears_count() {
        let buf = FftBuffer::new(2);
        buf.push(&[1.0]);
        buf.reset();
        assert_eq!(buf.count(), 0);
        assert!(buf.get_range().is_empty());
    }

    #[test]
    fn zero_capacity_becomes_one() {
        let buf = FftBuffer::new(0);
        buf.push(&[1.0]);
        assert_eq!(buf.count(), 1);
    }
}
