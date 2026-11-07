//! Per-IP WebSocket connection limiting.
//!
//! Port of `serverng/internal/ws/ratelimit.go`.

use std::collections::HashMap;

use parking_lot::Mutex;

/// Limits WebSocket connections per IP.
pub struct RateLimiter {
    max_per_ip: usize,
    conns: Mutex<HashMap<String, usize>>,
}

impl RateLimiter {
    pub fn new(max_per_ip: usize) -> Self {
        let max_per_ip = if max_per_ip == 0 { 10 } else { max_per_ip };
        Self {
            max_per_ip,
            conns: Mutex::new(HashMap::new()),
        }
    }

    pub fn max_per_ip(&self) -> usize {
        self.max_per_ip
    }

    /// Check whether a new connection from this IP is allowed.
    /// Increments the counter when allowed.
    pub fn allow(&self, ip: &str) -> bool {
        let mut conns = self.conns.lock();
        let count = conns.entry(ip.to_string()).or_insert(0);
        if *count >= self.max_per_ip {
            return false;
        }
        *count += 1;
        true
    }

    /// Decrement the counter for an IP (call on disconnect).
    pub fn release(&self, ip: &str) {
        let mut conns = self.conns.lock();
        if let Some(count) = conns.get_mut(ip) {
            if *count > 0 {
                *count -= 1;
            }
            if *count == 0 {
                conns.remove(ip);
            }
        }
    }

    /// Current connection count for an IP.
    pub fn count(&self, ip: &str) -> usize {
        self.conns.lock().get(ip).copied().unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limit_and_release() {
        let rl = RateLimiter::new(2);
        assert!(rl.allow("1.2.3.4"));
        assert!(rl.allow("1.2.3.4"));
        assert!(!rl.allow("1.2.3.4"));
        assert_eq!(rl.count("1.2.3.4"), 2);

        // A different IP has its own budget.
        assert!(rl.allow("5.6.7.8"));

        rl.release("1.2.3.4");
        assert_eq!(rl.count("1.2.3.4"), 1);
        assert!(rl.allow("1.2.3.4"));

        rl.release("1.2.3.4");
        rl.release("1.2.3.4");
        assert_eq!(rl.count("1.2.3.4"), 0);
        // Releasing an unknown IP is a no-op.
        rl.release("9.9.9.9");
    }

    #[test]
    fn zero_means_default() {
        let rl = RateLimiter::new(0);
        assert_eq!(rl.max_per_ip(), 10);
    }
}
