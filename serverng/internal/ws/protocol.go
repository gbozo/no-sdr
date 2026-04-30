// Package ws implements the WebSocket binary protocol for node-sdr.
//
// Server → Client messages use a single type-byte prefix followed by
// little-endian typed array payloads.
// Client → Server messages are JSON text.
package ws

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
)

// Message type bytes (Server → Client)
const (
	MsgFFT           byte = 0x01 // Float32Array (dB magnitudes)
	MsgIQ            byte = 0x02 // Int16Array (interleaved I/Q)
	MsgMeta          byte = 0x03 // UTF-8 JSON (ServerMeta)
	MsgFFTCompressed byte = 0x04 // Int16(minDb) + Int16(maxDb) + Uint8[N]
	MsgAudio         byte = 0x05 // Int16Array mono samples
	MsgDecoder       byte = 0x06 // JSON-encoded decoder messages
	MsgSignalLevel   byte = 0x07 // Float32 dB value
	MsgFFTAdpcm      byte = 0x08 // ADPCM on Int16(dB×100)
	MsgIQAdpcm       byte = 0x09 // Uint32(sampleCount) + ADPCM bytes
	MsgRDS           byte = 0x0A // UTF-8 JSON (RDS data)
	MsgFFTDeflate    byte = 0x0B // Int16(minDb) + Int16(maxDb) + Uint32(binCount) + deflate bytes
	MsgAudioOpus     byte = 0x0C // Uint16(sampleCount) + Uint8(channels) + Opus packet
	MsgFFTHistory    byte = 0x0D // Waterfall history burst
)

// ServerMeta holds metadata sent to a connected client.
type ServerMeta struct {
	Type            string  `json:"type"`
	CenterFrequency float64 `json:"centerFrequency"`
	SampleRate      int     `json:"sampleRate"`
	FftSize         int     `json:"fftSize"`
	FftFps          int     `json:"fftFps"`
	Mode            string  `json:"mode"`
	Bandwidth       int     `json:"bandwidth"`
	DongleId        string  `json:"dongleId"`
	ProfileId       string  `json:"profileId"`
	TuneOffset      int     `json:"tuneOffset"`
	TuningStep      int     `json:"tuningStep,omitempty"`
}

// ClientCommand represents a parsed command from the client (JSON text).
type ClientCommand struct {
	Cmd           string `json:"cmd"`
	DongleId      string `json:"dongleId,omitempty"`
	ProfileId     string `json:"profileId,omitempty"`
	Offset        int    `json:"offset,omitempty"`
	Mode          string `json:"mode,omitempty"`
	Hz            int    `json:"hz,omitempty"`
	FftCodec      string `json:"fftCodec,omitempty"`
	IqCodec       string `json:"iqCodec,omitempty"`
	Enabled       *bool  `json:"enabled,omitempty"`
	StereoEnabled *bool  `json:"stereoEnabled,omitempty"`
}

// PackMetaMessage packs a ServerMeta as a binary message: [0x03][UTF-8 JSON]
func PackMetaMessage(meta *ServerMeta) []byte {
	jsonBytes, _ := json.Marshal(meta)
	buf := make([]byte, 1+len(jsonBytes))
	buf[0] = MsgMeta
	copy(buf[1:], jsonBytes)
	return buf
}

// PackCodecStatusMessage sends codec fallback info to the client as META.
// The client reads this as a meta message with type "codec_status".
func PackCodecStatusMessage(status *CodecStatus) []byte {
	msg := map[string]any{"type": "codec_status"}
	if status.FftCodec != "" {
		msg["fftCodec"] = status.FftCodec
		msg["fftMsg"] = status.FftMsg
	}
	if status.IqCodec != "" {
		msg["iqCodec"] = status.IqCodec
		msg["iqMsg"] = status.IqMsg
	}
	jsonBytes, _ := json.Marshal(msg)
	buf := make([]byte, 1+len(jsonBytes))
	buf[0] = MsgMeta
	copy(buf[1:], jsonBytes)
	return buf
}

// PackFFTCompressedMessage packs compressed FFT data.
// Wire: [0x04][Int16 minDb LE][Int16 maxDb LE][Uint8... data]
func PackFFTCompressedMessage(uint8Data []byte, minDb, maxDb int16) []byte {
	buf := make([]byte, 1+4+len(uint8Data))
	buf[0] = MsgFFTCompressed
	binary.LittleEndian.PutUint16(buf[1:3], uint16(minDb))
	binary.LittleEndian.PutUint16(buf[3:5], uint16(maxDb))
	copy(buf[5:], uint8Data)
	return buf
}

// PackFFTAdpcmMessage packs ADPCM-compressed FFT data.
// Wire: [0x08][adpcmPayload...]
// The adpcmPayload already contains the 4-byte header (minDb + maxDb) from EncodeFftAdpcm.
func PackFFTAdpcmMessage(adpcmPayload []byte) []byte {
	buf := make([]byte, 1+len(adpcmPayload))
	buf[0] = MsgFFTAdpcm
	copy(buf[1:], adpcmPayload)
	return buf
}

// PackFFTDeflateMessage packs deflate-compressed FFT data.
// Wire: [0x0B][Int16 minDb LE][Int16 maxDb LE][Uint32 binCount LE][deflate bytes...]
func PackFFTDeflateMessage(deflatedData []byte, minDb, maxDb int16, binCount uint32) []byte {
	buf := make([]byte, 1+8+len(deflatedData))
	buf[0] = MsgFFTDeflate
	binary.LittleEndian.PutUint16(buf[1:3], uint16(minDb))
	binary.LittleEndian.PutUint16(buf[3:5], uint16(maxDb))
	binary.LittleEndian.PutUint32(buf[5:9], binCount)
	copy(buf[9:], deflatedData)
	return buf
}

// PackIQMessage packs raw IQ samples (Int16 interleaved I/Q).
// Wire: [0x02][Int16 samples as LE bytes...]
func PackIQMessage(samples []int16) []byte {
	buf := make([]byte, 1+len(samples)*2)
	buf[0] = MsgIQ
	for i, s := range samples {
		binary.LittleEndian.PutUint16(buf[1+i*2:], uint16(s))
	}
	return buf
}

// PackIQAdpcmMessage packs ADPCM-compressed IQ data.
// Wire: [0x09][Uint32 sampleCount LE][adpcm bytes...]
func PackIQAdpcmMessage(adpcmData []byte, sampleCount uint32) []byte {
	buf := make([]byte, 1+4+len(adpcmData))
	buf[0] = MsgIQAdpcm
	binary.LittleEndian.PutUint32(buf[1:5], sampleCount)
	copy(buf[5:], adpcmData)
	return buf
}

// PackAudioOpusMessage packs an Opus-encoded audio frame.
// Wire: [0x0C][Uint16 sampleCount LE][Uint8 channels][Opus packet bytes...]
func PackAudioOpusMessage(packet []byte, sampleCount uint16, channels uint8) []byte {
	buf := make([]byte, 1+2+1+len(packet))
	buf[0] = MsgAudioOpus
	binary.LittleEndian.PutUint16(buf[1:3], sampleCount)
	buf[3] = channels
	copy(buf[4:], packet)
	return buf
}

// PackRDSMessage packs RDS data as a JSON binary message.
// Wire: [0x0A][UTF-8 JSON bytes]
func PackRDSMessage(rdsData []byte) []byte {
	buf := make([]byte, 1+len(rdsData))
	buf[0] = MsgRDS
	copy(buf[1:], rdsData)
	return buf
}

// ParseClientCommand parses a JSON text command from the client.
func ParseClientCommand(data []byte) (*ClientCommand, error) {
	var cmd ClientCommand
	if err := json.Unmarshal(data, &cmd); err != nil {
		return nil, fmt.Errorf("invalid client command: %w", err)
	}
	if cmd.Cmd == "" {
		return nil, fmt.Errorf("missing 'cmd' field")
	}
	return &cmd, nil
}

// --- Utility helpers ---

// Int16ToBytes converts a signed int16 to 2 LE bytes (used internally).
func int16ToBytes(v int16) [2]byte {
	var b [2]byte
	binary.LittleEndian.PutUint16(b[:], uint16(v))
	return b
}

// Float32ToBytes converts a float32 to 4 LE bytes.
func float32ToBytes(v float32) [4]byte {
	var b [4]byte
	binary.LittleEndian.PutUint32(b[:], math.Float32bits(v))
	return b
}
