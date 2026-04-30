package ws

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAllowUpToMax(t *testing.T) {
	rl := NewRateLimiter(3)

	for i := 0; i < 3; i++ {
		if !rl.Allow("192.168.1.1") {
			t.Errorf("Allow() returned false on connection %d, expected true", i+1)
		}
	}

	if got := rl.Count("192.168.1.1"); got != 3 {
		t.Errorf("Count() = %d, want 3", got)
	}
}

func TestRejectOverMax(t *testing.T) {
	rl := NewRateLimiter(2)

	rl.Allow("10.0.0.1")
	rl.Allow("10.0.0.1")

	if rl.Allow("10.0.0.1") {
		t.Error("Allow() returned true when at max, expected false")
	}
}

func TestReleaseFreesSlot(t *testing.T) {
	rl := NewRateLimiter(2)

	rl.Allow("10.0.0.1")
	rl.Allow("10.0.0.1")

	// At max, should be rejected
	if rl.Allow("10.0.0.1") {
		t.Fatal("Should be rejected at max")
	}

	// Release one
	rl.Release("10.0.0.1")

	// Now should be allowed again
	if !rl.Allow("10.0.0.1") {
		t.Error("Allow() returned false after Release, expected true")
	}
}

func TestDifferentIPsIndependent(t *testing.T) {
	rl := NewRateLimiter(2)

	// Fill up IP1
	rl.Allow("192.168.1.1")
	rl.Allow("192.168.1.1")

	// IP2 should still be allowed
	if !rl.Allow("192.168.1.2") {
		t.Error("Allow() for different IP returned false, should be independent")
	}
	if !rl.Allow("192.168.1.2") {
		t.Error("Allow() for different IP returned false on second connection")
	}

	// IP1 should be rejected
	if rl.Allow("192.168.1.1") {
		t.Error("Allow() for IP1 should be rejected (at max)")
	}
}

func TestReleaseToZeroRemovesEntry(t *testing.T) {
	rl := NewRateLimiter(5)

	rl.Allow("10.0.0.1")
	rl.Release("10.0.0.1")

	if got := rl.Count("10.0.0.1"); got != 0 {
		t.Errorf("Count() after full release = %d, want 0", got)
	}

	// Releasing when already at 0 should not underflow
	rl.Release("10.0.0.1")
	if got := rl.Count("10.0.0.1"); got != 0 {
		t.Errorf("Count() after extra release = %d, want 0", got)
	}
}

func TestMiddlewareRejects429(t *testing.T) {
	rl := NewRateLimiter(1)

	handler := rl.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	// First request — should pass
	req1 := httptest.NewRequest("GET", "/ws", nil)
	req1.RemoteAddr = "1.2.3.4:5678"
	rec1 := httptest.NewRecorder()
	handler.ServeHTTP(rec1, req1)
	if rec1.Code != http.StatusOK {
		t.Errorf("First request: got %d, want 200", rec1.Code)
	}

	// Second request from same IP — should be rejected
	req2 := httptest.NewRequest("GET", "/ws", nil)
	req2.RemoteAddr = "1.2.3.4:5678"
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusTooManyRequests {
		t.Errorf("Second request: got %d, want 429", rec2.Code)
	}
}

func TestMiddlewareAllowsDifferentIPs(t *testing.T) {
	rl := NewRateLimiter(1)

	handler := rl.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req1 := httptest.NewRequest("GET", "/ws", nil)
	req1.RemoteAddr = "1.2.3.4:1000"
	rec1 := httptest.NewRecorder()
	handler.ServeHTTP(rec1, req1)
	if rec1.Code != http.StatusOK {
		t.Errorf("IP1: got %d, want 200", rec1.Code)
	}

	req2 := httptest.NewRequest("GET", "/ws", nil)
	req2.RemoteAddr = "5.6.7.8:2000"
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Errorf("IP2: got %d, want 200", rec2.Code)
	}
}
