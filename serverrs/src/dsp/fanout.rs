//! Single-writer / multi-reader ring buffer fan-out.
//!
//! Mirrors `serverng/internal/dsp/fanout.go`. Each reader keeps an
//! independent cursor and skips forward (counting dropped bytes) when it
//! falls more than one buffer behind.

use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

struct FanOutInner {
    buf: RwLock<Vec<u8>>,
    size: usize,
    write_pos: AtomicI64,
    readers: Mutex<Vec<u64>>,
    next_reader_id: AtomicU64,
}

/// A shared ring buffer.
#[derive(Clone)]
pub struct FanOut {
    inner: Arc<FanOutInner>,
}

/// An independent reader cursor into a [`FanOut`].
pub struct FanOutReader {
    inner: Arc<FanOutInner>,
    id: u64,
    read_pos: i64,
    dropped: i64,
}

impl FanOut {
    /// Creates a fan-out buffer with the given capacity in bytes.
    pub fn new(capacity: usize) -> Self {
        let size = if capacity == 0 { 65536 } else { capacity };
        Self {
            inner: Arc::new(FanOutInner {
                buf: RwLock::new(vec![0u8; size]),
                size,
                write_pos: AtomicI64::new(0),
                readers: Mutex::new(Vec::new()),
                next_reader_id: AtomicU64::new(0),
            }),
        }
    }

    pub fn capacity(&self) -> usize {
        self.inner.size
    }

    /// Appends data, overwriting the oldest bytes when full.
    pub fn write(&self, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        let size = self.inner.size;
        let data = if data.len() > size {
            &data[data.len() - size..]
        } else {
            data
        };

        let write_pos = self.inner.write_pos.load(Ordering::Acquire);
        let start = (write_pos % size as i64) as usize;

        {
            let mut buf = self.inner.buf.write().unwrap();
            if start + data.len() <= size {
                buf[start..start + data.len()].copy_from_slice(data);
            } else {
                let first = size - start;
                buf[start..].copy_from_slice(&data[..first]);
                buf[..data.len() - first].copy_from_slice(&data[first..]);
            }
        }

        self.inner
            .write_pos
            .fetch_add(data.len() as i64, Ordering::Release);
    }

    /// Creates a reader starting at the current write position.
    pub fn new_reader(&self) -> FanOutReader {
        let id = self
            .inner
            .next_reader_id
            .fetch_add(1, Ordering::Relaxed)
            .wrapping_add(1);
        self.inner.readers.lock().unwrap().push(id);
        FanOutReader {
            inner: Arc::clone(&self.inner),
            id,
            read_pos: self.inner.write_pos.load(Ordering::Acquire),
            dropped: 0,
        }
    }

    /// Removes a reader from the fan-out.
    pub fn remove_reader(&self, reader: &FanOutReader) {
        self.inner.readers.lock().unwrap().retain(|id| *id != reader.id);
    }

    pub fn reader_count(&self) -> usize {
        self.inner.readers.lock().unwrap().len()
    }
}

impl FanOutReader {
    /// Copies available data into `dst`, returning the number of bytes read.
    /// If the reader has fallen behind, skips ahead and counts dropped bytes.
    pub fn read(&mut self, dst: &mut [u8]) -> usize {
        let size = self.inner.size as i64;
        let write_pos = self.inner.write_pos.load(Ordering::Acquire);

        let mut available = write_pos - self.read_pos;
        if available <= 0 {
            return 0;
        }

        if available > size {
            self.dropped += available - size;
            self.read_pos = write_pos - size;
            available = size;
        }

        let to_read = (available as usize).min(dst.len());
        if to_read == 0 {
            return 0;
        }

        let start = (self.read_pos % size) as usize;
        {
            let buf = self.inner.buf.read().unwrap();
            if start + to_read <= self.inner.size {
                dst[..to_read].copy_from_slice(&buf[start..start + to_read]);
            } else {
                let first = self.inner.size - start;
                dst[..first].copy_from_slice(&buf[start..]);
                dst[first..to_read].copy_from_slice(&buf[..to_read - first]);
            }
        }

        self.read_pos += to_read as i64;
        to_read
    }

    /// Number of bytes available without blocking.
    pub fn available(&self) -> usize {
        let size = self.inner.size as i64;
        let available = self.inner.write_pos.load(Ordering::Acquire) - self.read_pos;
        if available <= 0 {
            0
        } else if available > size {
            self.inner.size
        } else {
            available as usize
        }
    }

    /// Number of bytes this reader has missed.
    pub fn dropped(&self) -> i64 {
        self.dropped
    }

    pub fn read_pos(&self) -> i64 {
        self.read_pos
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readers_see_same_stream() {
        let f = FanOut::new(16);
        let mut a = f.new_reader();
        let mut b = f.new_reader();

        f.write(b"hello");
        let mut da = [0u8; 8];
        let mut db = [0u8; 8];
        assert_eq!(a.read(&mut da), 5);
        assert_eq!(b.read(&mut db), 5);
        assert_eq!(&da[..5], b"hello");
        assert_eq!(&db[..5], b"hello");
    }

    #[test]
    fn slow_reader_skips_and_counts_dropped() {
        let f = FanOut::new(8);
        let mut r = f.new_reader();
        f.write(b"01234567");
        f.write(b"89abcdef"); // overwrites the first chunk
        let mut dst = [0u8; 4];
        assert_eq!(r.read(&mut dst), 4);
        assert_eq!(&dst, b"89ab");
        assert_eq!(r.dropped(), 8);
    }

    #[test]
    fn remove_reader_unregisters() {
        let f = FanOut::new(8);
        let r = f.new_reader();
        assert_eq!(f.reader_count(), 1);
        f.remove_reader(&r);
        assert_eq!(f.reader_count(), 0);
    }
}
