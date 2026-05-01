package ws

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"

	"github.com/coder/websocket"
	"github.com/google/uuid"
)

// Manager handles WebSocket client connections and broadcasting.
type Manager struct {
	clients      map[string]*Client
	clientIPs    map[string]string // clientID -> IP address
	mu           sync.RWMutex
	logger       *slog.Logger
	onCommand    func(clientID string, cmd *ClientCommand)
	onDisconnect func(clientID string)
	rateLimiter  *RateLimiter
}

// NewManager creates a new WebSocket connection manager.
func NewManager(logger *slog.Logger) *Manager {
	if logger == nil {
		logger = slog.Default()
	}
	return &Manager{
		clients:   make(map[string]*Client),
		clientIPs: make(map[string]string),
		logger:    logger,
	}
}

// SetRateLimiter sets the rate limiter for tracking connection IPs.
func (m *Manager) SetRateLimiter(rl *RateLimiter) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rateLimiter = rl
}

// SetCommandHandler registers a callback for client commands.
// The handler is called from the client's read goroutine.
func (m *Manager) SetCommandHandler(fn func(clientID string, cmd *ClientCommand)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onCommand = fn
}

// SetDisconnectHandler registers a callback invoked when a client disconnects.
// The handler is called after the client is removed from the client map.
func (m *Manager) SetDisconnectHandler(fn func(clientID string)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onDisconnect = fn
}

// HandleUpgrade is the HTTP handler for WebSocket upgrade requests.
// Use with chi: r.Get("/ws", mgr.HandleUpgrade)
func (m *Manager) HandleUpgrade(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"*"},
	})
	if err != nil {
		m.logger.Error("websocket upgrade failed", "error", err)
		return
	}

	clientID := uuid.New().String()
	// Use a background context for the client lifecycle — the websocket
	// connection outlives the HTTP request context.
	ctx, cancel := context.WithCancel(context.Background())
	client := newClient(clientID, conn, ctx, cancel)

	// Track client IP for rate limiter release on disconnect
	m.mu.Lock()
	m.clientIPs[clientID] = r.RemoteAddr
	m.mu.Unlock()

	m.addClient(client)
	m.logger.Info("client connected", "id", clientID, "remote", r.RemoteAddr)

	// Send welcome message (matches Node.js behavior)
	welcome := PackMetaMessage(&ServerMeta{
		Type:          "welcome",
		ClientId:      clientID,
		ServerVersion: "2.0.0",
	})
	client.Send(welcome)

	// Start read and write goroutines
	go m.readLoop(client)
	go m.writeLoop(client)
}

// Broadcast sends a binary message to all clients subscribed to a dongle.
func (m *Manager) Broadcast(dongleID string, msg []byte) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	for _, client := range m.clients {
		if client.SubscribedTo() == dongleID {
			client.Send(msg)
		}
	}
}

// BroadcastAll sends a binary message to ALL connected clients regardless of subscription.
func (m *Manager) BroadcastAll(msg []byte) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	for _, client := range m.clients {
		client.Send(msg)
	}
}

// SendTo sends a binary message to a specific client by ID.
func (m *Manager) SendTo(clientID string, msg []byte) {
	m.mu.RLock()
	client, ok := m.clients[clientID]
	m.mu.RUnlock()

	if ok {
		client.Send(msg)
	}
}

// ClientCount returns the number of connected clients.
func (m *Manager) ClientCount() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.clients)
}

// SubscribedClients returns clients subscribed to a specific dongle.
func (m *Manager) SubscribedClients(dongleID string) []*Client {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var result []*Client
	for _, client := range m.clients {
		if client.SubscribedTo() == dongleID {
			result = append(result, client)
		}
	}
	return result
}

// GetClient returns a client by ID, or nil if not found.
func (m *Manager) GetClient(clientID string) *Client {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.clients[clientID]
}

// Shutdown gracefully closes all client connections.
func (m *Manager) Shutdown(ctx context.Context) {
	m.mu.Lock()
	clients := make([]*Client, 0, len(m.clients))
	for _, c := range m.clients {
		clients = append(clients, c)
	}
	m.mu.Unlock()

	for _, c := range clients {
		c.conn.Close(websocket.StatusGoingAway, "server shutting down")
		c.cancel()
	}

	// Wait briefly for goroutines to drain
	m.logger.Info("websocket manager shut down", "clients_closed", len(clients))
}

// addClient adds a client to the manager's map.
func (m *Manager) addClient(c *Client) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.clients[c.ID] = c
}

// removeClient removes a client from the manager's map and closes resources.
func (m *Manager) removeClient(clientID string) {
	m.mu.Lock()
	client, ok := m.clients[clientID]
	ip := m.clientIPs[clientID]
	if ok {
		delete(m.clients, clientID)
		delete(m.clientIPs, clientID)
	}
	handler := m.onDisconnect
	rl := m.rateLimiter
	m.mu.Unlock()

	if ok {
		client.cancel()
		client.conn.Close(websocket.StatusNormalClosure, "")
		m.logger.Info("client disconnected", "id", clientID)

		// Release rate limiter slot
		if rl != nil && ip != "" {
			rl.Release(ip)
		}

		if handler != nil {
			handler(clientID)
		}
	}
}

// readLoop reads JSON text messages from the client and dispatches commands.
func (m *Manager) readLoop(c *Client) {
	defer m.removeClient(c.ID)

	for {
		msgType, data, err := c.conn.Read(c.ctx)
		if err != nil {
			// Context cancelled or connection closed — normal disconnect
			return
		}

		if msgType != websocket.MessageText {
			m.logger.Warn("unexpected binary message from client", "id", c.ID)
			continue
		}

		cmd, err := ParseClientCommand(data)
		if err != nil {
			m.logger.Warn("invalid command from client",
				"id", c.ID,
				"error", err,
				"raw", string(data),
			)
			continue
		}

		// Update client state
		codecStatus := c.UpdateFromCommand(cmd)

		// If codec was rejected, send status back to client
		if codecStatus != nil {
			statusMsg := PackCodecStatusMessage(codecStatus)
			c.Send(statusMsg)
		}

		// Dispatch to external handler
		m.mu.RLock()
		handler := m.onCommand
		m.mu.RUnlock()

		if handler != nil {
			handler(c.ID, cmd)
		}

		m.logger.Debug("client command",
			"id", c.ID,
			"cmd", cmd.Cmd,
			"dongle", c.DongleID,
		)
	}
}

// writeLoop drains the client's write channel and sends binary messages.
func (m *Manager) writeLoop(c *Client) {
	defer m.removeClient(c.ID)

	for {
		select {
		case <-c.ctx.Done():
			return
		case msg, ok := <-c.writeCh:
			if !ok {
				return
			}
			err := c.conn.Write(c.ctx, websocket.MessageBinary, msg)
			if err != nil {
				m.logger.Debug("write error, disconnecting client",
					"id", c.ID,
					"error", err,
				)
				return
			}
		}
	}
}

// SendJSON sends a JSON text message to a specific client (for meta, etc.).
func (m *Manager) SendJSON(clientID string, v any) error {
	m.mu.RLock()
	client, ok := m.clients[clientID]
	m.mu.RUnlock()

	if !ok {
		return nil
	}

	data, err := json.Marshal(v)
	if err != nil {
		return err
	}

	return client.conn.Write(client.ctx, websocket.MessageText, data)
}
