package dongle

import (
	"fmt"

	"github.com/gbozo/no-sdr/serverng/internal/codec"
	"github.com/gbozo/no-sdr/serverng/internal/demod"
	"github.com/gbozo/no-sdr/serverng/internal/dsp"
)

// OpusResult is one encoded Opus packet + optional RDS data.
type OpusResult struct {
	Packet   []byte
	Samples  int
	Channels int
	RdsData  []byte // nil if no RDS this frame
}

// OpusPipelineConfig configures the server-side demod + Opus encoding pipeline.
type OpusPipelineConfig struct {
	Mode       string // "wfm", "nfm", "am", "am-stereo", "usb", "lsb", "cw", "sam"
	SampleRate int    // IQ extractor output rate
	Bitrate    int    // Opus bitrate (0 = auto based on codec quality)
	Stereo     bool   // force stereo (for WFM stereo, C-QUAM)
	Quality    string // "opus" or "opus-hq"
}

// OpusPipeline performs server-side demodulation + Opus encoding.
// Used when client selects "opus" or "opus-hq" IQ codec.
// For WFM (240k): demod outputs 240k → integer decimate 5:1 → 48k → Opus.
// For NFM/AM (48k): demod outputs 48k → direct to Opus.
// For SSB/CW (24k/12k): demod outputs 24k/12k → upsample to 48k → Opus.
type OpusPipeline struct {
	demodulator    dsp.ComplexToRealBlock
	encoder        *codec.OpusEncoder
	mode           string
	sampleRate     int
	channels       int
	quality        string // "opus" or "opus-hq"

	// Rate conversion to 48kHz for Opus
	decimFactor    int     // >1 = decimate (WFM), 1 = passthrough, 0 = needs upsample
	upsampleRatio  float64 // >1 for SSB/CW (e.g., 2.0 for 24k→48k)
	upsampleAccum  float64
	lastSample     float32

	// Buffers
	complexBuf  []complex64 // Int16 IQ → complex64 conversion
	audioBuf    []float32   // demodulator output (full rate)
	rateBuf     []float32   // rate-converted audio (48kHz)
	pcmBuf      []int16     // float32 → int16 for Opus
}

// NewOpusPipeline creates a new server-side demod + Opus encoding pipeline.
func NewOpusPipeline(cfg OpusPipelineConfig) (*OpusPipeline, error) {
	if cfg.SampleRate <= 0 {
		return nil, fmt.Errorf("opus_pipeline: SampleRate must be positive, got %d", cfg.SampleRate)
	}

	quality := cfg.Quality
	if quality == "" {
		quality = "opus"
	}

	mode := cfg.Mode
	if mode == "" {
		mode = "nfm"
	}

	channels := channelsForMode(mode)
	if cfg.Stereo {
		channels = 2
	}

	bitrate := cfg.Bitrate
	if bitrate <= 0 {
		bitrate = bitrateForQuality(quality, channels)
	}

	// Create demodulator
	demodBlock := createDemodBlock(mode)
	if demodBlock == nil {
		return nil, fmt.Errorf("opus_pipeline: unsupported mode %q", mode)
	}

	// Initialize demodulator with the IQ sample rate
	ctx := dsp.BlockContext{
		SampleRate: float64(cfg.SampleRate),
	}
	if err := demodBlock.Init(ctx); err != nil {
		return nil, fmt.Errorf("opus_pipeline: demod init failed: %w", err)
	}

	// Create Opus encoder (48kHz — demod output is decimated to 48k if needed)
	encoder, err := codec.NewOpusEncoder(codec.OpusEncoderConfig{
		SampleRate: 48000,
		Channels:   channels,
		Bitrate:    bitrate,
	})
	if err != nil {
		return nil, fmt.Errorf("opus_pipeline: encoder creation failed: %w", err)
	}

	// Post-demod rate conversion to 48kHz:
	// WFM (240k) → decimate 5:1
	// NFM/AM (48k) → passthrough
	// SSB (24k), CW (12k) → upsample
	decimFactor := 1
	upsampleRatio := 1.0
	if cfg.SampleRate > 48000 {
		decimFactor = cfg.SampleRate / 48000
	} else if cfg.SampleRate < 48000 && cfg.SampleRate > 0 {
		decimFactor = 0 // flag: use upsampler
		upsampleRatio = 48000.0 / float64(cfg.SampleRate)
	}

	p := &OpusPipeline{
		demodulator:   demodBlock,
		encoder:       encoder,
		mode:          mode,
		sampleRate:    cfg.SampleRate,
		channels:      channels,
		quality:       quality,
		decimFactor:   decimFactor,
		upsampleRatio: upsampleRatio,
	}

	return p, nil
}

// Process takes Int16 IQ sub-band (interleaved I,Q) from IqExtractor,
// demodulates, and returns Opus packets ready to send.
func (p *OpusPipeline) Process(iqInt16 []int16) []OpusResult {
	if len(iqInt16) < 2 {
		return nil
	}

	numSamples := len(iqInt16) / 2

	// Step 1: Convert Int16 IQ to complex64
	if cap(p.complexBuf) < numSamples {
		p.complexBuf = make([]complex64, numSamples)
	} else {
		p.complexBuf = p.complexBuf[:numSamples]
	}

	for i := 0; i < numSamples; i++ {
		iVal := float32(iqInt16[i*2]) / 32768.0
		qVal := float32(iqInt16[i*2+1]) / 32768.0
		p.complexBuf[i] = complex(iVal, qVal)
	}

	// Step 2: Demodulate → float32 audio
	// Output size depends on mode:
	// - Stereo modes (wfm, am-stereo) output 2*numSamples (interleaved L,R)
	// - Mono modes output numSamples
	audioOutSize := numSamples * p.channels
	if cap(p.audioBuf) < audioOutSize {
		p.audioBuf = make([]float32, audioOutSize)
	} else {
		p.audioBuf = p.audioBuf[:audioOutSize]
	}

	written := p.demodulator.Process(p.complexBuf, p.audioBuf)
	if written == 0 {
		return nil
	}

	// Determine if the demod output is stereo (interleaved L,R)
	// FM stereo and C-QUAM always output interleaved stereo regardless of p.channels
	demodIsStereo := (p.mode == "wfm" || p.mode == "am-stereo") && written == numSamples*2
	demodFrames := written
	if demodIsStereo {
		demodFrames = written / 2 // number of audio frames (each frame = L+R)
	}

	// Step 3: Rate-convert demod output to 48kHz for Opus
	// Decimation/upsampling operates on FRAMES (not individual samples)
	var audioForOpus []float32
	var outFrames int

	if p.decimFactor == 1 {
		outFrames = demodFrames
	} else if p.decimFactor > 1 {
		outFrames = demodFrames / p.decimFactor
	} else {
		outFrames = int(float64(demodFrames)*p.upsampleRatio) + 4
	}

	// Allocate output based on encoder channels (may differ from demod output)
	outLen := outFrames * p.channels
	if cap(p.rateBuf) < outLen {
		p.rateBuf = make([]float32, outLen)
	} else {
		p.rateBuf = p.rateBuf[:outLen]
	}

	if p.decimFactor == 1 {
		// Passthrough — just handle channel conversion
		if demodIsStereo && p.channels == 2 {
			// Stereo → stereo: copy directly
			copy(p.rateBuf, p.audioBuf[:written])
		} else if demodIsStereo && p.channels == 1 {
			// Stereo → mono: downmix (L+R)/2
			for i := 0; i < demodFrames; i++ {
				p.rateBuf[i] = (p.audioBuf[i*2] + p.audioBuf[i*2+1]) * 0.5
			}
		} else {
			// Mono → mono
			copy(p.rateBuf, p.audioBuf[:written])
		}
		outLen = outFrames * p.channels
	} else if p.decimFactor > 1 {
		// Decimate (WFM 240k → 48k)
		if demodIsStereo && p.channels == 2 {
			for i := 0; i < outFrames; i++ {
				srcIdx := i * p.decimFactor * 2
				p.rateBuf[i*2] = p.audioBuf[srcIdx]
				p.rateBuf[i*2+1] = p.audioBuf[srcIdx+1]
			}
		} else if demodIsStereo && p.channels == 1 {
			// Stereo demod → mono output: downmix + decimate
			for i := 0; i < outFrames; i++ {
				srcIdx := i * p.decimFactor * 2
				p.rateBuf[i] = (p.audioBuf[srcIdx] + p.audioBuf[srcIdx+1]) * 0.5
			}
		} else {
			// Mono demod → mono output: simple decimate
			for i := 0; i < outFrames; i++ {
				p.rateBuf[i] = p.audioBuf[i*p.decimFactor]
			}
		}
		outLen = outFrames * p.channels
	} else {
		// Upsample (SSB/CW)
		outIdx := 0
		for i := 0; i < demodFrames && outIdx < outLen; i++ {
			sample := p.audioBuf[i]
			p.upsampleAccum += p.upsampleRatio
			for p.upsampleAccum >= 1.0 && outIdx < outLen {
				frac := float32(p.upsampleAccum - float64(int(p.upsampleAccum)))
				p.rateBuf[outIdx] = p.lastSample + frac*(sample-p.lastSample)
				outIdx++
				p.upsampleAccum -= 1.0
			}
			p.lastSample = sample
		}
		outLen = outIdx
	}

	audioForOpus = p.rateBuf[:outLen]
	written = outLen

	// Step 4: Convert float32 audio to int16 PCM for Opus
	if cap(p.pcmBuf) < written {
		p.pcmBuf = make([]int16, written)
	} else {
		p.pcmBuf = p.pcmBuf[:written]
	}

	for i := 0; i < written; i++ {
		sample := audioForOpus[i] * 32767.0
		if sample > 32767.0 {
			sample = 32767.0
		} else if sample < -32768.0 {
			sample = -32768.0
		}
		p.pcmBuf[i] = int16(sample)
	}

	// Step 4: Feed PCM to Opus encoder → packets
	packets := p.encoder.Encode(p.pcmBuf[:written])
	if len(packets) == 0 {
		return nil
	}

	// Step 5: Convert to OpusResult
	results := make([]OpusResult, len(packets))
	for i, pkt := range packets {
		results[i] = OpusResult{
			Packet:   pkt.Data,
			Samples:  pkt.Samples,
			Channels: pkt.Channels,
			RdsData:  nil, // RDS extraction is future work
		}
	}

	return results
}

// SetMode changes the demodulator (creates new one).
func (p *OpusPipeline) SetMode(mode string) error {
	newDemod := createDemodBlock(mode)
	if newDemod == nil {
		return fmt.Errorf("opus_pipeline: unsupported mode %q", mode)
	}

	ctx := dsp.BlockContext{
		SampleRate: float64(p.sampleRate),
	}
	if err := newDemod.Init(ctx); err != nil {
		return fmt.Errorf("opus_pipeline: demod init failed for mode %q: %w", mode, err)
	}

	newChannels := channelsForMode(mode)

	// If channel count changed, update the Opus encoder
	if newChannels != p.channels {
		if err := p.encoder.SetChannels(newChannels); err != nil {
			return fmt.Errorf("opus_pipeline: failed to set channels to %d: %w", newChannels, err)
		}
		// Update bitrate for new channel count
		newBitrate := bitrateForQuality(p.quality, newChannels)
		if err := p.encoder.SetBitrate(newBitrate); err != nil {
			return fmt.Errorf("opus_pipeline: failed to set bitrate to %d: %w", newBitrate, err)
		}
		p.channels = newChannels
	}

	p.demodulator = newDemod
	p.mode = mode
	return nil
}

// UpdateSampleRate updates the input sample rate and recalculates resample ratio.
// Call this when the IQ extractor output rate changes (e.g., mode switch).
// UpdateSampleRate updates the input sample rate and recalculates rate conversion.
func (p *OpusPipeline) UpdateSampleRate(newRate int) {
	p.sampleRate = newRate
	if newRate > 48000 {
		p.decimFactor = newRate / 48000
		p.upsampleRatio = 1.0
	} else if newRate < 48000 && newRate > 0 {
		p.decimFactor = 0
		p.upsampleRatio = 48000.0 / float64(newRate)
	} else {
		p.decimFactor = 1
		p.upsampleRatio = 1.0
	}
	p.upsampleAccum = 0
	p.lastSample = 0
}

// SetStereo enables or disables stereo encoding.
func (p *OpusPipeline) SetStereo(stereo bool) {
	newChannels := 1
	if stereo {
		newChannels = 2
	}
	if newChannels == p.channels {
		return
	}
	p.channels = newChannels
	if p.encoder != nil {
		p.encoder.SetChannels(newChannels)
	}
}

// Reset clears demodulator and encoder state.
func (p *OpusPipeline) Reset() {
	if p.demodulator != nil {
		p.demodulator.Reset()
	}
	if p.encoder != nil {
		p.encoder.Reset()
	}
	p.upsampleAccum = 0
	p.lastSample = 0
}

// Close releases Opus encoder resources.
func (p *OpusPipeline) Close() {
	if p.encoder != nil {
		p.encoder.Close()
		p.encoder = nil
	}
	p.demodulator = nil
	p.complexBuf = nil
	p.audioBuf = nil
	p.pcmBuf = nil
}

// Mode returns the current demodulation mode.
func (p *OpusPipeline) Mode() string {
	return p.mode
}

// Channels returns the current channel count.
func (p *OpusPipeline) Channels() int {
	return p.channels
}

// createDemodBlock creates the appropriate demodulator for a given mode.
func createDemodBlock(mode string) dsp.ComplexToRealBlock {
	switch mode {
	case "wfm":
		return demod.NewFmStereoDemod(50e-6)
	case "nfm":
		return demod.NewFmMonoDemod(750e-6)
	case "am":
		return demod.NewAmDemod()
	case "am-stereo":
		return demod.NewCquamDemod()
	case "sam":
		return demod.NewSamDemod()
	case "usb":
		return demod.NewSsbDemod("usb")
	case "lsb":
		return demod.NewSsbDemod("lsb")
	case "cw":
		return demod.NewCwDemod(700)
	default:
		return demod.NewFmMonoDemod(750e-6)
	}
}

// channelsForMode returns the output channel count for a demodulation mode.
func channelsForMode(mode string) int {
	switch mode {
	case "wfm", "am-stereo":
		return 2
	default:
		return 1
	}
}

// bitrateForQuality returns the Opus bitrate based on quality level and channels.
func bitrateForQuality(quality string, channels int) int {
	switch quality {
	case "opus-hq":
		if channels == 2 {
			return 192000
		}
		return 128000
	default: // "opus"
		if channels == 2 {
			return 64000
		}
		return 32000
	}
}
