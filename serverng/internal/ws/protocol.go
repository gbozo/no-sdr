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
	Type         string  `json:"type"`
	DongleId     string  `json:"dongleId,omitempty"`
	ProfileId    string  `json:"profileId,omitempty"`
	CenterFreq   float64 `json:"centerFreq,omitempty"`
	SampleRate   int     `json:"sampleRate,omitempty"`
	FftSize      int     `json:"fftSize,omitempty"`
	FftFps       int     `json:"fftFps,omitempty"`
	IqSampleRate int     `json:"iqSampleRate,omitempty"`
	Mode         string  `json:"mode,omitempty"`
	TuningStep   int     `json:"tuningStep,omitempty"`
	Bandwidth    int     `json:"bandwidth,omitempty"`
	TuneOffset   int     `json:"tuneOffset,omitempty"`
	// Error fields
	Message string `json:"message,omitempty"`
	Code    string `json:"code,omitempty"`
	// Welcome fields
	ClientId         string   `json:"clientId,omitempty"`
	ConnIndex        int      `json:"connIndex,omitempty"`
	ServerVersion    string   `json:"serverVersion,omitempty"`
	AllowedFftCodecs []string `json:"allowedFftCodecs,omitempty"`
	AllowedIqCodecs  []string `json:"allowedIqCodecs,omitempty"`
}

// ClientCommand represents a parsed command from the client (JSON text).
type ClientCommand struct {
	Cmd           string `json:"cmd"`
	DongleId      string `json:"dongleId,omitempty"`
	ProfileId     string `json:"profileId,omitempty"`
	Offset        int    `json:"offset,omitempty"`
	Mode          string `json:"mode,omitempty"`
	Bandwidth     int    `json:"bandwidth,omitempty"`
	Hz            int    `json:"hz,omitempty"`
	FftCodec      string `json:"fftCodec,omitempty"`
	IqCodec       string `json:"iqCodec,omitempty"`
	Enabled       *bool  `json:"enabled,omitempty"`
	StereoEnabled *bool  `json:"stereoEnabled,omitempty"`
	Password      string `json:"password,omitempty"`
	Level         float64 `json:"level,omitempty"`
	Muted         *bool  `json:"muted,omitempty"`
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

// PackIQMessage packs raw IQ samples with a self-describing header.
// Wire: [0x02][Uint32 sampleRate LE][Uint8 channels=2][Uint8 reserved=0][Int16 samples LE...]
//
// The header lets the client configure its demodulator from the frame itself —
// no external state (META messages, mode commands) needed to decode the frame.
func PackIQMessage(samples []int16, sampleRate uint32) []byte {
	const headerSize = 6 // 4 (sampleRate) + 1 (channels) + 1 (reserved)
	buf := make([]byte, 1+headerSize+len(samples)*2)
	buf[0] = MsgIQ
	binary.LittleEndian.PutUint32(buf[1:5], sampleRate)
	buf[5] = 2 // always 2-channel interleaved I/Q
	buf[6] = 0 // reserved
	for i, s := range samples {
		binary.LittleEndian.PutUint16(buf[7+i*2:], uint16(s))
	}
	return buf
}

// PackIQAdpcmMessage packs ADPCM-compressed IQ data with a self-describing header.
// Wire: [0x09][Uint32 sampleCount LE][Uint32 sampleRate LE][Uint8 channels=2][Uint8 reserved=0][adpcm bytes...]
//
// sampleCount is the number of Int16 IQ samples (I+Q pairs × 2) before compression.
// sampleRate is the IQ sub-band sample rate (e.g., 240000 for WFM, 48000 for NFM).
func PackIQAdpcmMessage(adpcmData []byte, sampleCount uint32, sampleRate uint32) []byte {
	const headerSize = 10 // 4 (sampleCount) + 4 (sampleRate) + 1 (channels) + 1 (reserved)
	buf := make([]byte, 1+headerSize+len(adpcmData))
	buf[0] = MsgIQAdpcm
	binary.LittleEndian.PutUint32(buf[1:5], sampleCount)
	binary.LittleEndian.PutUint32(buf[5:9], sampleRate)
	buf[9] = 2  // always 2-channel interleaved I/Q
	buf[10] = 0 // reserved
	copy(buf[11:], adpcmData)
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
