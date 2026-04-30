package dongle

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"log/slog"
	"net"
	"sync"
	"time"
)

// RtlTcpSource connects to a remote rtl_tcp server.
type RtlTcpSource struct {
	host       string
	port       int
	conn       net.Conn
	logger     *slog.Logger
	dongleInfo RtlDongleInfo
	mu         sync.Mutex
}

// RtlDongleInfo is the 12-byte header sent by rtl_tcp on connect.
type RtlDongleInfo struct {
	Magic      [4]byte // "RTL0"
	TunerType  uint32  // tuner chip type
	TunerGains uint32  // number of gain stages
}

// RtlTcpConfig configures an rtl_tcp client connection.
type RtlTcpConfig struct {
	Host   string
	Port   int
	Logger *slog.Logger
}

// NewRtlTcpSource creates a new rtl_tcp source client.
func NewRtlTcpSource(cfg RtlTcpConfig) *RtlTcpSource {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.Port <= 0 {
		cfg.Port = 1234 // default rtl_tcp port
	}
	if cfg.Host == "" {
		cfg.Host = "127.0.0.1"
	}
	return &RtlTcpSource{
		host:   cfg.Host,
		port:   cfg.Port,
		logger: cfg.Logger,
	}
}

// Connect establishes TCP connection and reads the 12-byte header.
func (r *RtlTcpSource) Connect(ctx context.Context) error {
	addr := fmt.Sprintf("%s:%d", r.host, r.port)
	dialer := net.Dialer{Timeout: 5 * time.Second}

	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return fmt.Errorf("rtl_tcp connect to %s: %w", addr, err)
	}

	// Read 12-byte header
	if err := conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		conn.Close()
		return fmt.Errorf("rtl_tcp set deadline: %w", err)
	}

	if err := binary.Read(conn, binary.BigEndian, &r.dongleInfo); err != nil {
		conn.Close()
		return fmt.Errorf("rtl_tcp read header: %w", err)
	}

	// Verify magic "RTL0"
	if r.dongleInfo.Magic != [4]byte{'R', 'T', 'L', '0'} {
		conn.Close()
		return fmt.Errorf("rtl_tcp invalid magic: %v (expected RTL0)", r.dongleInfo.Magic)
	}

	// Clear deadline for streaming
	if err := conn.SetReadDeadline(time.Time{}); err != nil {
		conn.Close()
		return fmt.Errorf("rtl_tcp clear deadline: %w", err)
	}

	r.mu.Lock()
	r.conn = conn
	r.mu.Unlock()

	r.logger.Info("rtl_tcp connected",
		"addr", addr,
		"tunerType", r.dongleInfo.TunerType,
		"tunerGains", r.dongleInfo.TunerGains,
	)

	return nil
}

// Run reads raw IQ data and sends chunks to the output channel.
// Chunks are sized for ~10ms of data at 2.4 MSPS (16384 bytes ≈ 3.4ms,
// but we use a practical buffer size that's a power of 2).
// Blocks until context is cancelled or connection error.
func (r *RtlTcpSource) Run(ctx context.Context, out chan<- []byte) {
	r.mu.Lock()
	conn := r.conn
	r.mu.Unlock()

	if conn == nil {
		r.logger.Error("rtl_tcp Run called without connection")
		return
	}

	const chunkSize = 16384 // ~3.4ms at 2.4 MSPS (uint8 IQ pairs)
	buf := make([]byte, chunkSize)

	for {
		// Check context before blocking read
		select {
		case <-ctx.Done():
			return
		default:
		}

		// Set a read deadline so we can periodically check ctx
		if err := conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond)); err != nil {
			r.logger.Error("rtl_tcp set read deadline", "error", err)
			return
		}

		n, err := io.ReadFull(conn, buf)
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				continue // timeout — loop back and check ctx
			}
			if ctx.Err() != nil {
				return // context cancelled
			}
			r.logger.Error("rtl_tcp read error", "error", err)
			return
		}

		// Send a copy to channel (buffer reuse protection)
		chunk := make([]byte, n)
		copy(chunk, buf[:n])

		select {
		case out <- chunk:
		case <-ctx.Done():
			return
		}
	}
}

// Close disconnects from the server.
func (r *RtlTcpSource) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.conn == nil {
		return nil
	}
	err := r.conn.Close()
	r.conn = nil
	return err
}

// DongleInfo returns the header info received on connect.
func (r *RtlTcpSource) DongleInfo() RtlDongleInfo {
	return r.dongleInfo
}

// Command sends a 5-byte rtl_tcp command (1 byte cmd + 4 bytes big-endian value).
func (r *RtlTcpSource) Command(cmd byte, value uint32) error {
	r.mu.Lock()
	conn := r.conn
	r.mu.Unlock()

	if conn == nil {
		return fmt.Errorf("rtl_tcp not connected")
	}

	var buf [5]byte
	buf[0] = cmd
	binary.BigEndian.PutUint32(buf[1:], value)

	_, err := conn.Write(buf[:])
	if err != nil {
		return fmt.Errorf("rtl_tcp command 0x%02X: %w", cmd, err)
	}
	return nil
}

// SetFrequency sets the center frequency (Hz).
func (r *RtlTcpSource) SetFrequency(hz uint32) error {
	return r.Command(0x01, hz)
}

// SetSampleRate sets the sample rate (Hz).
func (r *RtlTcpSource) SetSampleRate(hz uint32) error {
	return r.Command(0x02, hz)
}

// SetGainMode sets gain mode (0=auto, 1=manual).
func (r *RtlTcpSource) SetGainMode(mode uint32) error {
	return r.Command(0x03, mode)
}

// SetGain sets the tuner gain (in tenths of dB).
func (r *RtlTcpSource) SetGain(tenthsDb uint32) error {
	return r.Command(0x04, tenthsDb)
}

// SetFrequencyCorrection sets PPM correction.
func (r *RtlTcpSource) SetFrequencyCorrection(ppm uint32) error {
	return r.Command(0x05, ppm)
}

// SetAgcMode sets RTL2832U AGC (0=off, 1=on).
func (r *RtlTcpSource) SetAgcMode(mode uint32) error {
	return r.Command(0x08, mode)
}

// SetDirectSampling sets direct sampling mode (0=off, 1=I, 2=Q).
func (r *RtlTcpSource) SetDirectSampling(mode uint32) error {
	return r.Command(0x09, mode)
}

// SetOffsetTuning sets offset tuning mode (0=off, 1=on).
func (r *RtlTcpSource) SetOffsetTuning(mode uint32) error {
	return r.Command(0x0A, mode)
}

// SetBiasT sets bias-T power (0=off, 1=on).
func (r *RtlTcpSource) SetBiasT(enabled uint32) error {
	return r.Command(0x0E, enabled)
}
