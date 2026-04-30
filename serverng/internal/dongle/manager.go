package dongle

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"runtime"
	"sync"
	"syscall"
	"time"

	"github.com/gbozo/no-sdr/serverng/internal/codec"
	"github.com/gbozo/no-sdr/serverng/internal/config"
	"github.com/gbozo/no-sdr/serverng/internal/dsp"
	"github.com/gbozo/no-sdr/serverng/internal/ws"
)

// Manager manages dongle sources and FFT broadcast pipelines.
type Manager struct {
	cfg     *config.Config
	wsMgr   *ws.Manager
	logger  *slog.Logger
	dongles map[string]*activeDongle

	// Per-client IQ extraction pipelines
	clientPipelines map[string]*clientPipeline

	// Debug counter for periodic logging
	fftFrameCount int64

	mu sync.Mutex
}

type activeDongle struct {
	id         string
	profile    *config.DongleProfile
	dongleCfg  *config.DongleConfig
	source     Source // interface — DemoSource, RtlTcpSource, etc.
	fftProc    *dsp.FftProcessor
	deflateEnc    *codec.FftDeflateEncoder
	deflateFloorEnc *codec.FftDeflateEncoder
	cancel     context.CancelFunc
}

// clientPipeline holds per-client IQ extraction state.
type clientPipeline struct {
	extractor    *dsp.IqExtractor
	adpcmEnc     *codec.ImaAdpcmEncoder
	opusPipeline *OpusPipeline // non-nil for opus/opus-hq clients
	accumBuf     []int16       // 20ms accumulation buffer
	accumPos     int
	chunkSize    int    // int16 samples per 20ms chunk (outputRate * 2 * 0.020)
	iqCodec      string // "adpcm", "opus", "opus-hq"
	dongleID     string // which dongle this client is subscribed to
}

// NewManager creates a new dongle pipeline manager.
func NewManager(cfg *config.Config, wsMgr *ws.Manager, logger *slog.Logger) *Manager {
	if logger == nil {
		logger = slog.Default()
	}
	m := &Manager{
		cfg:             cfg,
		wsMgr:           wsMgr,
		logger:          logger,
		dongles:         make(map[string]*activeDongle),
		clientPipelines: make(map[string]*clientPipeline),
	}

	// Register command handler for subscribe/codec messages
	m.wsMgr.SetCommandHandler(m.handleCommand)
	// Register disconnect handler for client pipeline cleanup
	m.wsMgr.SetDisconnectHandler(m.handleDisconnect)

	return m
}

// Start starts all enabled dongles with autoStart=true.
func (m *Manager) Start(ctx context.Context) error {
	for i := range m.cfg.Dongles {
		dcfg := &m.cfg.Dongles[i]
		if !dcfg.Enabled || !dcfg.AutoStart {
			m.logger.Info("skipping dongle", "id", dcfg.ID, "enabled", dcfg.Enabled, "autoStart", dcfg.AutoStart)
			continue
		}
		if len(dcfg.Profiles) == 0 {
			m.logger.Warn("dongle has no profiles, skipping", "id", dcfg.ID)
			continue
		}
		if err := m.startDongle(ctx, dcfg); err != nil {
			m.logger.Error("failed to start dongle", "id", dcfg.ID, "error", err)
			return err
		}
	}
	// Start server stats broadcaster (CPU, memory, clients — every 2 seconds)
	go m.statsLoop(ctx)
	return nil
}

// Stop stops all running dongles.
func (m *Manager) Stop() {
	m.mu.Lock()
	defer m.mu.Unlock()

	for id, d := range m.dongles {
		m.logger.Info("stopping dongle", "id", id)
		d.cancel()
		if d.source != nil {
			d.source.Close()
		}
		delete(m.dongles, id)
	}

	// Clean up all client pipelines
	for id := range m.clientPipelines {
		delete(m.clientPipelines, id)
	}
}

// StartDongleByID starts a specific dongle by its config ID.
func (m *Manager) StartDongleByID(dongleID string) error {
	// Check if already running
	m.mu.Lock()
	if _, ok := m.dongles[dongleID]; ok {
		m.mu.Unlock()
		return fmt.Errorf("dongle %s is already running", dongleID)
	}
	m.mu.Unlock()

	// Find config
	for i := range m.cfg.Dongles {
		if m.cfg.Dongles[i].ID == dongleID {
			return m.startDongle(context.Background(), &m.cfg.Dongles[i])
		}
	}
	return fmt.Errorf("dongle %s not found in config", dongleID)
}

// StopDongleByID stops a specific running dongle.
func (m *Manager) StopDongleByID(dongleID string) error {
	m.mu.Lock()
	d, ok := m.dongles[dongleID]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("dongle %s is not running", dongleID)
	}
	d.cancel()
	if d.source != nil {
		d.source.Close()
	}
	delete(m.dongles, dongleID)
	m.mu.Unlock()

	m.logger.Info("dongle stopped by admin", "id", dongleID)
	return nil
}

// startDongle creates and runs the pipeline for a single dongle.
func (m *Manager) startDongle(parentCtx context.Context, dcfg *config.DongleConfig) error {
	// Use the first profile as the active profile
	profile := &dcfg.Profiles[0]

	sampleRate := profile.SampleRate
	if sampleRate <= 0 {
		sampleRate = dcfg.SampleRate
	}
	if sampleRate <= 0 {
		sampleRate = 2400000
	}

	// Create FFT processor
	fftProc, err := dsp.NewFftProcessor(dsp.FftProcessorConfig{
		FftSize:    profile.FftSize,
		SampleRate: sampleRate,
		Window:     "blackman-harris",
		Averaging:  0.5,
		TargetFps:  profile.FftFps,
	})
	if err != nil {
		return err
	}

	// Create deflate encoder (reusable, pools internal buffers)
	deflateEnc := codec.NewFftDeflateEncoder(profile.FftSize)
	deflateFloorEnc := codec.NewFftDeflateEncoder(profile.FftSize)

	ctx, cancel := context.WithCancel(parentCtx)

	// Create the appropriate source based on config
	source, err := m.createSource(ctx, dcfg, profile)
	if err != nil {
		cancel()
		return fmt.Errorf("create source for dongle %s: %w", dcfg.ID, err)
	}

	ad := &activeDongle{
		id:         dcfg.ID,
		profile:    profile,
		dongleCfg:  dcfg,
		source:     source,
		fftProc:    fftProc,
		deflateEnc:      deflateEnc,
		deflateFloorEnc: deflateFloorEnc,
		cancel:     cancel,
	}

	m.mu.Lock()
	m.dongles[dcfg.ID] = ad
	m.mu.Unlock()

	m.logger.Info("starting dongle pipeline",
		"id", dcfg.ID,
		"profile", profile.ID,
		"source", dcfg.Source.Type,
		"sampleRate", sampleRate,
		"fftSize", profile.FftSize,
		"fftFps", profile.FftFps,
	)

	// Start the pipeline goroutine
	go m.runDongle(ctx, ad)

	return nil
}

// createSource instantiates the appropriate IQ source based on config.
func (m *Manager) createSource(ctx context.Context, dcfg *config.DongleConfig, profile *config.DongleProfile) (Source, error) {
	sourceType := dcfg.Source.Type
	if sourceType == "" {
		sourceType = "demo" // default to demo if not specified
	}

	sampleRate := profile.SampleRate
	if sampleRate <= 0 {
		sampleRate = dcfg.SampleRate
	}
	if sampleRate <= 0 {
		sampleRate = 2400000
	}

	logger := m.logger.With("dongle", dcfg.ID, "source", sourceType)

	switch sourceType {
	case "demo":
		return NewDemoSource(DemoConfig{SampleRate: sampleRate}), nil

	case "rtl_tcp":
		src := NewRtlTcpSource(RtlTcpConfig{
			Host:   dcfg.Source.Host,
			Port:   dcfg.Source.Port,
			Logger: logger,
		})
		if err := src.Connect(ctx); err != nil {
			return nil, fmt.Errorf("rtl_tcp connect: %w", err)
		}
		m.applyDongleSettings(src, dcfg, profile)
		return src, nil

	case "airspy_tcp":
		src := NewAirspyTcpSource(RtlTcpConfig{
			Host:   dcfg.Source.Host,
			Port:   dcfg.Source.Port,
			Logger: logger,
		})
		if err := src.Connect(ctx); err != nil {
			return nil, fmt.Errorf("airspy_tcp connect: %w", err)
		}
		m.applyDongleSettings(src.RtlTcpSource, dcfg, profile)
		return src, nil

	case "hfp_tcp":
		src := NewHfpTcpSource(RtlTcpConfig{
			Host:   dcfg.Source.Host,
			Port:   dcfg.Source.Port,
			Logger: logger,
		})
		if err := src.Connect(ctx); err != nil {
			return nil, fmt.Errorf("hfp_tcp connect: %w", err)
		}
		m.applyDongleSettings(src.RtlTcpSource, dcfg, profile)
		return src, nil

	case "rsp_tcp":
		src := NewRspTcpSource(RtlTcpConfig{
			Host:   dcfg.Source.Host,
			Port:   dcfg.Source.Port,
			Logger: logger,
		})
		if err := src.Connect(ctx); err != nil {
			return nil, fmt.Errorf("rsp_tcp connect: %w", err)
		}
		m.applyDongleSettings(src.RtlTcpSource, dcfg, profile)
		return src, nil

	case "local":
		src := NewRtlSdrSource(RtlSdrConfig{
			DeviceIndex: dcfg.Source.DeviceIndex,
			Logger:      logger,
		})
		if err := src.Open(); err != nil {
			return nil, fmt.Errorf("local rtlsdr: %w", err)
		}
		return src, nil

	default:
		return nil, fmt.Errorf("unsupported source type: %s", sourceType)
	}
}

// applyDongleSettings sends initial configuration commands to an rtl_tcp-compatible source.
func (m *Manager) applyDongleSettings(src *RtlTcpSource, dcfg *config.DongleConfig, profile *config.DongleProfile) {
	src.SetFrequency(uint32(profile.CenterFrequency))
	src.SetSampleRate(uint32(profile.SampleRate))

	if dcfg.Gain > 0 {
		src.SetGainMode(1) // manual gain
		src.SetGain(uint32(dcfg.Gain * 10)) // tenths of dB
	}
	if dcfg.PPM != 0 {
		src.SetFrequencyCorrection(uint32(dcfg.PPM))
	}
	if dcfg.DirectSampling > 0 {
		src.SetDirectSampling(uint32(dcfg.DirectSampling))
	}
	if dcfg.BiasT {
		src.SetBiasT(1)
	}
	if dcfg.DigitalAgc {
		src.SetAgcMode(1)
	}
	if dcfg.OffsetTuning {
		src.SetOffsetTuning(1)
	}
}

// SwitchProfile switches the active profile on a running dongle.
// If the source is CommandableSource, it sends new frequency/rate/gain commands.
// Rebuilds the FFT processor if fftSize changed. Notifies all subscribed clients.
func (m *Manager) SwitchProfile(dongleID string, profileID string) error {
	m.mu.Lock()
	d, ok := m.dongles[dongleID]
	m.mu.Unlock()

	if !ok {
		return fmt.Errorf("dongle %s not found or not running", dongleID)
	}

	// Find the profile in the dongle config
	var newProfile *config.DongleProfile
	for i := range d.dongleCfg.Profiles {
		if d.dongleCfg.Profiles[i].ID == profileID {
			newProfile = &d.dongleCfg.Profiles[i]
			break
		}
	}
	if newProfile == nil {
		return fmt.Errorf("profile %s not found in dongle %s", profileID, dongleID)
	}

	// If source supports commands, send new frequency/rate/gain
	if cs, ok := d.source.(CommandableSource); ok {
		cs.SetFrequency(uint32(newProfile.CenterFrequency))
		if newProfile.SampleRate > 0 {
			cs.SetSampleRate(uint32(newProfile.SampleRate))
		}
	}

	// Rebuild FFT processor if fftSize changed
	oldFftSize := d.profile.FftSize
	if newProfile.FftSize != oldFftSize && newProfile.FftSize > 0 {
		sampleRate := newProfile.SampleRate
		if sampleRate <= 0 {
			sampleRate = d.dongleCfg.SampleRate
		}
		if sampleRate <= 0 {
			sampleRate = 2400000
		}

		fftProc, err := dsp.NewFftProcessor(dsp.FftProcessorConfig{
			FftSize:    newProfile.FftSize,
			SampleRate: sampleRate,
			Window:     "blackman-harris",
			Averaging:  0.5,
			TargetFps:  newProfile.FftFps,
		})
		if err != nil {
			return fmt.Errorf("rebuild FFT processor: %w", err)
		}

		m.mu.Lock()
		d.fftProc = fftProc
		d.deflateEnc = codec.NewFftDeflateEncoder(newProfile.FftSize)
		d.deflateFloorEnc = codec.NewFftDeflateEncoder(newProfile.FftSize)
		m.mu.Unlock()
	}

	// Update the active profile
	m.mu.Lock()
	d.profile = newProfile
	m.mu.Unlock()

	// Notify all subscribed clients with new META message
	clients := m.wsMgr.SubscribedClients(dongleID)
	iqRate := outputRateForMode(newProfile.Mode)
	meta := &ws.ServerMeta{
		Type:         "profile_changed",
		DongleId:     dongleID,
		ProfileId:    newProfile.ID,
		CenterFreq:  float64(newProfile.CenterFrequency),
		SampleRate:   newProfile.SampleRate,
		FftSize:      newProfile.FftSize,
		IqSampleRate: iqRate,
		Mode:         newProfile.Mode,
		TuningStep:   newProfile.TuningStep,
	}
	metaMsg := ws.PackMetaMessage(meta)
	for _, client := range clients {
		m.wsMgr.SendTo(client.ID, metaMsg)
	}

	m.logger.Info("switched dongle profile",
		"dongleID", dongleID,
		"profileID", profileID,
		"centerFreq", newProfile.CenterFrequency,
	)

	return nil
}

// runDongle is the main pipeline loop for a single dongle.
// Runs in its own goroutine.
func (m *Manager) runDongle(ctx context.Context, d *activeDongle) {
	// IQ data channel from the source
	iqCh := make(chan []byte, 16)

	// Start the source in its own goroutine
	go d.source.Run(ctx, iqCh)

	for {
		select {
		case <-ctx.Done():
			m.logger.Info("dongle pipeline stopped", "id", d.id)
			return
		case iqChunk, ok := <-iqCh:
			if !ok {
				return
			}

			// Per-client IQ extraction — runs BEFORE FFT
			m.processClientIQ(d.id, iqChunk)

			// Feed IQ data to FFT processor
			frames := d.fftProc.ProcessIqData(iqChunk)

			// Broadcast each emitted FFT frame
			for _, frame := range frames {
				m.broadcastFftFrame(d, frame)
			}
		}
	}
}

// processClientIQ extracts sub-band IQ for each client with an active pipeline
// subscribed to the given dongle.
func (m *Manager) processClientIQ(dongleID string, iqChunk []byte) {
	m.mu.Lock()
	// Collect pipelines for this dongle (snapshot under lock)
	type cpEntry struct {
		clientID string
		cp       *clientPipeline
	}
	var entries []cpEntry
	for clientID, cp := range m.clientPipelines {
		if cp.dongleID == dongleID {
			entries = append(entries, cpEntry{clientID, cp})
		}
	}
	m.mu.Unlock()

	if len(entries) == 0 {
		return
	}

	for _, entry := range entries {
		cp := entry.cp
		clientID := entry.clientID

		subBand := cp.extractor.Process(iqChunk)
		if subBand == nil {
			continue
		}

		// Opus pipeline path: demod + encode → send Opus packets
		if cp.opusPipeline != nil {
			results := cp.opusPipeline.Process(subBand)
			for _, r := range results {
				msg := ws.PackAudioOpusMessage(r.Packet, uint16(r.Samples), uint8(r.Channels))
				m.wsMgr.SendTo(clientID, msg)
				if r.RdsData != nil {
					m.wsMgr.SendTo(clientID, ws.PackRDSMessage(r.RdsData))
				}
			}
			continue
		}

		// ADPCM path: accumulate into 20ms chunks
		remaining := subBand
		for len(remaining) > 0 {
			space := cp.chunkSize - cp.accumPos
			toCopy := space
			if toCopy > len(remaining) {
				toCopy = len(remaining)
			}
			copy(cp.accumBuf[cp.accumPos:], remaining[:toCopy])
			cp.accumPos += toCopy
			remaining = remaining[toCopy:]

			if cp.accumPos >= cp.chunkSize {
				// Full 20ms chunk — encode and send
				encoded := cp.adpcmEnc.Encode(cp.accumBuf[:cp.chunkSize])
				// sampleCount = chunkSize / 2 because interleaved I,Q pairs
				msg := ws.PackIQAdpcmMessage(encoded, uint32(cp.chunkSize/2))
				m.wsMgr.SendTo(clientID, msg)
				cp.accumPos = 0
			}
		}
	}
}

// broadcastFftFrame encodes and sends an FFT frame to all subscribed clients,
// using each client's preferred codec. Encoding is done lazily per codec type.
func (m *Manager) broadcastFftFrame(d *activeDongle, fftFrame []float32) {
	clients := m.wsMgr.SubscribedClients(d.id)
	if len(clients) == 0 {
		return
	}

	var minDb float32 = -130
	var maxDb float32 = 0

	// Lazy-encoded messages per codec type
	var deflateMsg []byte
	var deflateFloorMsg []byte
	var adpcmMsg []byte
	var uint8Msg []byte

	// Debug: log codec distribution every 100 frames
	m.fftFrameCount++
	if m.fftFrameCount%100 == 1 {
		codecCounts := map[string]int{}
		for _, c := range clients {
			codec := c.FftCodec
			if codec == "" {
				codec = "(empty/default)"
			}
			codecCounts[codec]++
		}
		m.logger.Debug("FFT broadcast", "dongle", d.id, "clients", len(clients), "codecs", codecCounts, "fftBins", len(fftFrame))
	}

	for _, client := range clients {
		var msg []byte
		switch client.FftCodec {
		case "deflate":
			if deflateMsg == nil {
				payload, err := d.deflateEnc.EncodePayload(fftFrame, minDb, maxDb)
				if err != nil {
					m.logger.Error("deflate encode error", "error", err, "dongle", d.id)
					continue
				}
				deflateMsg = make([]byte, 1+len(payload))
				deflateMsg[0] = ws.MsgFFTDeflate
				copy(deflateMsg[1:], payload)
			}
			msg = deflateMsg
		case "deflate-floor":
			if deflateFloorMsg == nil {
				payload, err := d.deflateFloorEnc.EncodePayloadFloor(fftFrame, minDb, maxDb)
				if err != nil {
					m.logger.Error("deflate-floor encode error", "error", err, "dongle", d.id)
					continue
				}
				deflateFloorMsg = make([]byte, 1+len(payload))
				deflateFloorMsg[0] = ws.MsgFFTDeflate
				copy(deflateFloorMsg[1:], payload)
			}
			msg = deflateFloorMsg
		case "adpcm":
			if adpcmMsg == nil {
				adpcmMsg = ws.PackFFTAdpcmMessage(codec.EncodeFftAdpcm(fftFrame, minDb, maxDb))
			}
			msg = adpcmMsg
		default: // "none" or empty
			if uint8Msg == nil {
				uint8Msg = ws.PackFFTCompressedMessage(codec.CompressFft(fftFrame, minDb, maxDb), int16(minDb), int16(maxDb))
			}
			msg = uint8Msg
		}

		if msg != nil {
			m.wsMgr.SendTo(client.ID, msg)
		}
	}
}

// handleCommand processes client commands dispatched by the WS manager.
func (m *Manager) handleCommand(clientID string, cmd *ws.ClientCommand) {
	switch cmd.Cmd {
	case "subscribe":
		m.handleSubscribe(clientID, cmd)
	case "unsubscribe":
		m.handleUnsubscribe(clientID)
	case "audio_enabled":
		m.handleAudioEnabled(clientID, cmd)
	case "tune":
		m.handleTune(clientID, cmd)
	case "bandwidth":
		m.handleBandwidth(clientID, cmd)
	case "mode":
		m.handleMode(clientID, cmd)
	case "codec":
		m.handleCodecChange(clientID, cmd)
	case "stereo_enabled":
		m.handleStereoEnabled(clientID, cmd)
	case "admin_set_profile":
		m.handleAdminSetProfile(clientID, cmd)
	case "admin_auth":
		m.handleAdminAuth(clientID, cmd)
	case "request_history":
		// TODO: send FFT history frames from FftHistoryBuffer
	case "mute", "volume":
		// Client-side only — acknowledged but no server action needed
	case "set_pre_filter_nb", "set_pre_filter_nb_threshold":
		// TODO: toggle per-client pre-filter noise blanker in IqExtractor
	}
}

// handleAdminAuth validates admin password sent over WebSocket.
func (m *Manager) handleAdminAuth(clientID string, cmd *ws.ClientCommand) {
	if cmd.Password == m.cfg.Server.AdminPassword {
		m.wsMgr.SendTo(clientID, ws.PackMetaMessage(&ws.ServerMeta{Type: "admin_auth_ok"}))
	} else {
		m.wsMgr.SendTo(clientID, ws.PackMetaMessage(&ws.ServerMeta{
			Type:    "error",
			Message: "Invalid admin password",
			Code:    "AUTH_FAILED",
		}))
	}
}

// handleAdminSetProfile switches a dongle to a different profile (admin command).
func (m *Manager) handleAdminSetProfile(clientID string, cmd *ws.ClientCommand) {
	if cmd.DongleId == "" || cmd.ProfileId == "" {
		return
	}
	if err := m.SwitchProfile(cmd.DongleId, cmd.ProfileId); err != nil {
		m.logger.Error("admin_set_profile failed", "error", err, "dongleId", cmd.DongleId, "profileId", cmd.ProfileId)
		errMeta := &ws.ServerMeta{
			Type:    "error",
			Message: "Profile switch failed: " + err.Error(),
			Code:    "PROFILE_SWITCH_FAILED",
		}
		m.wsMgr.SendTo(clientID, ws.PackMetaMessage(errMeta))
	}
}

// handleUnsubscribe removes a client's subscription.
func (m *Manager) handleUnsubscribe(clientID string) {
	client := m.wsMgr.GetClient(clientID)
	if client == nil {
		return
	}
	client.DongleID = ""
	// Destroy any IQ pipeline for this client
	m.mu.Lock()
	if cp, ok := m.clientPipelines[clientID]; ok {
		if cp.opusPipeline != nil {
			cp.opusPipeline.Close()
		}
		delete(m.clientPipelines, clientID)
	}
	m.mu.Unlock()
}

// handleStereoEnabled toggles stereo encoding in the Opus pipeline.
func (m *Manager) handleStereoEnabled(clientID string, cmd *ws.ClientCommand) {
	if cmd.Enabled == nil {
		return
	}
	m.mu.Lock()
	cp, ok := m.clientPipelines[clientID]
	m.mu.Unlock()
	if !ok || cp.opusPipeline == nil {
		return
	}
	// Update the Opus pipeline's stereo state
	if *cmd.Enabled {
		cp.opusPipeline.SetStereo(true)
	} else {
		cp.opusPipeline.SetStereo(false)
	}
}

// handleSubscribe sends META message to client with profile info.
// If profileId is specified and differs from active, switches the dongle to that profile.
func (m *Manager) handleSubscribe(clientID string, cmd *ws.ClientCommand) {
	dongleID := cmd.DongleId
	if dongleID == "" {
		// Default to first dongle if not specified
		if len(m.cfg.Dongles) > 0 {
			dongleID = m.cfg.Dongles[0].ID
		}
	}

	m.mu.Lock()
	d, ok := m.dongles[dongleID]
	m.mu.Unlock()

	if !ok {
		m.logger.Warn("subscribe to unknown dongle", "clientID", clientID, "dongleId", dongleID)
		return
	}

	// If a specific profile was requested and differs from active, switch to it
	if cmd.ProfileId != "" && cmd.ProfileId != d.profile.ID {
		if err := m.SwitchProfile(dongleID, cmd.ProfileId); err != nil {
			m.logger.Error("profile switch failed on subscribe", "error", err, "dongleId", dongleID, "profileId", cmd.ProfileId)
			// Send error to client
			errMeta := &ws.ServerMeta{
				Type:    "error",
				Message: "Profile switch failed: " + err.Error(),
				Code:    "PROFILE_SWITCH_FAILED",
			}
			m.wsMgr.SendTo(clientID, ws.PackMetaMessage(errMeta))
			return
		}
		// Re-fetch dongle state after switch
		m.mu.Lock()
		d = m.dongles[dongleID]
		m.mu.Unlock()
	}

	// Update dongle ID in any existing client pipeline
	m.mu.Lock()
	if cp, exists := m.clientPipelines[clientID]; exists {
		cp.dongleID = dongleID
	}
	m.mu.Unlock()

	profile := d.profile
	iqRate := outputRateForMode(profile.Mode)

	meta := &ws.ServerMeta{
		Type:         "subscribed",
		DongleId:     dongleID,
		ProfileId:    profile.ID,
		CenterFreq:  float64(profile.CenterFrequency),
		SampleRate:   profile.SampleRate,
		FftSize:      profile.FftSize,
		IqSampleRate: iqRate,
		Mode:         profile.Mode,
		TuningStep:   profile.TuningStep,
	}

	m.wsMgr.SendTo(clientID, ws.PackMetaMessage(meta))

	m.logger.Info("client subscribed",
		"clientID", clientID,
		"dongleId", dongleID,
		"profileId", profile.ID,
		"centerFreq", profile.CenterFrequency,
	)
}

// handleAudioEnabled creates or destroys client IQ extraction pipeline.
func (m *Manager) handleAudioEnabled(clientID string, cmd *ws.ClientCommand) {
	if cmd.Enabled == nil {
		return
	}

	if *cmd.Enabled {
		m.createClientPipeline(clientID)
	} else {
		m.destroyClientPipeline(clientID)
	}
}

// handleTune updates the client's IQ extractor NCO offset.
func (m *Manager) handleTune(clientID string, cmd *ws.ClientCommand) {
	m.mu.Lock()
	cp, ok := m.clientPipelines[clientID]
	m.mu.Unlock()

	if ok && cp.extractor != nil {
		cp.extractor.SetTuneOffset(cmd.Offset)
		m.logger.Debug("client tune offset updated", "clientID", clientID, "offset", cmd.Offset)
	}
}

// handleBandwidth updates the client's IQ extractor output rate.
func (m *Manager) handleBandwidth(clientID string, cmd *ws.ClientCommand) {
	m.mu.Lock()
	cp, ok := m.clientPipelines[clientID]
	m.mu.Unlock()

	if ok && cp.extractor != nil {
		cp.extractor.SetOutputSampleRate(cmd.Hz)
		// Update accumulation buffer for new rate
		m.updateChunkSize(cp)
		m.logger.Debug("client bandwidth updated", "clientID", clientID, "hz", cmd.Hz)
	}
}

// handleMode updates output rate based on demodulation mode.
func (m *Manager) handleMode(clientID string, cmd *ws.ClientCommand) {
	m.mu.Lock()
	cp, ok := m.clientPipelines[clientID]
	m.mu.Unlock()

	if ok && cp.extractor != nil {
		rate := outputRateForMode(cmd.Mode)
		cp.extractor.SetOutputSampleRate(rate)
		m.updateChunkSize(cp)

		// Update opus pipeline demodulator if active
		if cp.opusPipeline != nil {
			if err := cp.opusPipeline.SetMode(cmd.Mode); err != nil {
				m.logger.Error("failed to set opus pipeline mode",
					"clientID", clientID, "mode", cmd.Mode, "error", err)
			}
		}

		m.logger.Debug("client mode updated", "clientID", clientID, "mode", cmd.Mode, "outputRate", rate)
	}
}

// handleCodecChange handles IQ codec switching between adpcm and opus.
func (m *Manager) handleCodecChange(clientID string, cmd *ws.ClientCommand) {
	// Client state is updated by ws.Client.UpdateFromCommand() first.
	// Here we handle the pipeline switch.
	if cmd.IqCodec == "" {
		return
	}

	m.mu.Lock()
	cp, ok := m.clientPipelines[clientID]
	m.mu.Unlock()

	if !ok || cp == nil {
		return
	}

	oldCodec := cp.iqCodec
	newCodec := cmd.IqCodec

	// No change needed
	if oldCodec == newCodec {
		return
	}

	isOldOpus := oldCodec == "opus" || oldCodec == "opus-hq"
	isNewOpus := newCodec == "opus" || newCodec == "opus-hq"

	if !isOldOpus && isNewOpus {
		// Switching from ADPCM to Opus: create OpusPipeline
		client := m.wsMgr.GetClient(clientID)
		mode := ""
		if client != nil {
			mode = client.Mode
		}
		if mode == "" {
			mode = "nfm"
		}

		pipeline, err := NewOpusPipeline(OpusPipelineConfig{
			Mode:       mode,
			SampleRate: cp.extractor.OutputSampleRate(),
			Quality:    newCodec,
		})
		if err != nil {
			m.logger.Error("failed to create opus pipeline on codec switch",
				"clientID", clientID, "error", err)
			return
		}

		m.mu.Lock()
		cp.opusPipeline = pipeline
		cp.iqCodec = newCodec
		m.mu.Unlock()

		m.logger.Info("switched to opus pipeline", "clientID", clientID, "codec", newCodec)

	} else if isOldOpus && !isNewOpus {
		// Switching from Opus to ADPCM: destroy OpusPipeline
		m.mu.Lock()
		if cp.opusPipeline != nil {
			cp.opusPipeline.Close()
			cp.opusPipeline = nil
		}
		cp.iqCodec = newCodec
		// Reset ADPCM state
		cp.adpcmEnc.Reset()
		cp.accumPos = 0
		m.mu.Unlock()

		m.logger.Info("switched to adpcm pipeline", "clientID", clientID, "codec", newCodec)

	} else if isOldOpus && isNewOpus && oldCodec != newCodec {
		// Switching between opus and opus-hq: just update bitrate
		m.mu.Lock()
		if cp.opusPipeline != nil {
			channels := cp.opusPipeline.Channels()
			newBitrate := bitrateForQuality(newCodec, channels)
			if err := cp.opusPipeline.encoder.SetBitrate(newBitrate); err != nil {
				m.logger.Error("failed to update opus bitrate",
					"clientID", clientID, "error", err)
			}
		}
		cp.iqCodec = newCodec
		m.mu.Unlock()

		m.logger.Info("switched opus quality", "clientID", clientID, "codec", newCodec)
	}
}

// handleDisconnect cleans up client pipeline when client disconnects.
func (m *Manager) handleDisconnect(clientID string) {
	m.destroyClientPipeline(clientID)
}

// createClientPipeline creates an IQ extraction pipeline for a client.
func (m *Manager) createClientPipeline(clientID string) {
	client := m.wsMgr.GetClient(clientID)
	if client == nil {
		return
	}

	dongleID := client.DongleID
	m.mu.Lock()
	d, ok := m.dongles[dongleID]
	m.mu.Unlock()

	if !ok {
		m.logger.Warn("cannot create pipeline: client not subscribed to a dongle",
			"clientID", clientID, "dongleID", dongleID)
		return
	}

	// Determine output rate from client mode
	mode := client.Mode
	if mode == "" {
		mode = d.profile.Mode
	}
	outputRate := outputRateForMode(mode)

	// Determine tune offset
	tuneOffset := client.TuneOffset
	if tuneOffset == 0 {
		tuneOffset = d.profile.TuneOffset
	}

	// Get input sample rate
	inputRate := d.profile.SampleRate
	if inputRate <= 0 {
		inputRate = 2400000
	}

	ext, err := dsp.NewIqExtractor(dsp.IqExtractorConfig{
		InputSampleRate:  inputRate,
		OutputSampleRate: outputRate,
		TuneOffset:       tuneOffset,
		Logger:           m.logger.With("clientID", clientID),
	})
	if err != nil {
		m.logger.Error("failed to create IQ extractor",
			"clientID", clientID, "error", err)
		return
	}

	// 20ms chunk size: outputRate * 2 channels * 0.020 seconds
	chunkSize := int(float64(ext.OutputSampleRate()) * 2.0 * 0.020)

	// Determine IQ codec
	iqCodec := client.IqCodec
	if iqCodec == "" {
		iqCodec = "adpcm"
	}

	cp := &clientPipeline{
		extractor: ext,
		adpcmEnc:  codec.NewImaAdpcmEncoder(),
		accumBuf:  make([]int16, chunkSize),
		accumPos:  0,
		chunkSize: chunkSize,
		iqCodec:   iqCodec,
		dongleID:  dongleID,
	}

	// Create Opus pipeline if codec is opus or opus-hq
	if iqCodec == "opus" || iqCodec == "opus-hq" {
		pipeline, err := NewOpusPipeline(OpusPipelineConfig{
			Mode:       mode,
			SampleRate: ext.OutputSampleRate(),
			Quality:    iqCodec,
		})
		if err != nil {
			m.logger.Error("failed to create opus pipeline, falling back to adpcm",
				"clientID", clientID, "error", err)
			cp.iqCodec = "adpcm"
		} else {
			cp.opusPipeline = pipeline
		}
	}

	m.mu.Lock()
	m.clientPipelines[clientID] = cp
	m.mu.Unlock()

	m.logger.Info("created client IQ pipeline",
		"clientID", clientID,
		"dongleID", dongleID,
		"inputRate", inputRate,
		"outputRate", ext.OutputSampleRate(),
		"factor", ext.DecimationFactor(),
		"chunkSize", chunkSize,
		"iqCodec", cp.iqCodec,
	)
}

// destroyClientPipeline removes and cleans up a client's IQ extraction pipeline.
func (m *Manager) destroyClientPipeline(clientID string) {
	m.mu.Lock()
	cp, ok := m.clientPipelines[clientID]
	if ok {
		delete(m.clientPipelines, clientID)
	}
	m.mu.Unlock()

	if ok {
		// Clean up opus pipeline resources
		if cp.opusPipeline != nil {
			cp.opusPipeline.Close()
		}
		m.logger.Info("destroyed client IQ pipeline", "clientID", clientID)
	}
}

// updateChunkSize recalculates the 20ms accumulation buffer size after rate change.
func (m *Manager) updateChunkSize(cp *clientPipeline) {
	newSize := int(float64(cp.extractor.OutputSampleRate()) * 2.0 * 0.020)
	if newSize != cp.chunkSize {
		cp.chunkSize = newSize
		cp.accumBuf = make([]int16, newSize)
		cp.accumPos = 0
		cp.adpcmEnc.Reset()
	}
}

// outputRateForMode returns the appropriate output sample rate for a demodulation mode.
func outputRateForMode(mode string) int {
	switch mode {
	case "wfm":
		return 240000
	case "nfm", "am", "am-stereo":
		return 48000
	case "usb", "lsb", "sam":
		return 24000
	case "cw":
		return 12000
	default:
		return 48000
	}
}

// statsLoop broadcasts server stats (CPU%, memory, client count) to all clients every 2 seconds.
func (m *Manager) statsLoop(ctx context.Context) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	var lastCPU int64
	var lastTime time.Time

	// Initialize
	var ru syscall.Rusage
	syscall.Getrusage(syscall.RUSAGE_SELF, &ru)
	lastCPU = ru.Utime.Nano() + ru.Stime.Nano()
	lastTime = time.Now()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// CPU usage
			syscall.Getrusage(syscall.RUSAGE_SELF, &ru)
			nowCPU := ru.Utime.Nano() + ru.Stime.Nano()
			elapsed := time.Since(lastTime)
			cpuDelta := nowCPU - lastCPU
			// cpuPercent = (cpu ns used) / (wall ns elapsed) * 100
			cpuPercent := 0
			if elapsed.Nanoseconds() > 0 {
				cpuPercent = int(cpuDelta * 100 / elapsed.Nanoseconds())
			}
			if cpuPercent > 100 {
				cpuPercent = 100
			}
			lastCPU = nowCPU
			lastTime = time.Now()

			// Memory (RSS)
			var memStats runtime.MemStats
			runtime.ReadMemStats(&memStats)
			memMb := int(memStats.Sys / 1_048_576)

			// Broadcast to all connected clients
			statsJSON, _ := json.Marshal(map[string]any{
				"type":       "server_stats",
				"cpuPercent": cpuPercent,
				"memMb":      memMb,
				"clients":    m.wsMgr.ClientCount(),
			})
			msg := make([]byte, 1+len(statsJSON))
			msg[0] = ws.MsgMeta
			copy(msg[1:], statsJSON)

			// Send to all clients
			m.wsMgr.BroadcastAll(msg)
		}
	}
}
