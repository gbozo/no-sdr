package ws

import (
	"context"
	"sync"

	"github.com/coder/websocket"
)

const (
	// DefaultWriteChSize is the buffered channel capacity for write messages.
	// Sized for ~8 FFT frames of backpressure tolerance before dropping.
	DefaultWriteChSize = 8
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
func newClient(id string, conn *websocket.Conn, ctx context.Context, cancel context.CancelFunc) *Client {
	return &Client{
		ID:       id,
		conn:     conn,
		ctx:      ctx,
		cancel:   cancel,
		FftCodec: "deflate",
		IqCodec:  "adpcm",
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

// UpdateFromCommand applies a client command to the client's state.
func (c *Client) UpdateFromCommand(cmd *ClientCommand) {
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
		if cmd.FftCodec != "" {
			c.FftCodec = cmd.FftCodec
		}
		if cmd.IqCodec != "" {
			c.IqCodec = cmd.IqCodec
		}
	case "audio_enabled":
		if cmd.Enabled != nil {
			c.AudioEnabled = *cmd.Enabled
		}
	}
}
