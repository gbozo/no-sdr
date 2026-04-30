package dongle

import (
	"context"
	"log/slog"
	"sync"

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
	mu      sync.Mutex
}

type activeDongle struct {
	id         string
	profile    *config.DongleProfile
	source     *DemoSource
	fftProc    *dsp.FftProcessor
	deflateEnc *codec.FftDeflateEncoder
	cancel     context.CancelFunc
}

// NewManager creates a new dongle pipeline manager.
func NewManager(cfg *config.Config, wsMgr *ws.Manager, logger *slog.Logger) *Manager {
	if logger == nil {
		logger = slog.Default()
	}
	m := &Manager{
		cfg:     cfg,
		wsMgr:   wsMgr,
		logger:  logger,
		dongles: make(map[string]*activeDongle),
	}

	// Register command handler for subscribe/codec messages
	m.wsMgr.SetCommandHandler(m.handleCommand)

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
	return nil
}

// Stop stops all running dongles.
func (m *Manager) Stop() {
	m.mu.Lock()
	defer m.mu.Unlock()

	for id, d := range m.dongles {
		m.logger.Info("stopping dongle", "id", id)
		d.cancel()
		delete(m.dongles, id)
	}
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

	// Create demo source
	source := NewDemoSource(DemoConfig{
		SampleRate: sampleRate,
	})

	ctx, cancel := context.WithCancel(parentCtx)

	ad := &activeDongle{
		id:         dcfg.ID,
		profile:    profile,
		source:     source,
		fftProc:    fftProc,
		deflateEnc: deflateEnc,
		cancel:     cancel,
	}

	m.mu.Lock()
	m.dongles[dcfg.ID] = ad
	m.mu.Unlock()

	m.logger.Info("starting dongle pipeline",
		"id", dcfg.ID,
		"profile", profile.ID,
		"sampleRate", sampleRate,
		"fftSize", profile.FftSize,
		"fftFps", profile.FftFps,
	)

	// Start the pipeline goroutine
	go m.runDongle(ctx, ad)

	return nil
}

// runDongle is the main pipeline loop for a single dongle.
// Runs in its own goroutine.
func (m *Manager) runDongle(ctx context.Context, d *activeDongle) {
	// IQ data channel from the demo source
	iqCh := make(chan []byte, 16)

	// Start the demo source in its own goroutine
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
			// Feed IQ data to FFT processor
			frames := d.fftProc.ProcessIqData(iqChunk)

			// Broadcast each emitted FFT frame
			for _, frame := range frames {
				m.broadcastFftFrame(d, frame)
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
	var adpcmMsg []byte
	var uint8Msg []byte

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
				// Prepend type byte 0x0B
				deflateMsg = make([]byte, 1+len(payload))
				deflateMsg[0] = ws.MsgFFTDeflate
				copy(deflateMsg[1:], payload)
			}
			msg = deflateMsg
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
	case "codec":
		// Client state already updated by ws.Client.UpdateFromCommand()
		// No additional action needed — next broadcast uses new codec
	}
}

// handleSubscribe sends META message to client with profile info.
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

	profile := d.profile

	meta := &ws.ServerMeta{
		CenterFrequency: float64(profile.CenterFrequency),
		SampleRate:      profile.SampleRate,
		FftSize:         profile.FftSize,
		FftFps:          profile.FftFps,
		Mode:            profile.Mode,
		Bandwidth:       profile.Bandwidth,
		DongleId:        dongleID,
		ProfileId:       profile.ID,
		TuneOffset:      profile.TuneOffset,
		TuningStep:      profile.TuningStep,
	}

	m.wsMgr.SendTo(clientID, ws.PackMetaMessage(meta))

	m.logger.Info("client subscribed",
		"clientID", clientID,
		"dongleId", dongleID,
		"profileId", profile.ID,
		"centerFreq", profile.CenterFrequency,
	)
}
