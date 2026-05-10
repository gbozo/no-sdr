package ws

import (
	"net/http"
	"sync"
)

// RateLimiter limits WebSocket connections per IP.
type RateLimiter struct {
	maxPerIP int
	conns    map[string]int
	mu       sync.Mutex
}

// NewRateLimiter creates a rate limiter with the given max connections per IP.
func NewRateLimiter(maxPerIP int) *RateLimiter {
	if maxPerIP <= 0 {
		maxPerIP = 10
	}
	return &RateLimiter{
		maxPerIP: maxPerIP,
		conns:    make(map[string]int),
	}
}

// Allow checks if a new connection from this IP is allowed.
// Returns true and increments counter if allowed.
func (rl *RateLimiter) Allow(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	if rl.conns[ip] >= rl.maxPerIP {
		return false
	}
	rl.conns[ip]++
	return true
}

// Release decrements the counter for an IP (call on disconnect).
func (rl *RateLimiter) Release(ip string) {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	if rl.conns[ip] > 0 {
		rl.conns[ip]--
	}
	if rl.conns[ip] == 0 {
		delete(rl.conns, ip)
	}
}

// Count returns the current connection count for an IP.
func (rl *RateLimiter) Count(ip string) int {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	return rl.conns[ip]
}

// Middleware returns an HTTP middleware that rejects connections over the limit.
// It extracts the client IP via the provided resolver function. Pass
// Manager.ResolveClientIP so the same header logic applies everywhere.
// If resolver is nil, r.RemoteAddr is used (works when chi's RealIP middleware
// is active for X-Forwarded-For / X-Real-IP).
func (rl *RateLimiter) Middleware(resolver func(r *http.Request) string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var ip string
			if resolver != nil {
				ip = resolver(r)
			} else {
				ip = r.RemoteAddr
			}

			if !rl.Allow(ip) {
				http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
				return
			}

			next.ServeHTTP(w, r)
			// Note: Release is NOT called here because WebSocket connections persist.
			// The caller (WS Manager) must call Release(ip) when the connection closes.
		})
	}
}
