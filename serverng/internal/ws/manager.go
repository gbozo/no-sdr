package ws

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
)

// Manager handles WebSocket client connections and broadcasting.
type Manager struct {
	clients      map[string]*Client
	mu           sync.RWMutex
	logger       *slog.Logger
	onCommand    func(clientID string, cmd *ClientCommand)
	onDisconnect func(clientID string)
	onConnect    func(clientID string)
	rateLimiter  *RateLimiter
	allowed      AllowedCodecs
	realIPHeader string // HTTP header to read real client IP from (proxy/tunnel support)

	// maxFftFps is the highest FFT frame rate across all active profiles.
	// Used to size the per-client write channel so that even at high fps
	// a client gets ~3s of headroom before drop-oldest kicks in.
	// Set via SetMaxFftFps() before clients connect.
	maxFftFps int

	// staleOnce ensures the stale-client checker is started exactly once.
	staleOnce sync.Once
}

// NewManager creates a new WebSocket connection manager.
func NewManager(logger *slog.Logger) *Manager {
	if logger == nil {
		logger = slog.Default()
	}
	return &Manager{
		clients:   make(map[string]*Client),
		logger:    logger,
		allowed:   defaultAllowedCodecs,
		maxFftFps: 30, // default; override with SetMaxFftFps
	}
}

// SetMaxFftFps sets the maximum FFT frame rate across all active profiles.
// This controls write-channel capacity: cap = fps*3 + 64 (3s of FFT + IQ/META slack).
// Must be called before any clients connect.
func (m *Manager) SetMaxFftFps(fps int) {
	if fps <= 0 {
		fps = 30
	}
	m.mu.Lock()
	m.maxFftFps = fps
	m.mu.Unlock()
}

// writeChanCap returns the write channel capacity for new clients.
// Sized to hold 3 seconds of FFT frames + 64 slots for IQ/META/audio messages.
func (m *Manager) writeChanCap() int {
	m.mu.RLock()
	fps := m.maxFftFps
	m.mu.RUnlock()
	cap := fps*3 + 64
	if cap < DefaultWriteChSize {
		cap = DefaultWriteChSize
	}
	return cap
}

// SetAllowedCodecs replaces the server's allowed codec sets.
// Must be called before any clients connect.
func (m *Manager) SetAllowedCodecs(fft, iq []string) {
	fftMap := make(map[string]bool, len(fft))
	for _, c := range fft {
		fftMap[c] = true
	}
	iqMap := make(map[string]bool, len(iq))
	for _, c := range iq {
		iqMap[c] = true
	}
	m.mu.Lock()
	m.allowed = AllowedCodecs{Fft: fftMap, Iq: iqMap}
	m.mu.Unlock()
}

// SetRateLimiter sets the rate limiter for tracking connection IPs.
func (m *Manager) SetRateLimiter(rl *RateLimiter) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rateLimiter = rl
}

// SetRealIPHeader configures which HTTP header carries the real client IP when the
// server is behind a reverse proxy or tunnel. Common values:
//   - "CF-Connecting-IP"  (Cloudflare)
//   - "X-Real-IP"         (nginx)
//   - "X-Forwarded-For"   (generic proxies — first value used)
//
// When empty (default) the TCP RemoteAddr is used as-is.
// Safe to call while the server is running; takes effect on the next connection.
func (m *Manager) SetRealIPHeader(header string) {
	m.mu.Lock()
	m.realIPHeader = header
	m.mu.Unlock()
}

// ResolveClientIP extracts the real client IP from the request. When a proxy
// header is configured its value takes precedence over RemoteAddr.
// Returns (resolved, raw):
//   - resolved: the usable IP string (first entry of X-Forwarded-For, full value
//     for other headers, or r.RemoteAddr as fallback)
//   - raw: the verbatim header value; empty when no proxy header is configured
//
// This is exported so rate-limiting middleware can use the same header logic.
func (m *Manager) ResolveClientIP(r *http.Request) string {
	resolved, _ := m.resolveClientIPFull(r)
	return resolved
}

// resolveClientIPFull returns both the resolved IP and the raw header value.
func (m *Manager) resolveClientIPFull(r *http.Request) (resolved, raw string) {
	m.mu.RLock()
	hdr := m.realIPHeader
	m.mu.RUnlock()

	if hdr != "" {
		if val := r.Header.Get(hdr); val != "" {
			raw = val
			// X-Forwarded-For can be "client, proxy1, proxy2" — use first entry
			for i := 0; i < len(val); i++ {
				if val[i] == ',' {
					return strings.TrimSpace(val[:i]), raw
				}
			}
			return strings.TrimSpace(val), raw
		}
	}
	return r.RemoteAddr, ""
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

// SetConnectHandler registers a callback invoked after a new client connects
// and receives its welcome message. Used by dongle manager to send state_sync.
func (m *Manager) SetConnectHandler(fn func(clientID string)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onConnect = fn
}

// SetClientProfileID sets the active profile ID on a connected client.
// Called by the dongle manager when a client subscribes or when the profile changes.
func (m *Manager) SetClientProfileID(clientID, profileID string) {
	m.mu.RLock()
	client, ok := m.clients[clientID]
	m.mu.RUnlock()
	if !ok {
		return
	}
	client.mu.Lock()
	client.ProfileID = profileID
	client.mu.Unlock()
}

// ApplyProfileChangeToClient updates a client's state for a profile switch.
// Resets mode, bandwidth, and tune offset to match the new profile.
func (m *Manager) ApplyProfileChangeToClient(clientID, profileID, mode string, bandwidth int) {
	m.mu.RLock()
	client, ok := m.clients[clientID]
	m.mu.RUnlock()
	if !ok {
		return
	}
	client.ApplyProfileChange(profileID, mode, bandwidth)
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

	// Internal connection ID (ephemeral, for routing within this process)
	connID := uuid.New().String()

	// Persistent client ID — stable across reconnects.
	// Client sends it as ?clientId= query param. Server validates and accepts or generates new.
	persistentID := m.resolveClientID(r.URL.Query().Get("clientId"))

	// Determine connection index for this persistent ID (multi-tab support)
	connIndex := m.nextConnIndex(persistentID)

	// Use a background context for the client lifecycle — the websocket
	// connection outlives the HTTP request context.
	ctx, cancel := context.WithCancel(context.Background())
	client := newClient(connID, conn, ctx, cancel, m.writeChanCap())
	client.PersistentID = persistentID
	client.ConnIndex = connIndex
	clientIP, rawIP := m.resolveClientIPFull(r)
	client.RemoteAddr = clientIP
	client.RealIP = rawIP

	m.addClient(client)
	m.logger.Info("client connected", "connId", connID, "persistentId", persistentID, "remote", clientIP, "realIP", rawIP)

	// Start the stale-client checker the first time any client connects.
	m.staleOnce.Do(func() {
		go m.staleCheckerLoop(context.Background())
	})

	// Send welcome message with server capabilities and the authoritative client ID
	m.mu.RLock()
	allowedFft := make([]string, 0, len(m.allowed.Fft))
	for k := range m.allowed.Fft {
		allowedFft = append(allowedFft, k)
	}
	allowedIq := make([]string, 0, len(m.allowed.Iq))
	for k := range m.allowed.Iq {
		allowedIq = append(allowedIq, k)
	}
	m.mu.RUnlock()
	welcome := PackMetaMessage(&ServerMeta{
		Type:             "welcome",
		ClientId:         persistentID,
		ConnIndex:        connIndex,
		ServerVersion:    "2.6.8",
		AllowedFftCodecs: allowedFft,
		AllowedIqCodecs:  allowedIq,
	})
	client.Send(welcome)

	// Fire connect handler (dongle manager uses this to send state_sync)
	if m.onConnect != nil {
		m.onConnect(connID)
	}

	// Start read, write, and ping goroutines
	go m.readLoop(client)
	go m.writeLoop(client)
	go m.pingLoop(client)
}

// resolveClientID validates a client-provided ID string.
// Returns the same ID if it's a valid UUID, or generates a new UUID otherwise.
func (m *Manager) resolveClientID(provided string) string {
	if provided == "" {
		return uuid.New().String()
	}
	// Validate: must be a valid UUID (parse accepts standard 36-char and other formats)
	parsed, err := uuid.Parse(provided)
	if err != nil {
		m.logger.Warn("client sent invalid ID, generating new", "provided", provided)
		return uuid.New().String()
	}
	return parsed.String()
}

// nextConnIndex returns the next connection index for a persistent client ID.
// Counts existing connections with the same persistentID and returns max+1.
func (m *Manager) nextConnIndex(persistentID string) int {
	m.mu.RLock()
	defer m.mu.RUnlock()

	maxIndex := 0
	for _, c := range m.clients {
		if c.PersistentID == persistentID && c.ConnIndex > maxIndex {
			maxIndex = c.ConnIndex
		}
	}
	return maxIndex + 1
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

// UnsubscribeFromDongle unsubscribes all clients from a specific dongle and sends
// them a META message informing them the dongle is being reinitialised.
// Returns the list of affected client IDs.
func (m *Manager) UnsubscribeFromDongle(dongleID string, reason string) []string {
	m.mu.RLock()
	var affected []*Client
	for _, client := range m.clients {
		if client.SubscribedTo() == dongleID {
			affected = append(affected, client)
		}
	}
	m.mu.RUnlock()

	var ids []string
	for _, client := range affected {
		client.Unsubscribe()
		ids = append(ids, client.ID)

		// Send dongle_disconnected META to inform the client
		meta := PackMetaMessage(&ServerMeta{
			Type:     "dongle_disconnected",
			DongleId: dongleID,
			Message:  reason,
		})
		client.Send(meta)
	}
	return ids
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
	if ok {
		delete(m.clients, clientID)
	}
	handler := m.onDisconnect
	rl := m.rateLimiter
	m.mu.Unlock()

	if ok {
		ip := client.RemoteAddr
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
		m.mu.RLock()
		allowed := m.allowed
		m.mu.RUnlock()
		codecStatus := c.UpdateFromCommand(cmd, &allowed)

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

	const writeTimeout = 10 * time.Second

	for {
		select {
		case <-c.ctx.Done():
			return
		case msg, ok := <-c.writeCh:
			if !ok {
				return
			}
			writeCtx, cancel := context.WithTimeout(c.ctx, writeTimeout)
			err := c.conn.Write(writeCtx, websocket.MessageBinary, msg)
			cancel()
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

// pingLoop sends a WebSocket ping every 15 seconds.
// If the client doesn't respond within 10 seconds, it is considered dead
// and the context is cancelled, triggering cleanup via readLoop/writeLoop.
func (m *Manager) pingLoop(c *Client) {
	const pingInterval = 15 * time.Second
	const pingTimeout = 10 * time.Second

	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-c.ctx.Done():
			return
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(c.ctx, pingTimeout)
			err := c.conn.Ping(pingCtx)
			cancel()
			if err != nil {
				m.logger.Debug("ping failed, disconnecting client",
					"id", c.ID,
					"error", err,
				)
				// Cancel the client context — readLoop and writeLoop will exit
				// and call removeClient/handleDisconnect.
				c.cancel()
				return
			}
		}
	}
}

// staleCheckerLoop runs every 5 seconds and cancels clients whose write channel
// has been persistently full. A client is considered stale when:
//   - Its writeCh is at 100% capacity, AND
//   - It has not drained a single message in the last 10 seconds.
//
// This is much more lenient than disconnecting on the first full-channel event,
// allowing brief bursts (GC pauses, browser tab backgrounding) without dropping
// valid waterfall clients.
func (m *Manager) staleCheckerLoop(ctx context.Context) {
	const checkInterval = 5 * time.Second
	const staleThreshold = 10 * time.Second

	ticker := time.NewTicker(checkInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.mu.RLock()
			var stale []*Client
			for _, c := range m.clients {
				if c.IsStale(staleThreshold) {
					stale = append(stale, c)
				}
			}
			m.mu.RUnlock()

			for _, c := range stale {
				m.logger.Info("stale client detected, disconnecting",
					"id", c.ID,
					"writeCh_len", len(c.writeCh),
					"writeCh_cap", cap(c.writeCh),
				)
				c.cancel()
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

// ClientInfo holds a snapshot of client state for the admin API.
type ClientInfo struct {
	ID            string    `json:"id"`
	PersistentID  string    `json:"persistentId"`
	ConnIndex     int       `json:"connIndex"`
	IP            string    `json:"ip"`
	RealIP        string    `json:"realIp,omitempty"` // raw proxy header value; empty when not behind proxy
	DongleID      string    `json:"dongleId"`
	ProfileID     string    `json:"profileId"`
	FftCodec      string    `json:"fftCodec"`
	IqCodec       string    `json:"iqCodec"`
	Mode          string    `json:"mode"`
	TuneOffset    int       `json:"tuneOffset"`
	Bandwidth     int       `json:"bandwidth"`
	AudioEnabled  bool      `json:"audioEnabled"`
	StereoEnabled bool      `json:"stereoEnabled"`
	ConnectedAt   time.Time `json:"connectedAt"`
}

// GetAllClients returns a snapshot of all connected clients for admin monitoring.
func (m *Manager) GetAllClients() []ClientInfo {
	m.mu.RLock()
	defer m.mu.RUnlock()

	result := make([]ClientInfo, 0, len(m.clients))
	for _, c := range m.clients {
		c.mu.RLock()
		info := ClientInfo{
			ID:            c.ID,
			PersistentID:  c.PersistentID,
			ConnIndex:     c.ConnIndex,
			IP:            c.RemoteAddr,
			RealIP:        c.RealIP,
			DongleID:      c.DongleID,
			ProfileID:     c.ProfileID,
			FftCodec:      c.FftCodec,
			IqCodec:       c.IqCodec,
			Mode:          c.Mode,
			TuneOffset:    c.TuneOffset,
			Bandwidth:     c.Bandwidth,
			AudioEnabled:  c.AudioEnabled,
			StereoEnabled: c.StereoEnabled,
			ConnectedAt:   c.ConnectedAt,
		}
		c.mu.RUnlock()
		result = append(result, info)
	}
	return result
}
