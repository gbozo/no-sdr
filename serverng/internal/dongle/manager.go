package dongle

import (
	"bytes"
	"compress/flate"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"os/exec"
	"runtime"
	"strconv"
	"sync"
	"syscall"
	"time"

	codecPkg "github.com/gbozo/no-sdr/serverng/internal/codec"
	"github.com/gbozo/no-sdr/serverng/internal/config"
	"github.com/gbozo/no-sdr/serverng/internal/dsp"
	"github.com/gbozo/no-sdr/serverng/internal/history"
	"github.com/gbozo/no-sdr/serverng/internal/ws"
)

// DongleStatus represents the lifecycle state of a dongle.
type DongleStatus string

const (
	DongleStatusStopped  DongleStatus = "stopped"
	DongleStatusStarting DongleStatus = "starting"
	DongleStatusRunning  DongleStatus = "running"
	DongleStatusRetrying DongleStatus = "retrying"
	DongleStatusError    DongleStatus = "error"
)

// DongleState holds the current status and retry information for a dongle.
type DongleState struct {
	Status     DongleStatus `json:"status"`
	RetryCount int          `json:"retryCount,omitempty"`
	MaxRetries int          `json:"maxRetries,omitempty"`
	LastError  string       `json:"lastError,omitempty"`
}

// Manager manages dongle sources and FFT broadcast pipelines.
type Manager struct {
	cfg     *config.Config
	wsMgr   *ws.Manager
	logger  *slog.Logger
	dongles map[string]*activeDongle

	// Per-dongle lifecycle state (includes non-running dongles)
	dongleStates map[string]*DongleState

	// Per-client IQ extraction pipelines
	clientPipelines map[string]*clientPipeline

	// IQ recorder (SigMF)
	Recorder *Recorder

	// getVersion returns the current config version for notifications.
	// Set by main.go after config version is created.
	getVersion func() uint64

	// Debug counter for periodic logging
	fftFrameCount int64

	mu sync.Mutex
}

// opusComplexity returns the configured Opus complexity, defaulting to 5.
func (m *Manager) opusComplexity() int {
	if m.cfg.Server.OpusComplexity > 0 {
		return m.cfg.Server.OpusComplexity
	}
	return 5
}

type activeDongle struct {
	id         string
	profile    *config.DongleProfile
	dongleCfg  *config.DongleConfig
	source     Source // interface — DemoSource, RtlTcpSource, etc.
	fftProc    *dsp.FftProcessor
	deflateEnc    *codecPkg.FftDeflateEncoder
	deflateFloorEnc *codecPkg.FftDeflateEncoder
	fftHistory *history.FftBuffer
	cancel     context.CancelFunc
}

// clientPipeline holds per-client IQ extraction state.
type clientPipeline struct {
	// pmu protects opusPipeline field only — used by both the hot path
	// goroutine (processClientIQ) and command handler goroutines.
	pmu          sync.Mutex
	extractor    *dsp.IqExtractor
	adpcmEnc     *codecPkg.ImaAdpcmEncoder
	opusPipeline *OpusPipeline // non-nil for opus/opus-hq clients; guarded by pmu
	accumBuf     []int16       // 20ms accumulation buffer
	accumPos     int
	chunkSize    int    // int16 samples per 20ms chunk (outputRate * 2 * 0.020)
	iqCodec      string // "none", "adpcm", "opus", "opus-hq"
	dongleID     string // which dongle this client is subscribed to
	nbEnabled    bool
	nbThreshold  float32 // multiplier (default 10.0)
	iqChunkCount int64   // debug counter
	stereoEnabled bool   // remembered stereo preference, applied on pipeline creation
}

// maxRetries is the number of retry attempts for dongle initialization.
const maxRetries = 5

// retryBackoff returns the backoff duration for the given attempt (0-indexed).
// Sequence: 1s, 2s, 4s, 8s, 16s.
func retryBackoff(attempt int) time.Duration {
	d := time.Second << uint(attempt)
	if d > 16*time.Second {
		d = 16 * time.Second
	}
	return d
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
		dongleStates:    make(map[string]*DongleState),
		clientPipelines: make(map[string]*clientPipeline),
		Recorder:        NewRecorder("recordings", logger),
	}

	// Initialize state for all configured dongles.
	for _, d := range cfg.Dongles {
		m.dongleStates[d.ID] = &DongleState{Status: DongleStatusStopped}
	}

	// Register command handler for subscribe/codec messages
	m.wsMgr.SetCommandHandler(m.handleCommand)
	// Register disconnect handler for client pipeline cleanup
	m.wsMgr.SetDisconnectHandler(m.handleDisconnect)
	// Register connect handler to send state_sync on new connections
	m.wsMgr.SetConnectHandler(m.SendStateSync)

	return m
}

// SetVersionFunc sets the function used to get the current config version.
// Called by main.go after the config version counter is created.
func (m *Manager) SetVersionFunc(fn func() uint64) {
	m.getVersion = fn
}

// currentVersion returns the current config version, or 0 if not set.
func (m *Manager) currentVersion() uint64 {
	if m.getVersion == nil {
		return 0
	}
	return m.getVersion()
}

// Start starts all enabled dongles with autoStart=true.
// Failing dongles are retried up to maxRetries times with exponential backoff.
// The server continues even if some dongles fail to start.
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
		if err := m.startDongleWithRetry(ctx, dcfg); err != nil {
			// Log the failure but continue — do not kill the server
			m.logger.Error("dongle failed after all retries, skipping",
				"id", dcfg.ID,
				"error", err,
				"retries", maxRetries,
			)
		}
	}
	// Start server stats broadcaster (CPU, memory, clients — every 2 seconds)
	go m.statsLoop(ctx)
	return nil
}

// startDongleWithRetry attempts to start a dongle up to maxRetries times
// with exponential backoff. Updates dongle state throughout the process.
func (m *Manager) startDongleWithRetry(ctx context.Context, dcfg *config.DongleConfig) error {
	m.mu.Lock()
	state, ok := m.dongleStates[dcfg.ID]
	if !ok {
		state = &DongleState{}
		m.dongleStates[dcfg.ID] = state
	}
	state.Status = DongleStatusStarting
	state.RetryCount = 0
	state.MaxRetries = maxRetries
	state.LastError = ""
	m.mu.Unlock()

	var lastErr error
	for attempt := 0; attempt < maxRetries; attempt++ {
		if attempt > 0 {
			m.mu.Lock()
			state.Status = DongleStatusRetrying
			state.RetryCount = attempt
			m.mu.Unlock()

			backoff := retryBackoff(attempt - 1)
			m.logger.Info("retrying dongle start",
				"id", dcfg.ID,
				"attempt", attempt+1,
				"maxRetries", maxRetries,
				"backoff", backoff,
			)

			select {
			case <-ctx.Done():
				m.mu.Lock()
				state.Status = DongleStatusStopped
				m.mu.Unlock()
				return ctx.Err()
			case <-time.After(backoff):
			}
		}

		err := m.startDongle(ctx, dcfg)
		if err == nil {
			m.mu.Lock()
			state.Status = DongleStatusRunning
			state.RetryCount = 0
			state.LastError = ""
			m.mu.Unlock()
			return nil
		}

		lastErr = err
		m.logger.Warn("dongle start attempt failed",
			"id", dcfg.ID,
			"attempt", attempt+1,
			"maxRetries", maxRetries,
			"error", err,
		)
	}

	// All retries exhausted
	m.mu.Lock()
	state.Status = DongleStatusError
	state.RetryCount = maxRetries
	state.LastError = lastErr.Error()
	m.mu.Unlock()

	return fmt.Errorf("dongle %s: all %d attempts failed: %w", dcfg.ID, maxRetries, lastErr)
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

	// Close all client pipelines including their Opus encoders.
	// Without this, libopus encoder memory is leaked on shutdown.
	for id, cp := range m.clientPipelines {
		cp.pmu.Lock()
		if cp.opusPipeline != nil {
			cp.opusPipeline.Close()
			cp.opusPipeline = nil
		}
		cp.pmu.Unlock()
		delete(m.clientPipelines, id)
	}
}

// StartDongleByID starts a specific dongle by its config ID with retry logic.
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
			return m.startDongleWithRetry(context.Background(), &m.cfg.Dongles[i])
		}
	}
	return fmt.Errorf("dongle %s not found in config", dongleID)
}

// StopDongleByID stops a specific running dongle.
// Subscribed clients are unsubscribed and notified.
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

	// Clean up client pipelines for this dongle
	for clientID, cp := range m.clientPipelines {
		if cp.dongleID == dongleID {
			cp.pmu.Lock()
			if cp.opusPipeline != nil {
				cp.opusPipeline.Close()
				cp.opusPipeline = nil
			}
			cp.pmu.Unlock()
			delete(m.clientPipelines, clientID)
		}
	}

	// Update state
	if state, ok := m.dongleStates[dongleID]; ok {
		state.Status = DongleStatusStopped
		state.RetryCount = 0
		state.LastError = ""
	}
	m.mu.Unlock()

	// Unsubscribe WS clients from this dongle
	m.wsMgr.UnsubscribeFromDongle(dongleID, "dongle stopped")

	m.logger.Info("dongle stopped by admin", "id", dongleID)
	return nil
}

// ReinitDongle stops and restarts a running dongle after hardware config changes.
// All subscribed clients are unsubscribed and notified — they must re-subscribe.
// If the dongle was not running, it simply starts it with retry logic.
func (m *Manager) ReinitDongle(dongleID string) error {
	// Find config
	var dcfg *config.DongleConfig
	for i := range m.cfg.Dongles {
		if m.cfg.Dongles[i].ID == dongleID {
			dcfg = &m.cfg.Dongles[i]
			break
		}
	}
	if dcfg == nil {
		return fmt.Errorf("dongle %s not found in config", dongleID)
	}

	// Unsubscribe all clients from this dongle
	affected := m.wsMgr.UnsubscribeFromDongle(dongleID, "dongle reinitialising")
	if len(affected) > 0 {
		m.logger.Info("unsubscribed clients for dongle reinit",
			"dongle", dongleID,
			"clients", len(affected),
		)
	}

	// Clean up client pipelines for affected clients
	m.mu.Lock()
	for _, clientID := range affected {
		if cp, ok := m.clientPipelines[clientID]; ok {
			cp.pmu.Lock()
			if cp.opusPipeline != nil {
				cp.opusPipeline.Close()
				cp.opusPipeline = nil
			}
			cp.pmu.Unlock()
			delete(m.clientPipelines, clientID)
		}
	}

	// Stop existing dongle if running
	if d, ok := m.dongles[dongleID]; ok {
		d.cancel()
		if d.source != nil {
			d.source.Close()
		}
		delete(m.dongles, dongleID)
		m.logger.Info("dongle stopped for reinit", "id", dongleID)
	}
	m.mu.Unlock()

	// Check preconditions
	if !dcfg.Enabled {
		m.mu.Lock()
		if state, ok := m.dongleStates[dongleID]; ok {
			state.Status = DongleStatusStopped
			state.LastError = ""
		}
		m.mu.Unlock()
		m.logger.Info("dongle disabled, skipping reinit start", "id", dongleID)
		return nil
	}
	if len(dcfg.Profiles) == 0 {
		m.mu.Lock()
		if state, ok := m.dongleStates[dongleID]; ok {
			state.Status = DongleStatusStopped
			state.LastError = "no profiles configured"
		}
		m.mu.Unlock()
		m.logger.Warn("dongle has no profiles, cannot reinit", "id", dongleID)
		return nil
	}

	// Start with retry
	return m.startDongleWithRetry(context.Background(), dcfg)
}

// HandleProfileRemoved handles cascading effects when a profile is deleted.
// If the deleted profile was the active profile on a running dongle, it switches
// to the next available profile. If no profiles remain, the dongle is stopped.
func (m *Manager) HandleProfileRemoved(dongleID, profileID string) {
	m.mu.Lock()
	d, running := m.dongles[dongleID]
	m.mu.Unlock()

	if !running {
		return // Dongle not running, no cascade needed
	}

	// Check if the removed profile was the active one
	if d.profile == nil || d.profile.ID != profileID {
		return // Not the active profile, no effect
	}

	// Find the dongle config to check remaining profiles
	var dcfg *config.DongleConfig
	for i := range m.cfg.Dongles {
		if m.cfg.Dongles[i].ID == dongleID {
			dcfg = &m.cfg.Dongles[i]
			break
		}
	}
	if dcfg == nil {
		return
	}

	if len(dcfg.Profiles) == 0 {
		// No profiles left — stop the dongle
		m.logger.Warn("active profile deleted and no profiles remain, stopping dongle",
			"dongle", dongleID,
			"deletedProfile", profileID,
		)
		if err := m.StopDongleByID(dongleID); err != nil {
			m.logger.Error("failed to stop dongle after profile removal", "id", dongleID, "error", err)
		}
		return
	}

	// Switch to the first remaining profile
	newProfile := dcfg.Profiles[0]
	m.logger.Info("active profile deleted, switching to next available",
		"dongle", dongleID,
		"deletedProfile", profileID,
		"newProfile", newProfile.ID,
	)
	if err := m.SwitchProfile(dongleID, newProfile.ID); err != nil {
		m.logger.Error("failed to switch profile after deletion",
			"dongle", dongleID,
			"error", err,
		)
	}
}

// needsReinit compares old and new dongle configs to determine if the dongle
// needs to be fully reinitialized (hardware-level changes).
func needsReinit(old, new *config.DongleConfig) bool {
	// Source type changed
	if old.Source.Type != new.Source.Type {
		return true
	}
	// Source connection params changed
	if old.Source.Host != new.Source.Host || old.Source.Port != new.Source.Port {
		return true
	}
	if old.Source.DeviceIndex != new.Source.DeviceIndex || old.Source.Serial != new.Source.Serial {
		return true
	}
	if old.Source.Binary != new.Source.Binary || old.Source.SpawnRtlTcp != new.Source.SpawnRtlTcp {
		return true
	}
	// Top-level sample rate changed (affects the source)
	if old.SampleRate != new.SampleRate {
		return true
	}
	return false
}

// GetDongleState returns the current lifecycle state for a dongle.
func (m *Manager) GetDongleState(dongleID string) DongleState {
	m.mu.Lock()
	defer m.mu.Unlock()
	if state, ok := m.dongleStates[dongleID]; ok {
		return *state
	}
	return DongleState{Status: DongleStatusStopped}
}

// GetAllDongleStates returns the lifecycle state for all configured dongles.
func (m *Manager) GetAllDongleStates() map[string]DongleState {
	m.mu.Lock()
	defer m.mu.Unlock()
	states := make(map[string]DongleState, len(m.dongleStates))
	for id, state := range m.dongleStates {
		states[id] = *state
	}
	return states
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
	deflateEnc := codecPkg.NewFftDeflateEncoder(profile.FftSize)
	deflateFloorEnc := codecPkg.NewFftDeflateEncoder(profile.FftSize)

	ctx, cancel := context.WithCancel(parentCtx)

	// Create the appropriate source based on config
	source, err := m.createSource(ctx, dcfg, profile)
	if err != nil {
		cancel()
		return fmt.Errorf("create source for dongle %s: %w", dcfg.ID, err)
	}

	ad := &activeDongle{
		id:              dcfg.ID,
		profile:         profile,
		dongleCfg:       dcfg,
		source:          source,
		fftProc:         fftProc,
		deflateEnc:      deflateEnc,
		deflateFloorEnc: deflateFloorEnc,
		fftHistory:      history.NewFftBuffer(1024),
		cancel:          cancel,
	}

	m.mu.Lock()
	m.dongles[dcfg.ID] = ad
	// Update state to running
	if state, ok := m.dongleStates[dcfg.ID]; ok {
		state.Status = DongleStatusRunning
		state.LastError = ""
		state.RetryCount = 0
	}
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
	// Server-level demoMode overrides all source types
	if m.cfg.Server.DemoMode {
		sourceType = "demo"
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
		var spawnedCmd *exec.Cmd
		if dcfg.Source.SpawnRtlTcp {
			spawnedCmd = m.spawnRtlTcp(ctx, dcfg)
		}
		src := NewRtlTcpSource(RtlTcpConfig{
			Host:       dcfg.Source.Host,
			Port:       dcfg.Source.Port,
			SpawnedCmd: spawnedCmd,
			Logger:     logger,
		})
		if err := src.Connect(ctx); err != nil {
			if spawnedCmd != nil {
				spawnedCmd.Process.Kill() //nolint:errcheck
			}
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
			Serial:      dcfg.Source.Serial,
			Logger:      logger,
		})
		if err := src.Open(); err != nil {
			return nil, fmt.Errorf("local rtlsdr: %w", err)
		}
		m.applyDongleSettings(src, dcfg, profile)
		return src, nil

	default:
		return nil, fmt.Errorf("unsupported source type: %s", sourceType)
	}
}

// spawnRtlTcp spawns an rtl_tcp process for the given dongle config.
// It waits up to 2 seconds for the process to open its TCP port before returning.
// Returns the running *exec.Cmd, or nil if spawn fails (error is logged but not fatal).
func (m *Manager) spawnRtlTcp(ctx context.Context, dcfg *config.DongleConfig) *exec.Cmd {
	binary := dcfg.Source.Binary
	if binary == "" {
		binary = "rtl_tcp"
	}

	host := dcfg.Source.Host
	if host == "" {
		host = "127.0.0.1"
	}
	port := dcfg.Source.Port
	if port <= 0 {
		port = 1234
	}

	args := []string{
		"-a", host,
		"-p", strconv.Itoa(port),
		"-d", strconv.Itoa(dcfg.Source.DeviceIndex),
	}
	args = append(args, dcfg.Source.ExtraArgs...)

	cmd := exec.CommandContext(ctx, binary, args...)
	m.logger.Info("spawning rtl_tcp", "binary", binary, "args", args)

	if err := cmd.Start(); err != nil {
		m.logger.Error("failed to spawn rtl_tcp", "error", err)
		return nil
	}

	// Poll for TCP port to open — rtl_tcp typically takes < 500ms.
	addr := net.JoinHostPort(host, fmt.Sprintf("%d", port))
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, 100*time.Millisecond)
		if err == nil {
			conn.Close()
			m.logger.Info("rtl_tcp ready", "addr", addr, "pid", cmd.Process.Pid)
			return cmd
		}
		select {
		case <-ctx.Done():
			_ = cmd.Process.Kill()
			return nil
		case <-time.After(100 * time.Millisecond):
		}
	}

	m.logger.Warn("rtl_tcp spawn timeout — port not ready, proceeding anyway",
		"addr", addr, "pid", cmd.Process.Pid)
	return cmd
}

// applyDongleSettings sends initial configuration commands to any CommandableSource.
func (m *Manager) applyDongleSettings(src CommandableSource, dcfg *config.DongleConfig, profile *config.DongleProfile) {
	// Frequency: center + oscillator offset (compensates LO error)
	freq := uint32(profile.CenterFrequency + int64(profile.OscillatorOffset))
	src.SetFrequency(freq)

	if profile.SampleRate > 0 {
		src.SetSampleRate(uint32(profile.SampleRate))
	}

	// Gain: profile-level overrides dongle-level
	if profile.Gain > 0 {
		src.SetGainMode(1) // manual gain
		src.SetGain(uint32(profile.Gain * 10)) // tenths of dB
	} else if dcfg.Gain > 0 {
		src.SetGainMode(1)
		src.SetGain(uint32(dcfg.Gain * 10))
	}

	if dcfg.PPM != 0 {
		src.SetFrequencyCorrection(uint32(dcfg.PPM))
	}

	// Direct sampling: profile overrides dongle (always send, even 0 to disable)
	ds := dcfg.DirectSampling
	if profile.DirectSampling != 0 {
		ds = profile.DirectSampling
	}
	src.SetDirectSampling(uint32(ds))

	// Bias-T: always send (0 to disable, 1 to enable)
	if dcfg.BiasT {
		src.SetBiasT(1)
	} else {
		src.SetBiasT(0)
	}

	if dcfg.DigitalAgc {
		src.SetAgcMode(1)
	} else {
		src.SetAgcMode(0)
	}

	// Offset tuning: always send
	if dcfg.OffsetTuning {
		src.SetOffsetTuning(1)
	} else {
		src.SetOffsetTuning(0)
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
		// Frequency + oscillator offset
		freq := uint32(newProfile.CenterFrequency + int64(newProfile.OscillatorOffset))
		cs.SetFrequency(freq)
		if newProfile.SampleRate > 0 {
			cs.SetSampleRate(uint32(newProfile.SampleRate))
		}
		// Per-profile gain (overrides dongle-level)
		if newProfile.Gain > 0 {
			cs.SetGainMode(1)
			cs.SetGain(uint32(newProfile.Gain * 10))
		}
		// Per-profile direct sampling (always send, even 0)
		ds := d.dongleCfg.DirectSampling
		if newProfile.DirectSampling != 0 {
			ds = newProfile.DirectSampling
		}
		cs.SetDirectSampling(uint32(ds))
		// Bias-T always sent (so switching from HF profile to VHF disables it)
		if d.dongleCfg.BiasT {
			cs.SetBiasT(1)
		} else {
			cs.SetBiasT(0)
		}
		// Offset tuning always sent
		if d.dongleCfg.OffsetTuning {
			cs.SetOffsetTuning(1)
		} else {
			cs.SetOffsetTuning(0)
		}
	}

	// Always rebuild the FFT processor on SwitchProfile. We cannot compare old vs
	// new values here because when called from NotifyProfileUpdated (admin profile
	// edit), d.profile and newProfile are the same pointer — the config was already
	// mutated in-place before this function is called.
	if newProfile.FftSize > 0 {
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
		d.deflateEnc = codecPkg.NewFftDeflateEncoder(newProfile.FftSize)
		d.deflateFloorEnc = codecPkg.NewFftDeflateEncoder(newProfile.FftSize)
		m.mu.Unlock()
	}

	// Update the active profile
	m.mu.Lock()
	d.profile = newProfile
	// Clear FFT history — frames from the old profile have a different bin count
	// and/or center frequency, so mixing them with new frames causes panics and
	// visual artifacts in the client's history waterfall.
	if d.fftHistory != nil {
		d.fftHistory.Reset()
	}
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
		// Update profile ID on each subscribed client
		m.wsMgr.SetClientProfileID(client.ID, newProfile.ID)
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

			// Swap I/Q channels if profile requests it (fixes inverted spectrum)
			if d.profile.SwapIQ {
				for i := 0; i < len(iqChunk)-1; i += 2 {
					iqChunk[i], iqChunk[i+1] = iqChunk[i+1], iqChunk[i]
				}
			}

			// Feed active IQ recorder (no-op when not recording)
			m.Recorder.WriteIQ(d.id, iqChunk)

			// Per-client IQ extraction — runs BEFORE FFT
			m.processClientIQ(d.id, iqChunk)

			// Feed IQ data to FFT processor
			frames := d.fftProc.ProcessIqData(iqChunk)

			// Broadcast each emitted FFT frame
			for _, frame := range frames {
				d.fftHistory.Push(frame)
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

	// Single client — fast path, no goroutine overhead.
	if len(entries) == 1 {
		m.processOneClient(entries[0].clientID, entries[0].cp, iqChunk)
		return
	}

	// Multiple clients — parallel extraction.
	// Each clientPipeline owns all its mutable state (extractor, demod, accumBuf,
	// adpcmEnc, opusPipeline) so concurrent processing is safe.
	// iqChunk is read-only across all goroutines.
	var wg sync.WaitGroup
	wg.Add(len(entries))
	for _, entry := range entries {
		go func(clientID string, cp *clientPipeline) {
			defer wg.Done()
			m.processOneClient(clientID, cp, iqChunk)
		}(entry.clientID, entry.cp)
	}
	wg.Wait()
}

// processOneClient runs the full IQ extraction → demod/encode → send pipeline
// for a single client. All mutable state lives on cp; iqChunk is read-only.
// This function is safe to call concurrently for different clientPipelines.
func (m *Manager) processOneClient(clientID string, cp *clientPipeline, iqChunk []byte) {
	subBand := cp.extractor.Process(iqChunk)
	if subBand == nil {
		return
	}

	// Debug: log IQ flow every 500 chunks (~5s)
	cp.iqChunkCount++
	if cp.iqChunkCount%500 == 1 {
		m.logger.Debug("IQ extraction",
			"clientID", clientID,
			"inputBytes", len(iqChunk),
			"outputSamples", len(subBand),
			"chunkSize", cp.chunkSize,
			"accumPos", cp.accumPos,
			"codec", cp.iqCodec,
			"totalChunks", cp.iqChunkCount,
		)
	}

	// Opus pipeline path: demod + encode → send Opus packets
	// pmu guards opusPipeline against concurrent codec switch commands.
	cp.pmu.Lock()
	opus := cp.opusPipeline
	cp.pmu.Unlock()
	if opus != nil {
		results := opus.Process(subBand)
		for _, r := range results {
			msg := ws.PackAudioOpusMessage(r.Packet, uint16(r.Samples), uint8(r.Channels))
			m.wsMgr.SendTo(clientID, msg)
			if r.RdsData != nil {
				m.wsMgr.SendTo(clientID, ws.PackRDSMessage(r.RdsData))
			}
		}
		return
	}

	// IQ path: accumulate into 20ms chunks, then encode per codec preference
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
			// Full 20ms chunk — encode and send based on IQ codec
			chunk := cp.accumBuf[:cp.chunkSize]
			sampleRate := uint32(cp.extractor.OutputSampleRate())
			if cp.iqCodec == "adpcm" {
				encoded := cp.adpcmEnc.Encode(chunk)
				// sampleCount = total Int16 values (not IQ pairs)
				msg := ws.PackIQAdpcmMessage(encoded, uint32(cp.chunkSize), sampleRate)
				m.wsMgr.SendTo(clientID, msg)
			} else {
				// "none" — send raw Int16 IQ
				msg := ws.PackIQMessage(chunk, sampleRate)
				m.wsMgr.SendTo(clientID, msg)
			}
			cp.accumPos = 0
		}
	}
}

// broadcastFftFrame encodes and sends an FFT frame to all subscribed clients,
// using each client's preferred codecPkg. Encoding is done lazily per codec type.
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
				adpcmMsg = ws.PackFFTAdpcmMessage(codecPkg.EncodeFftAdpcm(fftFrame, minDb, maxDb))
			}
			msg = adpcmMsg
		default: // "none" or empty
			if uint8Msg == nil {
				uint8Msg = ws.PackFFTCompressedMessage(codecPkg.CompressFft(fftFrame, minDb, maxDb), int16(minDb), int16(maxDb))
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
		m.handleRequestHistory(clientID)
	case "mute", "volume":
		// Client-side only — acknowledged but no server action needed
	case "set_pre_filter_nb":
		m.handleSetPreFilterNb(clientID, cmd)
	case "set_pre_filter_nb_threshold":
		m.handleSetPreFilterNbThreshold(clientID, cmd)
	case "identify_start":
		m.handleIdentifyStart(clientID)
	}
}

// issueIdentifyTokenFunc is set by main.go to api.IssueIdentifyToken.
// Using a function var avoids a circular import between dongle and api packages.
// Signature: (connClientID, persistentID string, pcmSnapshot []float32) -> IssueResult
var issueIdentifyTokenFunc func(connClientID, persistentID string, pcmSnapshot []float32) struct {
	Token string
	Err   string
}

// handleIdentifyStart issues a one-time recognition token for the client.
// The server-side PCM ring buffer is snapshotted immediately (at button-press time)
// so the recognition uses the audio the user was hearing, not whatever fills the
// ring buffer after the WS+HTTP round-trip completes.
// On success, sends the token back via WS. On failure (pending / rate limit),
// sends a toast error message so the client can display it.
func (m *Manager) handleIdentifyStart(clientID string) {
	if issueIdentifyTokenFunc == nil {
		return // recognition not wired
	}
	client := m.wsMgr.GetClient(clientID)
	persistentID := clientID // fallback: use connection ID
	if client != nil && client.PersistentID != "" {
		persistentID = client.PersistentID
	}

	// Snapshot the PCM ring buffer now, at the moment the user pressed Identify.
	// CapturePCMForClient returns nil for non-Opus clients; that's fine — those
	// clients will upload a WAV file with the POST instead.
	// 10 seconds matches identifyCaptureSecs in the api package.
	pcmSnapshot := m.CapturePCMForClient(clientID, 10)

	result := issueIdentifyTokenFunc(clientID, persistentID, pcmSnapshot)
	if result.Err != "" {
		// Send toast error back to this client only
		m.wsMgr.SendTo(clientID, ws.PackMetaMessage(&ws.ServerMeta{
			Type:    "toast",
			Message: result.Err,
			Code:    "identify_rate_limit",
		}))
		return
	}
	m.wsMgr.SendTo(clientID, ws.PackMetaMessage(&ws.ServerMeta{
		Type:    "identify_token",
		Message: result.Token,
	}))
}

// SetIssueIdentifyTokenFunc wires the token issuance function (called by main.go).
func (m *Manager) SetIssueIdentifyTokenFunc(fn func(connClientID, persistentID string, pcmSnapshot []float32) struct {
	Token string
	Err   string
}) {
	issueIdentifyTokenFunc = fn
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

// handleRequestHistory sends buffered FFT history frames to the requesting client.
func (m *Manager) handleRequestHistory(clientID string) {
	client := m.wsMgr.GetClient(clientID)
	if client == nil {
		return
	}

	m.mu.Lock()
	d, ok := m.dongles[client.DongleID]
	m.mu.Unlock()
	if !ok || d.fftHistory == nil {
		return
	}

	frames := d.fftHistory.GetRange()
	if len(frames) == 0 {
		return
	}

	binCount := len(frames[0])
	minDb := int16(-130)
	maxDb := int16(0)
	dbRange := float32(maxDb - minDb)

	// Determine history bin count from config (may downsample)
	historyBins := m.cfg.Server.FftHistoryFftSize
	if historyBins <= 0 || historyBins >= binCount {
		historyBins = binCount // no downsampling needed
	}

	// Quantize all frames to uint8, with optional downsampling.
	// Guard: skip any frame whose length differs from binCount — this can happen
	// during a race between profile switch (which resets history) and a concurrent
	// Push of the first new frame, or if GetRange races with Reset.
	frameCount := len(frames)
	allBins := make([]byte, frameCount*historyBins)
	for i, frame := range frames {
		if len(frame) != binCount {
			// Mixed-size frame from a profile switch — skip (leave row zeroed).
			continue
		}
		if historyBins == binCount {
			// No downsampling — direct quantize
			for j, val := range frame {
				normalized := (val - float32(minDb)) / dbRange
				if normalized < 0 {
					normalized = 0
				} else if normalized > 1 {
					normalized = 1
				}
				allBins[i*historyBins+j] = byte(normalized * 255)
			}
		} else {
			// Downsample: each history bin = max of mapped source bins
			ratio := float64(binCount) / float64(historyBins)
			for j := 0; j < historyBins; j++ {
				lo := int(float64(j) * ratio)
				hi := int(float64(j+1) * ratio)
				if hi > binCount {
					hi = binCount
				}
				maxVal := frame[lo]
				for k := lo + 1; k < hi; k++ {
					if frame[k] > maxVal {
						maxVal = frame[k]
					}
				}
				normalized := (maxVal - float32(minDb)) / dbRange
				if normalized < 0 {
					normalized = 0
				} else if normalized > 1 {
					normalized = 1
				}
				allBins[i*historyBins+j] = byte(normalized * 255)
			}
		}
	}

	// Apply compression based on config
	compression := m.cfg.Server.FftHistoryCompression
	if compression == "" {
		compression = "deflate"
	}

	var codec byte
	var payload []byte

	switch compression {
	case "deflate":
		codec = 1
		// Delta-encode the entire flat uint8 array, then deflate
		total := len(allBins)
		delta := make([]byte, total)
		delta[0] = allBins[0]
		for i := 1; i < total; i++ {
			delta[i] = allBins[i] - allBins[i-1]
		}
		var buf bytes.Buffer
		w, _ := flate.NewWriter(&buf, 6)
		w.Write(delta)
		w.Close()
		payload = buf.Bytes()
	case "adpcm":
		codec = 2
		// Convert uint8 back to float32 for ADPCM encoder
		total := len(allBins)
		float32Buf := make([]float32, total)
		for i, b := range allBins {
			float32Buf[i] = float32(minDb) + (float32(b)/255)*dbRange
		}
		payload = codecPkg.EncodeFftAdpcm(float32Buf, float32(minDb), float32(maxDb))
	default: // "none"
		codec = 0
		payload = allBins
	}

	// Pack: [type][Uint16 frames][Uint32 bins][Int16 min][Int16 max][Uint8 codec][data]
	header := make([]byte, 1+2+4+2+2+1)
	header[0] = ws.MsgFFTHistory
	binary.LittleEndian.PutUint16(header[1:3], uint16(frameCount))
	binary.LittleEndian.PutUint32(header[3:7], uint32(historyBins))
	binary.LittleEndian.PutUint16(header[7:9], uint16(minDb))
	binary.LittleEndian.PutUint16(header[9:11], uint16(maxDb))
	header[11] = codec

	msg := make([]byte, len(header)+len(payload))
	copy(msg, header)
	copy(msg[len(header):], payload)

	m.wsMgr.SendTo(clientID, msg)
}

// handleSetPreFilterNb toggles the per-client pre-filter noise blanker.
func (m *Manager) handleSetPreFilterNb(clientID string, cmd *ws.ClientCommand) {
	m.mu.Lock()
	if cp, ok := m.clientPipelines[clientID]; ok {
		if cmd.Enabled != nil {
			cp.nbEnabled = *cmd.Enabled
			cp.extractor.SetNbEnabled(*cmd.Enabled)
		}
	}
	m.mu.Unlock()
}

// handleSetPreFilterNbThreshold sets the noise blanker threshold multiplier.
func (m *Manager) handleSetPreFilterNbThreshold(clientID string, cmd *ws.ClientCommand) {
	m.mu.Lock()
	if cp, ok := m.clientPipelines[clientID]; ok {
		if cmd.Level > 0 {
			cp.nbThreshold = float32(cmd.Level)
			cp.extractor.SetNbThreshold(float32(cmd.Level))
		}
	}
	m.mu.Unlock()
}

// handleUnsubscribe removes a client's subscription.
func (m *Manager) handleUnsubscribe(clientID string) {
	client := m.wsMgr.GetClient(clientID)
	if client == nil {
		return
	}
	client.DongleID = ""
	// Remove the pipeline from the map so the hot path won't pick it up in
	// future snapshots, then close it outside the map lock.
	m.mu.Lock()
	cp, ok := m.clientPipelines[clientID]
	if ok {
		delete(m.clientPipelines, clientID)
	}
	m.mu.Unlock()

	if ok && cp != nil {
		// Swap opusPipeline to nil under pmu so any concurrent Process() call
		// that grabbed the pointer from a previous snapshot finishes safely,
		// but future callers see nil.
		cp.pmu.Lock()
		pipeline := cp.opusPipeline
		cp.opusPipeline = nil
		cp.pmu.Unlock()
		if pipeline != nil {
			pipeline.Close()
		}
	}
}

// handleStereoEnabled toggles stereo encoding in the Opus pipeline.
func (m *Manager) handleStereoEnabled(clientID string, cmd *ws.ClientCommand) {
	if cmd.Enabled == nil {
		return
	}
	m.mu.Lock()
	cp, ok := m.clientPipelines[clientID]
	m.mu.Unlock()
	if !ok {
		return
	}
	// Persist preference so it is applied if the Opus pipeline is recreated later
	// (e.g., on codec switch). This prevents the "first packet is stereo" race where
	// the pipeline is created with stereoEnabled=true before stereo_enabled=false arrives.
	cp.stereoEnabled = *cmd.Enabled
	// pmu guards opusPipeline against concurrent Process() calls in the hot path.
	cp.pmu.Lock()
	if cp.opusPipeline != nil {
		cp.opusPipeline.SetStereo(*cmd.Enabled)
	}
	cp.pmu.Unlock()
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

	// Update client state with the active profile ID
	m.wsMgr.SetClientProfileID(clientID, profile.ID)

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
// Mirrors Node.js behaviour: resets filter state + accumulator on retune to
// avoid IIR transients and stale ADPCM predictor state bleeding into the new
// frequency.
func (m *Manager) handleTune(clientID string, cmd *ws.ClientCommand) {
	m.mu.Lock()
	cp, ok := m.clientPipelines[clientID]
	m.mu.Unlock()

	if ok && cp.extractor != nil {
		cp.extractor.SetTuneOffset(cmd.Offset)
		// Reset IIR filter state — old state from the previous frequency will
		// produce a transient glitch at the new centre frequency.
		cp.extractor.Reset()
		// Reset accumulator and ADPCM encoder so the 20ms chunk boundary is
		// clean and the differential predictor starts from a known state.
		cp.accumPos = 0
		if cp.adpcmEnc != nil {
			cp.adpcmEnc.Reset()
		}
		m.logger.Debug("client tune offset updated", "clientID", clientID, "offset", cmd.Offset)
	}
}

// handleBandwidth stores the client's audio filter bandwidth and forwards it
// to the Opus pipeline demodulator for audio LPF control.
// NOTE: bandwidth is the audio/RF filter width in Hz — it does NOT change the
// IQ extractor sample rate (that is controlled solely by mode via handleMode).
func (m *Manager) handleBandwidth(clientID string, cmd *ws.ClientCommand) {
	m.mu.Lock()
	cp, ok := m.clientPipelines[clientID]
	m.mu.Unlock()

	if !ok || cp.extractor == nil {
		return
	}

	// Forward bandwidth to Opus pipeline demodulator if active.
	cp.pmu.Lock()
	if cp.opusPipeline != nil {
		cp.opusPipeline.SetBandwidth(cmd.Hz)
	}
	cp.pmu.Unlock()

	m.logger.Debug("client bandwidth updated", "clientID", clientID, "hz", cmd.Hz)
}

// handleMode updates output rate based on demodulation mode.
func (m *Manager) handleMode(clientID string, cmd *ws.ClientCommand) {
	m.mu.Lock()
	cp, ok := m.clientPipelines[clientID]
	m.mu.Unlock()

	if ok && cp.extractor != nil {
		// Always use mode-based rate (same IQ for both IQ-codec and Opus paths)
		rate := outputRateForMode(cmd.Mode)
		cp.extractor.SetOutputSampleRate(rate)
		m.updateChunkSize(cp)

		// Update opus pipeline demodulator if active.
		// pmu guards opusPipeline against concurrent hot-path reads.
		cp.pmu.Lock()
		if cp.opusPipeline != nil {
			// UpdateSampleRate recalculates decimFactor and upsampleRatio
			// internally — do not manually override them afterwards.
			cp.opusPipeline.UpdateSampleRate(rate)
			if err := cp.opusPipeline.SetMode(cmd.Mode); err != nil {
				m.logger.Error("failed to set opus pipeline mode",
					"clientID", clientID, "mode", cmd.Mode, "error", err)
			}
		}
		cp.pmu.Unlock()

		// Reset accumulator on mode change
		cp.accumPos = 0
		if cp.adpcmEnc != nil {
			cp.adpcmEnc.Reset()
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

	isOldOpus := oldCodec == "opus" || oldCodec == "opus-hq" || oldCodec == "opus-lo"
	isNewOpus := newCodec == "opus" || newCodec == "opus-hq" || newCodec == "opus-lo"

	if !isOldOpus && isNewOpus {
		// Switching from IQ to Opus: create OpusPipeline
		// IQ extractor stays at its current rate — Opus pipeline handles rate internally
		client := m.wsMgr.GetClient(clientID)
		mode := ""
		if client != nil {
			mode = client.Mode
		}
		if mode == "" {
			// Fall back to the profile default, not a hard-coded "nfm".
			// This matches createClientPipeline() behaviour and ensures WFM profiles
			// get the correct demodulator when the user switches codec without ever
			// sending a mode command.
			m.mu.Lock()
			if d, ok := m.dongles[cp.dongleID]; ok {
				mode = d.profile.Mode
			}
			m.mu.Unlock()
		}
		if mode == "" {
			mode = "nfm" // ultimate fallback if dongle is gone
		}

		pipeline, err := NewOpusPipeline(OpusPipelineConfig{
			Mode:          mode,
			SampleRate:    cp.extractor.OutputSampleRate(),
			Quality:       newCodec,
			StereoEnabled: &cp.stereoEnabled,
			Complexity:    m.opusComplexity(),
		})
		if err != nil {
			m.logger.Error("failed to create opus pipeline on codec switch",
				"clientID", clientID, "error", err)
			return
		}

		// Reset the extractor to clear any stale IIR state before feeding Opus pipeline.
		cp.extractor.Reset()

		cp.pmu.Lock()
		cp.opusPipeline = pipeline
		cp.iqCodec = newCodec
		cp.pmu.Unlock()

		m.logger.Info("switched to opus pipeline", "clientID", clientID, "codec", newCodec)

	} else if isOldOpus && !isNewOpus {
		// Switching from Opus to IQ (none/adpcm): destroy OpusPipeline
		// IQ extractor rate is unchanged — it's always mode-based
		cp.pmu.Lock()
		old := cp.opusPipeline
		cp.opusPipeline = nil
		cp.iqCodec = newCodec
		cp.pmu.Unlock()
		if old != nil {
			old.Close()
		}
		cp.adpcmEnc.Reset()
		cp.accumPos = 0

		m.logger.Info("switched from opus to IQ codec", "clientID", clientID, "codec", newCodec)

	} else if isOldOpus && isNewOpus && oldCodec != newCodec {
		// Switching between opus and opus-hq: just update bitrate
		cp.pmu.Lock()
		if cp.opusPipeline != nil {
			channels := cp.opusPipeline.Channels()
			newBitrate := bitrateForQuality(newCodec, channels)
			if err := cp.opusPipeline.encoder.SetBitrate(newBitrate); err != nil {
				m.logger.Error("failed to update opus bitrate",
					"clientID", clientID, "error", err)
			}
		}
		cp.iqCodec = newCodec
		cp.pmu.Unlock()

		m.logger.Info("switched opus quality", "clientID", clientID, "codec", newCodec)

	} else {
		// Switching between none and adpcm (both non-opus)
		m.mu.Lock()
		cp.iqCodec = newCodec
		m.mu.Unlock()
		cp.adpcmEnc.Reset()
		cp.accumPos = 0

		m.logger.Info("switched IQ codec", "clientID", clientID, "from", oldCodec, "to", newCodec)
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

	// Determine output rate from client mode (same regardless of IQ codec)
	mode := client.Mode
	if mode == "" {
		mode = d.profile.Mode
	}
	outputRate := outputRateForMode(mode)

	// IQ codec determination
	iqCodec := client.IqCodec
	if iqCodec == "" {
		iqCodec = "none"
	}

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
		DCOffsetRemoval:  d.profile.DCOffsetRemoval == nil || *d.profile.DCOffsetRemoval,
		Logger:           m.logger.With("clientID", clientID),
	})
	if err != nil {
		m.logger.Error("failed to create IQ extractor",
			"clientID", clientID, "error", err)
		return
	}

	// 20ms chunk size: outputRate * 2 channels * 0.020 seconds
	chunkSize := int(float64(ext.OutputSampleRate()) * 2.0 * 0.020)

	cp := &clientPipeline{
		extractor:     ext,
		adpcmEnc:      codecPkg.NewImaAdpcmEncoder(),
		accumBuf:      make([]int16, chunkSize),
		accumPos:      0,
		chunkSize:     chunkSize,
		iqCodec:       iqCodec,
		dongleID:      dongleID,
		nbEnabled:     false,
		nbThreshold:   10.0,
		stereoEnabled: client.StereoEnabled,
	}

	// Apply profile-level NB defaults to the extractor
	if d.profile.PreFilterNb {
		cp.nbEnabled = true
		cp.extractor.SetNbEnabled(true)
	}
	if d.profile.PreFilterNbThreshold > 0 {
		cp.nbThreshold = float32(d.profile.PreFilterNbThreshold)
		cp.extractor.SetNbThreshold(float32(d.profile.PreFilterNbThreshold))
	}

	// Create Opus pipeline if codec is opus, opus-hq, or opus-lo
	if iqCodec == "opus" || iqCodec == "opus-hq" || iqCodec == "opus-lo" {
		pipeline, err := NewOpusPipeline(OpusPipelineConfig{
			Mode:          mode,
			SampleRate:    outputRate, // same as IQ extractor output (mode-based: WFM=240k, NFM=48k)
			Quality:       iqCodec,
			StereoEnabled: &cp.stereoEnabled,
			Complexity:    m.opusComplexity(),
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

	if ok && cp != nil {
		// Swap opusPipeline to nil under pmu before closing (mirrors handleUnsubscribe).
		cp.pmu.Lock()
		pipeline := cp.opusPipeline
		cp.opusPipeline = nil
		cp.pmu.Unlock()
		if pipeline != nil {
			pipeline.Close()
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

// CapturePCMForClient returns the last `secs` seconds of decoded mono 48kHz Float32 audio
// from the Opus pipeline of the given client, or nil if the client is not on the Opus path.
// Used by the music recognition endpoint.
func (m *Manager) CapturePCMForClient(clientID string, secs int) []float32 {
	m.mu.Lock()
	cp, ok := m.clientPipelines[clientID]
	m.mu.Unlock()
	if !ok {
		return nil
	}
	cp.pmu.Lock()
	opus := cp.opusPipeline
	cp.pmu.Unlock()
	if opus == nil {
		return nil
	}
	return opus.CapturePCM(secs)
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
