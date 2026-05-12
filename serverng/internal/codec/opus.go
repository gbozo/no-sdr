//go:build opus

package codec

import (
	"fmt"

	"gopkg.in/hraban/opus.v2"
)

// OpusEncoder wraps libopus for real-time audio encoding.
// Build with: go build -tags opus
type OpusEncoder struct {
	encoder    *opus.Encoder
	channels   int
	sampleRate int
	bitrate    int
	complexity int    // preserved across Reset() and SetChannels()
	frameSize  int    // samples per frame per channel (2880 for 60ms @ 48kHz)
	pcmBuf     []int16 // accumulation buffer
	pcmPos     int
	outBuf     []byte // reusable output buffer
}

// OpusEncoderConfig configures the Opus encoder.
type OpusEncoderConfig struct {
	SampleRate int // must be 48000
	Channels   int // 1 or 2
	Bitrate    int // bps (e.g., 64000 for stereo, 32000 for mono)
	// Complexity sets the encoder complexity (0=fastest, 10=best).
	// 0 means "use default" which applies complexity=5.
	Complexity int
}

// OpusPacket represents one encoded Opus frame.
type OpusPacket struct {
	Data     []byte
	Samples  int // PCM samples represented (960 per channel)
	Channels int
}

// NewOpusEncoder creates a new Opus encoder.
// SampleRate must be 48000. Channels must be 1 or 2.
func NewOpusEncoder(cfg OpusEncoderConfig) (*OpusEncoder, error) {
	if cfg.SampleRate != 48000 {
		return nil, fmt.Errorf("opus: sample rate must be 48000, got %d", cfg.SampleRate)
	}
	if cfg.Channels < 1 || cfg.Channels > 2 {
		return nil, fmt.Errorf("opus: channels must be 1 or 2, got %d", cfg.Channels)
	}
	if cfg.Bitrate <= 0 {
		return nil, fmt.Errorf("opus: bitrate must be positive, got %d", cfg.Bitrate)
	}

	enc, err := opus.NewEncoder(cfg.SampleRate, cfg.Channels, opus.AppAudio)
	if err != nil {
		return nil, fmt.Errorf("opus: failed to create encoder: %w", err)
	}

	if err := enc.SetBitrate(cfg.Bitrate); err != nil {
		return nil, fmt.Errorf("opus: failed to set bitrate: %w", err)
	}

	// Apply encoder complexity. Default is 5 when not set (0-value treated as default).
	complexity := cfg.Complexity
	if complexity <= 0 {
		complexity = 5
	}
	if err := enc.SetComplexity(complexity); err != nil {
		return nil, fmt.Errorf("opus: failed to set complexity: %w", err)
	}

	// 60ms frame at 48kHz = 2880 samples per channel.
	// Larger frames reduce encoder call frequency by 3× vs 20ms,
	// cutting per-frame overhead with negligible latency change for broadcast radio.
	frameSize := 2880

	e := &OpusEncoder{
		encoder:    enc,
		channels:   cfg.Channels,
		sampleRate: cfg.SampleRate,
		bitrate:    cfg.Bitrate,
		complexity: complexity,
		frameSize:  frameSize,
		pcmBuf:     make([]int16, frameSize*cfg.Channels),
		pcmPos:     0,
		outBuf:     make([]byte, 4000), // max Opus frame size
	}

	return e, nil
}

// Encode takes PCM int16 samples (interleaved if stereo) and returns
// zero or more Opus packets. Accumulates until a full 20ms frame.
func (e *OpusEncoder) Encode(pcm []int16) []OpusPacket {
	if e == nil || e.encoder == nil || e.outBuf == nil {
		return nil
	}

	var packets []OpusPacket
	frameSamples := e.frameSize * e.channels
	pos := 0

	for pos < len(pcm) {
		// How many samples we can copy into the accumulation buffer
		space := frameSamples - e.pcmPos
		avail := len(pcm) - pos
		n := space
		if avail < n {
			n = avail
		}

		copy(e.pcmBuf[e.pcmPos:e.pcmPos+n], pcm[pos:pos+n])
		e.pcmPos += n
		pos += n

		// If we have a full frame, encode it
		if e.pcmPos >= frameSamples {
			encoded, err := e.encoder.Encode(e.pcmBuf[:frameSamples], e.outBuf)
			if err == nil && encoded > 0 {
				// Copy encoded data — outBuf is reused across calls
				data := make([]byte, encoded)
				copy(data, e.outBuf[:encoded])
				packets = append(packets, OpusPacket{
					Data:     data,
					Samples:  e.frameSize,
					Channels: e.channels,
				})
			}
			e.pcmPos = 0
		}
	}

	return packets
}

// SetBitrate changes the encoding bitrate.
func (e *OpusEncoder) SetBitrate(bps int) error {
	if e == nil || e.encoder == nil {
		return fmt.Errorf("opus: encoder not initialized")
	}
	if err := e.encoder.SetBitrate(bps); err != nil {
		return fmt.Errorf("opus: failed to set bitrate: %w", err)
	}
	e.bitrate = bps
	return nil
}

// SetChannels switches between mono and stereo.
// Creates a new internal encoder if channel count changes.
func (e *OpusEncoder) SetChannels(channels int) error {
	if e == nil {
		return fmt.Errorf("opus: encoder not initialized")
	}
	if channels < 1 || channels > 2 {
		return fmt.Errorf("opus: channels must be 1 or 2, got %d", channels)
	}
	if channels == e.channels {
		return nil
	}

	// Create new encoder with different channel count
	enc, err := opus.NewEncoder(e.sampleRate, channels, opus.AppAudio)
	if err != nil {
		return fmt.Errorf("opus: failed to create encoder: %w", err)
	}
	if err := enc.SetBitrate(e.bitrate); err != nil {
		return fmt.Errorf("opus: failed to set bitrate on new encoder: %w", err)
	}
	if err := enc.SetComplexity(e.complexity); err != nil {
		return fmt.Errorf("opus: failed to set complexity on new encoder: %w", err)
	}

	e.encoder = enc
	e.channels = channels
	e.pcmBuf = make([]int16, e.frameSize*channels)
	e.pcmPos = 0

	return nil
}

// Reset flushes the accumulation buffer and resets encoder state.
func (e *OpusEncoder) Reset() {
	if e == nil {
		return
	}
	e.pcmPos = 0
	// Reset encoder by recreating it, preserving bitrate and complexity
	if e.encoder != nil {
		enc, err := opus.NewEncoder(e.sampleRate, e.channels, opus.AppAudio)
		if err == nil {
			_ = enc.SetBitrate(e.bitrate)
			_ = enc.SetComplexity(e.complexity)
			e.encoder = enc
		}
	}
}

// SetComplexity changes the encoding complexity (0=fastest, 10=best quality).
// Default after NewOpusEncoder is 5. Changes take effect on the next Encode call.
func (e *OpusEncoder) SetComplexity(complexity int) error {
	if e == nil || e.encoder == nil {
		return fmt.Errorf("opus: encoder not initialized")
	}
	if complexity < 0 {
		complexity = 0
	} else if complexity > 10 {
		complexity = 10
	}
	if err := e.encoder.SetComplexity(complexity); err != nil {
		return fmt.Errorf("opus: failed to set complexity: %w", err)
	}
	return nil
}

// Close releases the encoder resources.
func (e *OpusEncoder) Close() {
	if e == nil {
		return
	}
	e.encoder = nil
	e.pcmBuf = nil
	e.outBuf = nil
	e.pcmPos = 0
}

// OpusAvailable reports whether Opus encoding is compiled in.
func OpusAvailable() bool { return true }
