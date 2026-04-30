package codec

import (
	"testing"
)

// These tests run WITHOUT the opus build tag, so they exercise the stub.
// To test the real Opus encoder, run:
//   go test -tags opus ./internal/codec/...
// (requires libopus and libopusfile development headers installed)

func TestNewOpusEncoder_StubReturnsError(t *testing.T) {
	enc, err := NewOpusEncoder(OpusEncoderConfig{
		SampleRate: 48000,
		Channels:   1,
		Bitrate:    32000,
	})
	if err == nil {
		t.Fatal("expected error from stub NewOpusEncoder, got nil")
	}
	if enc != nil {
		t.Fatal("expected nil encoder from stub, got non-nil")
	}
	expected := "opus support not compiled (build with -tags opus)"
	if err.Error() != expected {
		t.Fatalf("unexpected error message: got %q, want %q", err.Error(), expected)
	}
}

func TestOpusEncoder_NilMethodsDontPanic(t *testing.T) {
	// Calling methods on nil *OpusEncoder must not panic
	var enc *OpusEncoder

	// Encode on nil
	packets := enc.Encode([]int16{1, 2, 3, 4})
	if packets != nil {
		t.Errorf("expected nil packets from nil encoder, got %v", packets)
	}

	// SetBitrate on nil
	err := enc.SetBitrate(64000)
	if err != nil {
		t.Errorf("expected nil error from stub SetBitrate, got %v", err)
	}

	// SetChannels on nil
	err = enc.SetChannels(2)
	if err != nil {
		t.Errorf("expected nil error from stub SetChannels, got %v", err)
	}

	// Reset on nil — should not panic
	enc.Reset()

	// Close on nil — should not panic
	enc.Close()
}

func TestOpusPacket_ZeroValue(t *testing.T) {
	var pkt OpusPacket
	if pkt.Data != nil {
		t.Error("expected nil Data in zero-value OpusPacket")
	}
	if pkt.Samples != 0 {
		t.Error("expected 0 Samples in zero-value OpusPacket")
	}
	if pkt.Channels != 0 {
		t.Error("expected 0 Channels in zero-value OpusPacket")
	}
}
