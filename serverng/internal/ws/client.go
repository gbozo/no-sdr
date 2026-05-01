package ws

import (
	"context"
	"sync"

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
	ID   string
	conn *websocket.Conn
	ctx  context.Context
	cancel context.CancelFunc

	// Subscription state — written only from the read goroutine.
	DongleID     string
	AudioEnabled bool
	FftCodec     string // "none", "adpcm", "deflate"
	IqCodec      string // "none", "adpcm", "opus", "opus-hq"
	Mode         string
	TuneOffset   int
	Bandwidth    int

	// Write channel with backpressure
	writeCh chan []byte

	mu sync.RWMutex
}

// newClient creates a new Client with the given connection and ID.
// Codec defaults are empty — server uses "none" (uint8 FFT) until client sends preferences.
func newClient(id string, conn *websocket.Conn, ctx context.Context, cancel context.CancelFunc) *Client {
	return &Client{
		ID:       id,
		conn:     conn,
		ctx:      ctx,
		cancel:   cancel,
		FftCodec: "",  // empty = "none" — client sends preferred codec after subscribe
		IqCodec:  "",  // empty = "none" — client sends preferred codec after subscribe
		writeCh:  make(chan []byte, DefaultWriteChSize),
	}
}

// Send enqueues a message for writing with backpressure (drop-oldest on full).
func (c *Client) Send(msg []byte) {
	select {
	case c.writeCh <- msg:
	default:
		// Channel full — drop oldest, then enqueue new
		select {
		case <-c.writeCh:
		default:
		}
		// Non-blocking retry
		select {
		case c.writeCh <- msg:
		default:
			// Still full (unlikely race), drop this message
		}
	}
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

// AllowedCodecs holds the codec sets the server will accept from clients.
// Set once at startup by the Manager; safe to read concurrently (never mutated after init).
type AllowedCodecs struct {
	Fft map[string]bool
	Iq  map[string]bool
}

// defaultAllowedCodecs is used in tests and when no config is provided.
var defaultAllowedCodecs = AllowedCodecs{
	Fft: map[string]bool{"none": true, "adpcm": true, "deflate": true, "deflate-floor": true},
	Iq:  map[string]bool{"none": true, "adpcm": true, "opus": true, "opus-hq": true},
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
		}
	case "tune":
		c.TuneOffset = cmd.Offset
	case "mode":
		if cmd.Mode != "" {
			c.Mode = cmd.Mode
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
