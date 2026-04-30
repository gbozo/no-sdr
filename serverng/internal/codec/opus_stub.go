//go:build !opus

package codec

import "errors"

// OpusEncoder is a stub when built without the opus tag.
type OpusEncoder struct{}

// OpusEncoderConfig configures the Opus encoder.
type OpusEncoderConfig struct {
	SampleRate int
	Channels   int
	Bitrate    int
}

// OpusPacket represents one encoded Opus frame.
type OpusPacket struct {
	Data     []byte
	Samples  int
	Channels int
}

// NewOpusEncoder returns an error when built without the opus tag.
func NewOpusEncoder(cfg OpusEncoderConfig) (*OpusEncoder, error) {
	return nil, errors.New("opus support not compiled (build with -tags opus)")
}

// Encode is a no-op stub.
func (e *OpusEncoder) Encode(pcm []int16) []OpusPacket { return nil }

// SetBitrate is a no-op stub.
func (e *OpusEncoder) SetBitrate(bps int) error { return nil }

// SetChannels is a no-op stub.
func (e *OpusEncoder) SetChannels(channels int) error { return nil }

// Reset is a no-op stub.
func (e *OpusEncoder) Reset() {}

// Close is a no-op stub.
func (e *OpusEncoder) Close() {}
