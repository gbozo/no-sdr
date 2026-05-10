package ws

import (
	"context"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	// DefaultWriteChSize is the buffered channel capacity for write messages.
	// Must accommodate FFT (up to 30fps) + IQ (50fps) + META + stats.
	// At 80 msg/sec, 128 slots gives ~1.5s of buffering before drop.
	DefaultWriteChSize = 128
)

// Client represents a connected WebSocket client.
type Client struct {
	ID           string // Internal connection ID (changes on each reconnect)
	PersistentID string // Client-facing UUID (stable across reconnects, stored in browser localStorage)
	ConnIndex    int    // Connection index for this persistent ID (1, 2, 3... for multi-tab)
	conn         *websocket.Conn
	ctx          context.Context
	cancel       context.CancelFunc

	// Subscription state — written only from the read goroutine.
	DongleID       string
	ProfileID      string // Active profile ID on the subscribed dongle
	AudioEnabled   bool
	StereoEnabled  bool
	FftCodec       string // "none", "adpcm", "deflate"
	IqCodec        string // "none", "adpcm", "opus-lo", "opus", "opus-hq"
	Mode           string
	TuneOffset     int
	Bandwidth      int

	// ConnectedAt records when the client connected.
	ConnectedAt time.Time

	// RemoteAddr is the resolved client IP address. When a proxy header is
	// configured this is the value extracted from that header (first entry for
	// X-Forwarded-For lists). Falls back to the TCP remote address.
	RemoteAddr string

	// RealIP is the raw value of the configured proxy header (e.g. the full
	// X-Forwarded-For chain or the CF-Connecting-IP value). Empty when no
	// proxy header is configured; identical to RemoteAddr for single-value
	// headers.
	RealIP string

	// Write channel with backpressure
	writeCh chan []byte

	// lastDrainAt is updated each time Send() successfully enqueues a message.
	// The stale-client checker uses this to detect clients that have stopped
	// draining their write channel (dead tab, frozen connection).
	lastDrainAt time.Time
	drainMu     sync.Mutex

	mu sync.RWMutex
}

// newClient creates a new Client with the given connection, ID, and write channel capacity.
// Codec defaults are empty — server uses "none" (uint8 FFT) until client sends preferences.
func newClient(id string, conn *websocket.Conn, ctx context.Context, cancel context.CancelFunc, writeCap int) *Client {
	if writeCap <= 0 {
		writeCap = DefaultWriteChSize
	}
	return &Client{
		ID:          id,
		conn:        conn,
		ctx:         ctx,
		cancel:      cancel,
		FftCodec:      "",   // empty = "none" — client sends preferred codec after subscribe
		IqCodec:       "",   // empty = "none" — client sends preferred codec after subscribe
		StereoEnabled: true, // default true until client sends stereo_enabled=false
		ConnectedAt: time.Now(),
		writeCh:     make(chan []byte, writeCap),
		lastDrainAt: time.Now(),
	}
}

// Send enqueues a message for writing. If the channel is full the oldest
// pending message is dropped to make room (backpressure: prefer fresh data).
// lastDrainAt is updated on every successful enqueue; the manager's stale-
// client checker uses this to detect clients that have stopped consuming.
func (c *Client) Send(msg []byte) {
	select {
	case c.writeCh <- msg:
		// Fast path — channel has room, update drain timestamp.
		c.drainMu.Lock()
		c.lastDrainAt = time.Now()
		c.drainMu.Unlock()
	default:
		// Channel full — drop the oldest message and enqueue the new one so
		// that the client always sees the most recent data (waterfall/audio).
		select {
		case <-c.writeCh:
		default:
		}
		select {
		case c.writeCh <- msg:
		default:
		}
		// Do NOT update lastDrainAt — the checker will detect persistent fullness.
	}
}

// IsStale returns true if the write channel is at capacity AND the client has
// not drained any message in the last `threshold` duration. This identifies
// genuinely dead connections vs momentary congestion.
func (c *Client) IsStale(threshold time.Duration) bool {
	if len(c.writeCh) < cap(c.writeCh) {
		return false // channel has room — client is draining normally
	}
	c.drainMu.Lock()
	last := c.lastDrainAt
	c.drainMu.Unlock()
	return time.Since(last) > threshold
}

// Close cancels the client context, which triggers cleanup.
func (c *Client) Close() {
	c.cancel()
}

// SubscribedTo returns the dongle ID this client is subscribed to.
// Safe to call concurrently (protected by mu).
func (c *Client) SubscribedTo() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.DongleID
}

// Unsubscribe clears the client's dongle subscription.
// Used when a dongle is reinitialised or removed to force clients to re-negotiate.
func (c *Client) Unsubscribe() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.DongleID = ""
	c.ProfileID = ""
}

// ApplyProfileChange updates the client's state when the server switches profiles.
// This ensures ws.Client fields stay in sync with the pipeline state.
func (c *Client) ApplyProfileChange(profileID, mode string, bandwidth int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.ProfileID = profileID
	c.Mode = mode
	c.Bandwidth = bandwidth
	c.TuneOffset = 0 // offset is invalid for new center frequency
}

// AllowedCodecs holds the codec sets the server will accept from clients.
// Set once at startup by the Manager; safe to read concurrently (never mutated after init).
type AllowedCodecs struct {
	Fft map[string]bool
	Iq  map[string]bool
}

// defaultAllowedCodecs is used in tests and when no config is provided.
var defaultAllowedCodecs = AllowedCodecs{
	Fft: map[string]bool{"none": true, "adpcm": true, "deflate": true, "deflate-floor": true},
	Iq:  map[string]bool{"none": true, "adpcm": true, "opus-lo": true, "opus": true, "opus-hq": true},
}

// UpdateFromCommand applies a client command to the client's state.
// allowed must not be nil; use defaultAllowedCodecs in tests.
// Returns a codec_status message if a codec was rejected, nil otherwise.
func (c *Client) UpdateFromCommand(cmd *ClientCommand, allowed *AllowedCodecs) *CodecStatus {
	c.mu.Lock()
	defer c.mu.Unlock()

	switch cmd.Cmd {
	case "subscribe":
		if cmd.DongleId != "" {
			c.DongleID = cmd.DongleId
			// Reset per-subscription state — will be re-populated by subsequent commands
			c.ProfileID = ""
			c.AudioEnabled = false
			c.StereoEnabled = false
			c.Mode = ""
			c.TuneOffset = 0
			c.Bandwidth = 0
		}
	case "tune":
		c.TuneOffset = cmd.Offset
	case "mode":
		if cmd.Mode != "" {
			c.Mode = cmd.Mode
		}
		// Also store bandwidth if piggybacked on the mode command
		if cmd.Bandwidth > 0 {
			c.Bandwidth = cmd.Bandwidth
		}
	case "bandwidth":
		c.Bandwidth = cmd.Hz
	case "codec":
		var status *CodecStatus
		if cmd.FftCodec != "" {
			if allowed.Fft[cmd.FftCodec] {
				c.FftCodec = cmd.FftCodec
			} else {
				// Unknown or disabled FFT codec — fallback to "none"
				c.FftCodec = "none"
				status = &CodecStatus{
					FftCodec: "none",
					FftMsg:   "codec '" + cmd.FftCodec + "' not available on this server, using 'none'",
				}
			}
		}
		if cmd.IqCodec != "" {
			if allowed.Iq[cmd.IqCodec] {
				c.IqCodec = cmd.IqCodec
			} else {
				c.IqCodec = "none"
				if status == nil {
					status = &CodecStatus{}
				}
				status.IqCodec = "none"
				status.IqMsg = "codec '" + cmd.IqCodec + "' not available on this server, using 'none'"
			}
		}
		return status
	case "audio_enabled":
		if cmd.Enabled != nil {
			c.AudioEnabled = *cmd.Enabled
		}
	case "stereo_enabled":
		if cmd.Enabled != nil {
			c.StereoEnabled = *cmd.Enabled
		}
	}
	return nil
}

// CodecStatus is sent back to the client when a codec is rejected or confirmed.
type CodecStatus struct {
	FftCodec string `json:"fftCodec,omitempty"`
	FftMsg   string `json:"fftMsg,omitempty"`
	IqCodec  string `json:"iqCodec,omitempty"`
	IqMsg    string `json:"iqMsg,omitempty"`
}
