package ws

import (
	"encoding/binary"
	"encoding/json"
	"testing"
)

func TestPackFFTCompressedMessage(t *testing.T) {
	data := []byte{10, 20, 30, 40, 50}
	minDb := int16(-120)
	maxDb := int16(0)

	msg := PackFFTCompressedMessage(data, minDb, maxDb)

	// Type byte
	if msg[0] != MsgFFTCompressed {
		t.Errorf("expected type 0x%02x, got 0x%02x", MsgFFTCompressed, msg[0])
	}

	// minDb at offset 1 (Int16 LE)
	gotMin := int16(binary.LittleEndian.Uint16(msg[1:3]))
	if gotMin != minDb {
		t.Errorf("expected minDb %d, got %d", minDb, gotMin)
	}

	// maxDb at offset 3 (Int16 LE)
	gotMax := int16(binary.LittleEndian.Uint16(msg[3:5]))
	if gotMax != maxDb {
		t.Errorf("expected maxDb %d, got %d", maxDb, gotMax)
	}

	// Payload starts at offset 5
	for i, v := range data {
		if msg[5+i] != v {
			t.Errorf("payload[%d]: expected %d, got %d", i, v, msg[5+i])
		}
	}

	// Total length
	expectedLen := 1 + 4 + len(data)
	if len(msg) != expectedLen {
		t.Errorf("expected length %d, got %d", expectedLen, len(msg))
	}
}

func TestPackIQAdpcmMessage(t *testing.T) {
	adpcm := []byte{0xAB, 0xCD, 0xEF, 0x12}
	sampleCount := uint32(1024)

	msg := PackIQAdpcmMessage(adpcm, sampleCount)

	// Type byte
	if msg[0] != MsgIQAdpcm {
		t.Errorf("expected type 0x%02x, got 0x%02x", MsgIQAdpcm, msg[0])
	}

	// Sample count at offset 1 (Uint32 LE)
	gotCount := binary.LittleEndian.Uint32(msg[1:5])
	if gotCount != sampleCount {
		t.Errorf("expected sampleCount %d, got %d", sampleCount, gotCount)
	}

	// ADPCM payload at offset 5
	for i, v := range adpcm {
		if msg[5+i] != v {
			t.Errorf("adpcm[%d]: expected 0x%02x, got 0x%02x", i, v, msg[5+i])
		}
	}

	// Total length: 1 + 4 + len(adpcm)
	expectedLen := 1 + 4 + len(adpcm)
	if len(msg) != expectedLen {
		t.Errorf("expected length %d, got %d", expectedLen, len(msg))
	}
}

func TestPackFFTDeflateMessage(t *testing.T) {
	deflated := []byte{0x78, 0x9C, 0x01, 0x02, 0x03}
	minDb := int16(-100)
	maxDb := int16(-10)
	binCount := uint32(4096)

	msg := PackFFTDeflateMessage(deflated, minDb, maxDb, binCount)

	// Type byte
	if msg[0] != MsgFFTDeflate {
		t.Errorf("expected type 0x%02x, got 0x%02x", MsgFFTDeflate, msg[0])
	}

	// minDb at offset 1
	gotMin := int16(binary.LittleEndian.Uint16(msg[1:3]))
	if gotMin != minDb {
		t.Errorf("expected minDb %d, got %d", minDb, gotMin)
	}

	// maxDb at offset 3
	gotMax := int16(binary.LittleEndian.Uint16(msg[3:5]))
	if gotMax != maxDb {
		t.Errorf("expected maxDb %d, got %d", maxDb, gotMax)
	}

	// binCount at offset 5 (Uint32 LE)
	gotBins := binary.LittleEndian.Uint32(msg[5:9])
	if gotBins != binCount {
		t.Errorf("expected binCount %d, got %d", binCount, gotBins)
	}

	// Deflate payload at offset 9
	for i, v := range deflated {
		if msg[9+i] != v {
			t.Errorf("deflated[%d]: expected 0x%02x, got 0x%02x", i, v, msg[9+i])
		}
	}

	// Total length: 1 + 8 + len(deflated)
	expectedLen := 1 + 8 + len(deflated)
	if len(msg) != expectedLen {
		t.Errorf("expected length %d, got %d", expectedLen, len(msg))
	}
}

func TestPackAudioOpusMessage(t *testing.T) {
	packet := []byte{0xFC, 0xFF, 0xFE, 0x00, 0x01}
	sampleCount := uint16(960)
	channels := uint8(2)

	msg := PackAudioOpusMessage(packet, sampleCount, channels)

	// Type byte
	if msg[0] != MsgAudioOpus {
		t.Errorf("expected type 0x%02x, got 0x%02x", MsgAudioOpus, msg[0])
	}

	// sampleCount at offset 1 (Uint16 LE)
	gotSamples := binary.LittleEndian.Uint16(msg[1:3])
	if gotSamples != sampleCount {
		t.Errorf("expected sampleCount %d, got %d", sampleCount, gotSamples)
	}

	// channels at offset 3
	if msg[3] != channels {
		t.Errorf("expected channels %d, got %d", channels, msg[3])
	}

	// Opus packet at offset 4
	for i, v := range packet {
		if msg[4+i] != v {
			t.Errorf("packet[%d]: expected 0x%02x, got 0x%02x", i, v, msg[4+i])
		}
	}

	// Total: 1 + 2 + 1 + len(packet)
	expectedLen := 1 + 2 + 1 + len(packet)
	if len(msg) != expectedLen {
		t.Errorf("expected length %d, got %d", expectedLen, len(msg))
	}
}

func TestPackIQMessage(t *testing.T) {
	samples := []int16{100, -200, 32767, -32768, 0}

	msg := PackIQMessage(samples)

	// Type byte
	if msg[0] != MsgIQ {
		t.Errorf("expected type 0x%02x, got 0x%02x", MsgIQ, msg[0])
	}

	// Verify each sample as Int16 LE
	for i, expected := range samples {
		got := int16(binary.LittleEndian.Uint16(msg[1+i*2:]))
		if got != expected {
			t.Errorf("sample[%d]: expected %d, got %d", i, expected, got)
		}
	}

	// Total: 1 + len(samples)*2
	expectedLen := 1 + len(samples)*2
	if len(msg) != expectedLen {
		t.Errorf("expected length %d, got %d", expectedLen, len(msg))
	}
}

func TestPackMetaMessage(t *testing.T) {
	meta := &ServerMeta{
		CenterFreq: 100.5e6,
		SampleRate:      2400000,
		FftSize:         4096,
		FftFps:          30,
		Mode:            "FM",
		Bandwidth:       12500,
		DongleId:        "dongle-0",
		ProfileId:       "fm-band",
		TuneOffset:      5000,
	}

	msg := PackMetaMessage(meta)

	// Type byte
	if msg[0] != MsgMeta {
		t.Errorf("expected type 0x%02x, got 0x%02x", MsgMeta, msg[0])
	}

	// JSON payload
	var decoded ServerMeta
	if err := json.Unmarshal(msg[1:], &decoded); err != nil {
		t.Fatalf("failed to unmarshal meta JSON: %v", err)
	}

	if decoded.CenterFreq != meta.CenterFreq {
		t.Errorf("CenterFreq: expected %f, got %f", meta.CenterFreq, decoded.CenterFreq)
	}
	if decoded.DongleId != meta.DongleId {
		t.Errorf("DongleId: expected %s, got %s", meta.DongleId, decoded.DongleId)
	}
	if decoded.Mode != meta.Mode {
		t.Errorf("Mode: expected %s, got %s", meta.Mode, decoded.Mode)
	}
}

func TestPackRDSMessage(t *testing.T) {
	rds := []byte(`{"ps":"ROCK FM","rt":"Now Playing"}`)

	msg := PackRDSMessage(rds)

	if msg[0] != MsgRDS {
		t.Errorf("expected type 0x%02x, got 0x%02x", MsgRDS, msg[0])
	}

	payload := msg[1:]
	if string(payload) != string(rds) {
		t.Errorf("payload mismatch: expected %s, got %s", rds, payload)
	}
}

func TestParseClientCommand_Subscribe(t *testing.T) {
	data := []byte(`{"cmd":"subscribe","dongleId":"dongle-0","profileId":"fm-band"}`)

	cmd, err := ParseClientCommand(data)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if cmd.Cmd != "subscribe" {
		t.Errorf("expected cmd 'subscribe', got '%s'", cmd.Cmd)
	}
	if cmd.DongleId != "dongle-0" {
		t.Errorf("expected dongleId 'dongle-0', got '%s'", cmd.DongleId)
	}
	if cmd.ProfileId != "fm-band" {
		t.Errorf("expected profileId 'fm-band', got '%s'", cmd.ProfileId)
	}
}

func TestParseClientCommand_Tune(t *testing.T) {
	data := []byte(`{"cmd":"tune","offset":50000}`)

	cmd, err := ParseClientCommand(data)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if cmd.Cmd != "tune" {
		t.Errorf("expected cmd 'tune', got '%s'", cmd.Cmd)
	}
	if cmd.Offset != 50000 {
		t.Errorf("expected offset 50000, got %d", cmd.Offset)
	}
}

func TestParseClientCommand_Mode(t *testing.T) {
	data := []byte(`{"cmd":"mode","mode":"USB"}`)

	cmd, err := ParseClientCommand(data)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if cmd.Cmd != "mode" {
		t.Errorf("expected cmd 'mode', got '%s'", cmd.Cmd)
	}
	if cmd.Mode != "USB" {
		t.Errorf("expected mode 'USB', got '%s'", cmd.Mode)
	}
}

func TestParseClientCommand_Codec(t *testing.T) {
	data := []byte(`{"cmd":"codec","fftCodec":"adpcm","iqCodec":"opus"}`)

	cmd, err := ParseClientCommand(data)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if cmd.Cmd != "codec" {
		t.Errorf("expected cmd 'codec', got '%s'", cmd.Cmd)
	}
	if cmd.FftCodec != "adpcm" {
		t.Errorf("expected fftCodec 'adpcm', got '%s'", cmd.FftCodec)
	}
	if cmd.IqCodec != "opus" {
		t.Errorf("expected iqCodec 'opus', got '%s'", cmd.IqCodec)
	}
}

func TestParseClientCommand_AudioEnabled(t *testing.T) {
	data := []byte(`{"cmd":"audio_enabled","enabled":true}`)

	cmd, err := ParseClientCommand(data)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if cmd.Cmd != "audio_enabled" {
		t.Errorf("expected cmd 'audio_enabled', got '%s'", cmd.Cmd)
	}
	if cmd.Enabled == nil || *cmd.Enabled != true {
		t.Errorf("expected enabled=true, got %v", cmd.Enabled)
	}
}

func TestParseClientCommand_Invalid(t *testing.T) {
	// Invalid JSON
	_, err := ParseClientCommand([]byte(`not json`))
	if err == nil {
		t.Error("expected error for invalid JSON")
	}

	// Missing cmd field
	_, err = ParseClientCommand([]byte(`{"dongleId":"x"}`))
	if err == nil {
		t.Error("expected error for missing cmd field")
	}
}
