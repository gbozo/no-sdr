package ws

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// drainWelcome reads and discards the initial welcome message sent on connect.
func drainWelcome(t *testing.T, conn *websocket.Conn, ctx context.Context) {
	t.Helper()
	readCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	_, _, err := conn.Read(readCtx)
	if err != nil {
		t.Fatalf("failed to drain welcome message: %v", err)
	}
}

func TestManagerStartsEmpty(t *testing.T) {
	mgr := NewManager(slog.Default())
	if mgr.ClientCount() != 0 {
		t.Fatalf("expected 0 clients, got %d", mgr.ClientCount())
	}
}

func TestManagerNilLogger(t *testing.T) {
	mgr := NewManager(nil)
	if mgr.logger == nil {
		t.Fatal("expected non-nil logger when passing nil")
	}
	if mgr.ClientCount() != 0 {
		t.Fatalf("expected 0 clients, got %d", mgr.ClientCount())
	}
}

// setupTestServer creates a test HTTP server with the manager handling /ws.
func setupTestServer(t *testing.T, mgr *Manager) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", mgr.HandleUpgrade)
	return httptest.NewServer(mux)
}

// dialWS connects a websocket client to the test server.
func dialWS(t *testing.T, srv *httptest.Server) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("failed to dial websocket: %v", err)
	}
	return conn
}

func TestClientConnectsAndDisconnects(t *testing.T) {
	mgr := NewManager(slog.Default())
	srv := setupTestServer(t, mgr)
	defer srv.Close()

	conn := dialWS(t, srv)

	// Wait for client to be registered
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if mgr.ClientCount() == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	if mgr.ClientCount() != 1 {
		t.Fatalf("expected 1 client, got %d", mgr.ClientCount())
	}

	// Disconnect
	conn.Close(websocket.StatusNormalClosure, "done")

	// Wait for removal
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if mgr.ClientCount() == 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	if mgr.ClientCount() != 0 {
		t.Fatalf("expected 0 clients after disconnect, got %d", mgr.ClientCount())
	}
}

func TestCommandHandlerCalled(t *testing.T) {
	mgr := NewManager(slog.Default())

	var receivedCmd *ClientCommand
	var receivedID string
	var mu sync.Mutex
	done := make(chan struct{})

	mgr.SetCommandHandler(func(clientID string, cmd *ClientCommand) {
		mu.Lock()
		receivedID = clientID
		receivedCmd = cmd
		mu.Unlock()
		select {
		case done <- struct{}{}:
		default:
		}
	})

	srv := setupTestServer(t, mgr)
	defer srv.Close()

	conn := dialWS(t, srv)
	defer conn.Close(websocket.StatusNormalClosure, "done")

	// Wait for registration
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if mgr.ClientCount() == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Send a subscribe command
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err := conn.Write(ctx, websocket.MessageText, []byte(`{"cmd":"subscribe","dongleId":"dongle-1"}`))
	if err != nil {
		t.Fatalf("failed to write command: %v", err)
	}

	// Wait for handler
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for command handler")
	}

	mu.Lock()
	defer mu.Unlock()

	if receivedCmd == nil {
		t.Fatal("command handler was not called")
	}
	if receivedCmd.Cmd != "subscribe" {
		t.Fatalf("expected cmd 'subscribe', got %q", receivedCmd.Cmd)
	}
	if receivedCmd.DongleId != "dongle-1" {
		t.Fatalf("expected dongleId 'dongle-1', got %q", receivedCmd.DongleId)
	}
	if receivedID == "" {
		t.Fatal("expected non-empty client ID")
	}
}

func TestBroadcastOnlyReachesSubscribedClients(t *testing.T) {
	mgr := NewManager(slog.Default())
	srv := setupTestServer(t, mgr)
	defer srv.Close()
	ctx := context.Background()

	// Connect two clients
	conn1 := dialWS(t, srv)
	defer conn1.Close(websocket.StatusNormalClosure, "done")
	conn2 := dialWS(t, srv)
	defer conn2.Close(websocket.StatusNormalClosure, "done")

	// Drain welcome messages
	drainWelcome(t, conn1, context.Background())
	drainWelcome(t, conn2, context.Background())

	// Wait for clients to register
	time.Sleep(50 * time.Millisecond)

	// Subscribe client 1 to dongle-a
	err := conn1.Write(ctx, websocket.MessageText, []byte(`{"cmd":"subscribe","dongleId":"dongle-a"}`))

	if err != nil {
		t.Fatalf("failed to write: %v", err)
	}

	// Subscribe client 2 to "dongle-b"
	err = conn2.Write(ctx, websocket.MessageText, []byte(`{"cmd":"subscribe","dongleId":"dongle-b"}`))
	if err != nil {
		t.Fatalf("failed to write: %v", err)
	}

	// Give time for commands to be processed
	time.Sleep(100 * time.Millisecond)

	// Broadcast to dongle-a
	testMsg := []byte{MsgFFTCompressed, 0x01, 0x02, 0x03}
	mgr.Broadcast("dongle-a", testMsg)

	// Client 1 should receive the message
	readCtx, readCancel := context.WithTimeout(ctx, 2*time.Second)
	defer readCancel()
	msgType, data, err := conn1.Read(readCtx)
	if err != nil {
		t.Fatalf("client 1 failed to read: %v", err)
	}
	if msgType != websocket.MessageBinary {
		t.Fatalf("expected binary message, got %v", msgType)
	}
	if len(data) != len(testMsg) {
		t.Fatalf("expected %d bytes, got %d", len(testMsg), len(data))
	}

	// Client 2 should NOT receive the message (use short timeout)
	readCtx2, readCancel2 := context.WithTimeout(ctx, 200*time.Millisecond)
	defer readCancel2()
	_, _, err = conn2.Read(readCtx2)
	if err == nil {
		t.Fatal("client 2 should not have received message for dongle-a")
	}
}

func TestSendToSpecificClient(t *testing.T) {
	mgr := NewManager(slog.Default())
	srv := setupTestServer(t, mgr)
	defer srv.Close()

	conn := dialWS(t, srv)
	defer conn.Close(websocket.StatusNormalClosure, "done")

	// Drain welcome
	drainWelcome(t, conn, context.Background())

	// Wait for registration
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if mgr.ClientCount() == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Get client ID
	mgr.mu.RLock()
	var clientID string
	for id := range mgr.clients {
		clientID = id
	}
	mgr.mu.RUnlock()

	if clientID == "" {
		t.Fatal("no client ID found")
	}

	// SendTo
	testMsg := []byte{MsgIQ, 0xAA, 0xBB}
	mgr.SendTo(clientID, testMsg)

	// Read from client
	readCtx, readCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer readCancel()
	msgType, data, err := conn.Read(readCtx)
	if err != nil {
		t.Fatalf("failed to read: %v", err)
	}
	if msgType != websocket.MessageBinary {
		t.Fatalf("expected binary, got %v", msgType)
	}
	if len(data) != 3 || data[0] != MsgIQ || data[1] != 0xAA || data[2] != 0xBB {
		t.Fatalf("unexpected data: %v", data)
	}
}

func TestSubscribedClients(t *testing.T) {
	mgr := NewManager(slog.Default())
	srv := setupTestServer(t, mgr)
	defer srv.Close()

	conn1 := dialWS(t, srv)
	defer conn1.Close(websocket.StatusNormalClosure, "done")
	conn2 := dialWS(t, srv)
	defer conn2.Close(websocket.StatusNormalClosure, "done")

	// Drain welcome messages
	drainWelcome(t, conn1, context.Background())
	drainWelcome(t, conn2, context.Background())

	// Wait for both
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if mgr.ClientCount() == 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	ctx := context.Background()
	conn1.Write(ctx, websocket.MessageText, []byte(`{"cmd":"subscribe","dongleId":"test-dongle"}`))
	conn2.Write(ctx, websocket.MessageText, []byte(`{"cmd":"subscribe","dongleId":"other-dongle"}`))

	time.Sleep(100 * time.Millisecond)

	subs := mgr.SubscribedClients("test-dongle")
	if len(subs) != 1 {
		t.Fatalf("expected 1 subscribed client, got %d", len(subs))
	}
	if subs[0].DongleID != "test-dongle" {
		t.Fatalf("expected DongleID 'test-dongle', got %q", subs[0].DongleID)
	}
}

func TestShutdown(t *testing.T) {
	mgr := NewManager(slog.Default())
	srv := setupTestServer(t, mgr)
	defer srv.Close()

	conn := dialWS(t, srv)
	defer conn.Close(websocket.StatusNormalClosure, "done")

	// Drain welcome
	drainWelcome(t, conn, context.Background())

	// Wait for registration
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if mgr.ClientCount() == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Shutdown
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	mgr.Shutdown(ctx)

	// Client should get disconnected
	time.Sleep(200 * time.Millisecond)

	// Trying to read should fail
	readCtx, readCancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer readCancel()
	_, _, err := conn.Read(readCtx)
	if err == nil {
		t.Fatal("expected error after shutdown, got nil")
	}
}

func TestBackpressureDropsOldest(t *testing.T) {
	// Unit test the backpressure behavior directly on a Client
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	c := &Client{
		ID:      "test",
		ctx:     ctx,
		cancel:  cancel,
		writeCh: make(chan []byte, 3), // small buffer for testing
	}

	// Fill the channel
	c.Send([]byte{1})
	c.Send([]byte{2})
	c.Send([]byte{3})

	// Channel is full — next Send should drop oldest (1) and enqueue (4)
	c.Send([]byte{4})

	// Drain and check: should get 2, 3, 4 (1 was dropped)
	msg1 := <-c.writeCh
	msg2 := <-c.writeCh
	msg3 := <-c.writeCh

	if msg1[0] != 2 {
		t.Fatalf("expected first message to be 2, got %d", msg1[0])
	}
	if msg2[0] != 3 {
		t.Fatalf("expected second message to be 3, got %d", msg2[0])
	}
	if msg3[0] != 4 {
		t.Fatalf("expected third message to be 4, got %d", msg3[0])
	}
}
