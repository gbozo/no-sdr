package dongle

import (
	"encoding/json"
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
	Mode          string // "wfm", "nfm", "am", "am-stereo", "usb", "lsb", "cw", "sam"
	SampleRate    int    // IQ extractor output rate
	Bitrate       int    // Opus bitrate (0 = auto based on codec quality)
	StereoEnabled *bool  // nil = default true; set false to start in mono from first frame
	Quality       string // "opus" or "opus-hq"
}

// OpusPipeline performs server-side demodulation + Opus encoding.
// Used when client selects "opus" or "opus-hq" IQ codec.
// For WFM (240k): demod outputs 240k → integer decimate 5:1 → 48k → Opus.
// For NFM/AM (48k): demod outputs 48k → direct to Opus.
// For SSB/CW (24k/12k): demod outputs 24k/12k → upsample to 48k → Opus.
type OpusPipeline struct {
	demodulator dsp.ComplexToRealBlock
	encoder     *codec.OpusEncoder
	mode        string
	sampleRate  int
	channels    int
	quality     string // "opus" or "opus-hq"

	// Rate conversion to 48kHz for Opus.
	// WFM: demod now decimates internally (240k→48k inside FmStereoDemod).
	// NFM/AM (48k): passthrough (decimFactor=1).
	// SSB (24k), CW (12k): upsample (decimFactor=0, upsampleRatio>1).
	decimFactor   int     // >1 = decimate, 1 = passthrough, 0 = needs upsample
	upsampleRatio float64 // >1 for SSB/CW (e.g., 2.0 for 24k→48k)
	upsampleAccum float64
	lastSample    float32

	// bandwidth stores the last bandwidth value set by the client (Hz).
	// Persisted here so SetMode() can re-apply it when the demodulator is replaced.
	// 0 means "not set" (no audio LPF applied).
	bandwidth int

	// stereoEnabled tracks the user's explicit stereo preference.
	// true = auto (pilot-driven for WFM); false = force mono regardless of demod.
	stereoEnabled bool

	// Stereo hysteresis — only switch encoder channel count after STEREO_HOLD_FRAMES
	// consecutive frames agree (matches Node.js STEREO_HOLD_FRAMES=10).
	// Only active when stereoEnabled==true.
	stereoHoldCounter int
	pendingChannels   int // 0 = no pending change

	// Buffers
	complexBuf []complex64 // Int16 IQ → complex64 conversion
	audioBuf   []float32   // demodulator output
	rateBuf    []float32   // rate-converted audio (48kHz)
	pcmBuf     []int16     // float32 → int16 for Opus

	// RDS decoder — only non-nil when mode=="wfm"
	rdsDecoder   *demod.RdsDecoder
	rdsLastJSON  []byte       // last JSON snapshot sent to the client (nil = never sent)
}

const stereoHoldFrames = 10

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
	// Respect the caller's stereo preference. Default is true (stereo allowed) if not specified.
	stereoEnabled := true
	if cfg.StereoEnabled != nil {
		stereoEnabled = *cfg.StereoEnabled
	}
	if !stereoEnabled {
		channels = 1
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

	// Create Opus encoder (48kHz)
	encoder, err := codec.NewOpusEncoder(codec.OpusEncoderConfig{
		SampleRate: 48000,
		Channels:   channels,
		Bitrate:    bitrate,
	})
	if err != nil {
		return nil, fmt.Errorf("opus_pipeline: encoder creation failed: %w", err)
	}

	// Post-demod rate conversion to 48kHz.
	// WFM: FmStereoDemod already decimates 240k→48k internally.
	// NFM/AM (48k): passthrough.
	// SSB (24k), CW (12k): upsample.
	decimFactor := 1
	upsampleRatio := 1.0
	demodOutRate := cfg.SampleRate
	if mode == "wfm" {
		demodOutRate = 48000 // FmStereoDemod decimates internally
	}
	if demodOutRate > 48000 {
		decimFactor = demodOutRate / 48000
	} else if demodOutRate < 48000 && demodOutRate > 0 {
		decimFactor = 0 // flag: use upsampler
		upsampleRatio = 48000.0 / float64(demodOutRate)
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
		stereoEnabled: stereoEnabled,
	}

	// Wire RDS decoder for WFM — operates on composite at the full input rate (240kHz).
	if mode == "wfm" {
		p.rdsDecoder = demod.NewRdsDecoder(float64(cfg.SampleRate))
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

	// Step 2: Demodulate → float32 audio.
	// For WFM: FmStereoDemod decimates internally (240k→48k) and returns
	// interleaved L,R at 48kHz. Max output = numSamples/decimFactor*2 for stereo.
	// For others: output ~ numSamples.
	audioMaxSize := numSamples * 2 // generous upper bound for stereo
	if cap(p.audioBuf) < audioMaxSize {
		p.audioBuf = make([]float32, audioMaxSize)
	} else {
		p.audioBuf = p.audioBuf[:audioMaxSize]
	}

	written := p.demodulator.Process(p.complexBuf, p.audioBuf)
	if written == 0 {
		return nil
	}

	// Extract RDS from the composite baseband (WFM only, before stereo matrix / decimation).
	// FmStereoDemod.GetComposite() returns the discriminator output at 240kHz.
	// RdsDecoder.Process() returns non-nil only when a complete RDS group is decoded.
	// We only emit JSON when the decoded data has changed since the last send.
	var rdsJSON []byte
	if p.rdsDecoder != nil {
		if stereoDemod, ok := p.demodulator.(*demod.FmStereoDemod); ok {
			composite := stereoDemod.GetComposite()
			if rdsData := p.rdsDecoder.Process(composite); rdsData != nil {
				if b, err := json.Marshal(rdsData); err == nil {
					if string(b) != string(p.rdsLastJSON) {
						rdsJSON = b
						p.rdsLastJSON = b
					}
				}
			}
		}
	}

	// Determine if the demod output is stereo (interleaved L,R).
	// WFM: FmStereoDemod outputs interleaved L,R already at 48kHz.
	// am-stereo: outputs interleaved L,R at input rate.
	demodIsStereo := (p.mode == "wfm" || p.mode == "am-stereo")
	demodFrames := written
	if demodIsStereo {
		demodFrames = written / 2 // number of audio frames (each frame = L+R pair)
	}

	// Stereo/mono encoder hysteresis — only switch encoder channels after
	// stereoHoldFrames consecutive frames agree (matches Node.js STEREO_HOLD_FRAMES=10).
	// When the user has explicitly disabled stereo (stereoEnabled==false), force mono
	// and skip the hysteresis logic entirely.
	needChannels := p.channels
	if !p.stereoEnabled {
		// User disabled stereo: force mono, clear any pending switch.
		needChannels = 1
		p.pendingChannels = 0
		p.stereoHoldCounter = 0
		if needChannels != p.channels {
			p.channels = needChannels
			if err := p.encoder.SetChannels(needChannels); err == nil {
				newBitrate := bitrateForQuality(p.quality, needChannels)
				_ = p.encoder.SetBitrate(newBitrate)
			}
		}
	} else if demodIsStereo {
		needChannels = 2
	} else {
		needChannels = 1
	}
	if p.stereoEnabled && needChannels != p.channels {
		if p.pendingChannels != needChannels {
			p.pendingChannels = needChannels
			p.stereoHoldCounter = 0
		} else {
			p.stereoHoldCounter++
			if p.stereoHoldCounter >= stereoHoldFrames {
				p.channels = needChannels
				if err := p.encoder.SetChannels(needChannels); err == nil {
					newBitrate := bitrateForQuality(p.quality, needChannels)
					_ = p.encoder.SetBitrate(newBitrate)
				}
				p.pendingChannels = 0
				p.stereoHoldCounter = 0
			}
		}
	} else {
		p.pendingChannels = 0
		p.stereoHoldCounter = 0
	}

	// Step 3: Rate-convert demod output to 48kHz for Opus.
	// decimFactor == 1: passthrough (NFM/AM already at 48kHz; WFM demod decimates internally).
	// decimFactor > 1: additional decimation (am-stereo at 48kHz is passthrough; unused case).
	// decimFactor == 0: upsample (SSB/CW below 48kHz).
	var audioForOpus []float32
	var outLen int

	if p.decimFactor == 1 {
		// Passthrough — handle channel conversion only
		if demodIsStereo && p.channels == 2 {
			// Stereo → stereo: use directly
			audioForOpus = p.audioBuf[:written]
			outLen = written
		} else if demodIsStereo && p.channels == 1 {
			// Stereo → mono: downmix (L+R)/2
			outLen = demodFrames
			if cap(p.rateBuf) < outLen {
				p.rateBuf = make([]float32, outLen)
			}
			p.rateBuf = p.rateBuf[:outLen]
			for i := 0; i < demodFrames; i++ {
				p.rateBuf[i] = (p.audioBuf[i*2] + p.audioBuf[i*2+1]) * 0.5
			}
			audioForOpus = p.rateBuf[:outLen]
		} else {
			// Mono → mono
			audioForOpus = p.audioBuf[:written]
			outLen = written
		}
	} else if p.decimFactor > 1 {
		// Decimate (non-WFM stereo at rate > 48kHz — uncommon)
		outFrames := demodFrames / p.decimFactor
		outLen = outFrames * p.channels
		if cap(p.rateBuf) < outLen {
			p.rateBuf = make([]float32, outLen)
		}
		p.rateBuf = p.rateBuf[:outLen]
		if demodIsStereo && p.channels == 2 {
			for i := 0; i < outFrames; i++ {
				srcIdx := i * p.decimFactor * 2
				p.rateBuf[i*2] = p.audioBuf[srcIdx]
				p.rateBuf[i*2+1] = p.audioBuf[srcIdx+1]
			}
		} else if demodIsStereo && p.channels == 1 {
			for i := 0; i < outFrames; i++ {
				srcIdx := i * p.decimFactor * 2
				p.rateBuf[i] = (p.audioBuf[srcIdx] + p.audioBuf[srcIdx+1]) * 0.5
			}
		} else {
			for i := 0; i < outFrames; i++ {
				p.rateBuf[i] = p.audioBuf[i*p.decimFactor]
			}
		}
		audioForOpus = p.rateBuf[:outLen]
	} else {
		// Upsample (SSB/CW)
		estOut := int(float64(demodFrames)*p.upsampleRatio) + 4
		if cap(p.rateBuf) < estOut {
			p.rateBuf = make([]float32, estOut)
		}
		outIdx := 0
		for i := 0; i < demodFrames && outIdx < estOut; i++ {
			sample := p.audioBuf[i]
			p.upsampleAccum += p.upsampleRatio
			for p.upsampleAccum >= 1.0 && outIdx < estOut {
				frac := float32(p.upsampleAccum - float64(int(p.upsampleAccum)))
				p.rateBuf[outIdx] = p.lastSample + frac*(sample-p.lastSample)
				outIdx++
				p.upsampleAccum -= 1.0
			}
			p.lastSample = sample
		}
		outLen = outIdx
		audioForOpus = p.rateBuf[:outLen]
	}

	if outLen == 0 {
		return nil
	}

	// Step 4: Convert float32 audio to int16 PCM for Opus
	if cap(p.pcmBuf) < outLen {
		p.pcmBuf = make([]int16, outLen)
	} else {
		p.pcmBuf = p.pcmBuf[:outLen]
	}

	for i := 0; i < outLen; i++ {
		sample := audioForOpus[i] * 32767.0
		if sample > 32767.0 {
			sample = 32767.0
		} else if sample < -32768.0 {
			sample = -32768.0
		}
		p.pcmBuf[i] = int16(sample)
	}

	// Step 5: Feed PCM to Opus encoder → packets
	packets := p.encoder.Encode(p.pcmBuf[:outLen])
	if len(packets) == 0 {
		return nil
	}

	// Step 6: Convert to OpusResult
	results := make([]OpusResult, len(packets))
	for i, pkt := range packets {
		var rds []byte
		if i == 0 {
			// Attach RDS data (if any) only to the first packet of this frame.
			// RDS groups arrive at ~11.4 Hz — one group per ~87ms.
			rds = rdsJSON
		}
		results[i] = OpusResult{
			Packet:   pkt.Data,
			Samples:  pkt.Samples,
			Channels: pkt.Channels,
			RdsData:  rds,
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
	// If stereo is disabled by the user, cap at mono regardless of mode.
	// Process() also enforces this on every frame, but applying it here prevents
	// a one-frame window where the encoder is stereo before stereoEnabled is checked.
	if !p.stereoEnabled {
		newChannels = 1
	}

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

	// Recalculate rate conversion for the new mode.
	// WFM: FmStereoDemod decimates internally (240k→48k), so pipeline decimFactor = 1.
	// This must happen after p.mode is updated so UpdateSampleRate uses the correct mode.
	p.UpdateSampleRate(p.sampleRate)

	// Re-apply bandwidth if it was set before the mode change.
	if p.bandwidth > 0 {
		if bs, ok := p.demodulator.(bandwidthSetter); ok {
			bs.SetBandwidth(float64(p.bandwidth))
		}
	}

	// Update RDS decoder: only active for WFM mode.
	if mode == "wfm" {
		if p.rdsDecoder == nil {
			p.rdsDecoder = demod.NewRdsDecoder(float64(p.sampleRate))
		} else {
			p.rdsDecoder.Reset()
		}
		p.rdsLastJSON = nil
		
	} else {
		p.rdsDecoder = nil
		p.rdsLastJSON = nil
		
	}

	return nil
}

// UpdateSampleRate updates the input sample rate and recalculates rate conversion.
// Call this when the IQ extractor output rate changes (e.g., mode switch).
func (p *OpusPipeline) UpdateSampleRate(newRate int) {
	p.sampleRate = newRate
	// WFM: FmStereoDemod decimates internally (240k→48k), pipeline sees 48kHz output.
	// Other modes: compute decimFactor from actual output rate.
	demodOutRate := newRate
	if p.mode == "wfm" {
		demodOutRate = 48000
	}
	if demodOutRate > 48000 {
		p.decimFactor = demodOutRate / 48000
		p.upsampleRatio = 1.0
	} else if demodOutRate < 48000 && demodOutRate > 0 {
		p.decimFactor = 0
		p.upsampleRatio = 48000.0 / float64(demodOutRate)
	} else {
		p.decimFactor = 1
		p.upsampleRatio = 1.0
	}
	p.upsampleAccum = 0
	p.lastSample = 0
}

// SetStereo enables or disables stereo encoding.
// When disabled, the pipeline immediately forces mono output regardless of demodulator output.
func (p *OpusPipeline) SetStereo(stereo bool) {
	p.stereoEnabled = stereo
	// Reset hysteresis so the change takes effect on the next Process() call.
	p.pendingChannels = 0
	p.stereoHoldCounter = 0
	newChannels := 1
	if stereo {
		// Re-enable stereo only if the demodulator is stereo-capable.
		if p.mode == "wfm" || p.mode == "am-stereo" {
			newChannels = 2
		}
	}
	if newChannels == p.channels {
		return
	}
	p.channels = newChannels
	if p.encoder != nil {
		if err := p.encoder.SetChannels(newChannels); err == nil {
			newBitrate := bitrateForQuality(p.quality, newChannels)
			_ = p.encoder.SetBitrate(newBitrate)
		}
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
	if p.rdsDecoder != nil {
		// Re-create instead of reset to ensure clean sync state.
		p.rdsDecoder = demod.NewRdsDecoder(float64(p.sampleRate))
	}
	p.rdsLastJSON = nil
	
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

// bandwidthSetter is an optional interface implemented by demodulators that
// support audio bandwidth limiting.
type bandwidthSetter interface {
	SetBandwidth(hz float64)
}

// SetBandwidth forwards the bandwidth command to the demodulator if it supports it,
// and stores the value so SetMode() can re-apply it when the demodulator is replaced.
// Called from handleBandwidth under cp.pmu, so no additional lock needed here.
func (p *OpusPipeline) SetBandwidth(hz int) {
	p.bandwidth = hz
	if bs, ok := p.demodulator.(bandwidthSetter); ok {
		bs.SetBandwidth(float64(hz))
	}
}

// createDemodBlock creates the appropriate demodulator for a given mode.
func createDemodBlock(mode string) dsp.ComplexToRealBlock {
	switch mode {
	case "wfm":
		return demod.NewFmStereoDemod(50e-6)
	case "nfm":
		return demod.NewFmMonoDemod(75e-6)
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
		return demod.NewFmMonoDemod(75e-6)
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
