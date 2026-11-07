//! One-time music-recognition token store.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use uuid::Uuid;

const TOKEN_TTL: Duration = Duration::from_secs(20);
const RATE_WINDOW: Duration = Duration::from_secs(60);
const RATE_MAX: usize = 3;

struct TokenRecord {
    conn_client_id: String,
    persistent_id: String,
    expires_at: Instant,
    pcm_snapshot: Vec<f32>,
}

#[derive(Default)]
struct ClientState {
    pending_token: String,
    issued_at: Vec<Instant>,
}

#[derive(Default)]
struct Inner {
    tokens: HashMap<String, TokenRecord>,
    clients: HashMap<String, ClientState>,
}

#[derive(Default)]
pub struct IdentifyService {
    inner: Mutex<Inner>,
}

impl IdentifyService {
    pub fn new() -> Self {
        Self::default()
    }

    /// Issues a one-time token, returning `(token, error)`. Exactly one is set.
    pub fn issue(
        &self,
        conn_client_id: &str,
        persistent_id: &str,
        pcm_snapshot: Vec<f32>,
    ) -> (String, String) {
        let mut inner = self.inner.lock();
        let now = Instant::now();

        // Purge expired tokens.
        let expired: Vec<String> = inner
            .tokens
            .iter()
            .filter(|(_, v)| now >= v.expires_at)
            .map(|(k, _)| k.clone())
            .collect();
        for key in expired {
            if let Some(v) = inner.tokens.remove(&key) {
                if let Some(cs) = inner.clients.get_mut(&v.persistent_id) {
                    if cs.pending_token == key {
                        cs.pending_token.clear();
                    }
                }
            }
        }

        // Rule 1: an unconsumed pending token exists.
        let pending = inner
            .clients
            .get(persistent_id)
            .map(|c| c.pending_token.clone())
            .unwrap_or_default();
        if !pending.is_empty() {
            if let Some(rec) = inner.tokens.get(&pending) {
                if now < rec.expires_at {
                    return (
                        String::new(),
                        "a recognition request is already pending — please wait for it to complete or expire"
                            .to_string(),
                    );
                }
            }
            if let Some(cs) = inner.clients.get_mut(persistent_id) {
                cs.pending_token.clear();
            }
        }

        // Rule 2: rate limit.
        let rate_error = {
            let cs = inner
                .clients
                .entry(persistent_id.to_string())
                .or_default();
            let cutoff = now.checked_sub(RATE_WINDOW).unwrap_or(now);
            cs.issued_at.retain(|t| *t > cutoff);
            if cs.issued_at.len() >= RATE_MAX {
                let oldest = cs.issued_at[0];
                let mut retry_in = RATE_WINDOW.as_secs() as i64
                    - now.duration_since(oldest).as_secs() as i64;
                if retry_in < 1 {
                    retry_in = 1;
                }
                Some(format!(
                    "rate limit reached — max {} recognitions per minute, retry in {}s",
                    RATE_MAX, retry_in
                ))
            } else {
                None
            }
        };
        if let Some(err) = rate_error {
            return (String::new(), err);
        }

        let token = Uuid::new_v4().to_string();
        {
            let cs = inner
                .clients
                .entry(persistent_id.to_string())
                .or_default();
            cs.pending_token = token.clone();
            cs.issued_at.push(now);
        }
        inner.tokens.insert(
            token.clone(),
            TokenRecord {
                conn_client_id: conn_client_id.to_string(),
                persistent_id: persistent_id.to_string(),
                expires_at: now + TOKEN_TTL,
                pcm_snapshot,
            },
        );

        (token, String::new())
    }

    /// Validates and consumes a token (single use).
    pub fn consume(&self, token: &str) -> Result<(String, Vec<f32>), String> {
        let mut inner = self.inner.lock();
        let rec = match inner.tokens.remove(token) {
            Some(r) => r,
            None => return Err("invalid or already used token".to_string()),
        };
        if Instant::now() >= rec.expires_at {
            return Err("token expired".to_string());
        }
        if let Some(cs) = inner.clients.get_mut(&rec.persistent_id) {
            if cs.pending_token == token {
                cs.pending_token.clear();
            }
        }
        Ok((rec.conn_client_id, rec.pcm_snapshot))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issues_and_consumes_once() {
        let svc = IdentifyService::new();
        let (token, err) = svc.issue("conn", "persistent", vec![0.1, 0.2]);
        assert!(err.is_empty());
        assert!(!token.is_empty());

        let (conn, pcm) = svc.consume(&token).unwrap();
        assert_eq!(conn, "conn");
        assert_eq!(pcm, vec![0.1, 0.2]);

        assert!(svc.consume(&token).is_err(), "token must be single-use");
    }

    #[test]
    fn rejects_second_pending_token() {
        let svc = IdentifyService::new();
        let (t1, e1) = svc.issue("c", "p", Vec::new());
        assert!(e1.is_empty());
        let (t2, e2) = svc.issue("c", "p", Vec::new());
        assert!(t2.is_empty());
        assert!(e2.contains("already pending"));
        assert!(!t1.is_empty());
    }

    #[test]
    fn rate_limits_after_three_consumed_tokens() {
        let svc = IdentifyService::new();
        for _ in 0..3 {
            let (token, err) = svc.issue("c", "p", Vec::new());
            assert!(err.is_empty());
            svc.consume(&token).unwrap();
        }
        let (token, err) = svc.issue("c", "p", Vec::new());
        assert!(token.is_empty());
        assert!(err.contains("rate limit reached"));
    }
}
