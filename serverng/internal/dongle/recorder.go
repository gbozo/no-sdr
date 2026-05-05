package dongle

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Recorder captures raw uint8 IQ samples from a running dongle to disk
// in SigMF format (.sigmf-data + .sigmf-meta sidecar).
type Recorder struct {
	mu        sync.Mutex
	active    map[string]*recording // dongleID → recording
	outputDir string
	logger    *slog.Logger
}

type recording struct {
	dongleID    string
	file        *os.File
	metaPath    string
	centerFreq  int64
	sampleRate  int
	startedAt   time.Time
	bytesWritten int64
}

// NewRecorder creates a recorder that saves files to outputDir.
func NewRecorder(outputDir string, logger *slog.Logger) *Recorder {
	return &Recorder{
		active:    make(map[string]*recording),
		outputDir: outputDir,
		logger:    logger,
	}
}

// Start begins recording IQ from dongle dongleID.
// Returns an error if already recording or the output file can't be created.
func (r *Recorder) Start(dongleID string, centerFreq int64, sampleRate int) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, ok := r.active[dongleID]; ok {
		return fmt.Errorf("already recording dongle %s", dongleID)
	}

	if err := os.MkdirAll(r.outputDir, 0755); err != nil {
		return fmt.Errorf("recorder: create output dir: %w", err)
	}

	ts := time.Now().UTC().Format("20060102T150405Z")
	base := fmt.Sprintf("%s_%d_%s", dongleID, centerFreq, ts)
	dataPath := filepath.Join(r.outputDir, base+".sigmf-data")
	metaPath := filepath.Join(r.outputDir, base+".sigmf-meta")

	f, err := os.Create(dataPath)
	if err != nil {
		return fmt.Errorf("recorder: create data file: %w", err)
	}

	rec := &recording{
		dongleID:   dongleID,
		file:       f,
		metaPath:   metaPath,
		centerFreq: centerFreq,
		sampleRate: sampleRate,
		startedAt:  time.Now(),
	}
	r.active[dongleID] = rec

	r.logger.Info("IQ recording started",
		"dongleID", dongleID,
		"file", dataPath,
		"centerFreq", centerFreq,
		"sampleRate", sampleRate,
	)
	return nil
}

// Stop ends recording for dongle dongleID and writes the SigMF metadata sidecar.
// Returns the base filename (without extension) on success.
func (r *Recorder) Stop(dongleID string) (string, error) {
	r.mu.Lock()
	rec, ok := r.active[dongleID]
	if !ok {
		r.mu.Unlock()
		return "", fmt.Errorf("not recording dongle %s", dongleID)
	}
	delete(r.active, dongleID)
	r.mu.Unlock()

	dataPath := rec.file.Name()
	if err := rec.file.Close(); err != nil {
		return "", fmt.Errorf("recorder: close file: %w", err)
	}

	duration := time.Since(rec.startedAt).Seconds()

	// Write SigMF metadata sidecar
	meta := sigmfMeta{
		Global: sigmfGlobal{
			Version:    "1.0.0",
			DataType:   "cu8",       // complex uint8 (RTL-SDR native format)
			SampleRate: rec.sampleRate,
			HWInfo:     fmt.Sprintf("no-sdr dongle %s", rec.dongleID),
			Recorder:   "no-sdr",
		},
		Captures: []sigmfCapture{
			{
				SampleStart: 0,
				Frequency:   rec.centerFreq,
				DateTime:    rec.startedAt.UTC().Format(time.RFC3339Nano),
			},
		},
		Annotations: []map[string]any{
			{
				"core:sample_start": 0,
				"core:comment":      fmt.Sprintf("duration=%.1fs bytes=%d", duration, rec.bytesWritten),
			},
		},
	}

	metaJSON, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return "", fmt.Errorf("recorder: marshal meta: %w", err)
	}
	if err := os.WriteFile(rec.metaPath, metaJSON, 0644); err != nil {
		return "", fmt.Errorf("recorder: write meta: %w", err)
	}

	r.logger.Info("IQ recording stopped",
		"dongleID", dongleID,
		"file", dataPath,
		"bytes", rec.bytesWritten,
		"duration", fmt.Sprintf("%.1fs", duration),
	)

	return dataPath, nil
}

// WriteIQ appends a chunk of raw IQ bytes to the active recording for dongleID.
// No-ops if no recording is active for this dongle.
func (r *Recorder) WriteIQ(dongleID string, chunk []byte) {
	r.mu.Lock()
	rec, ok := r.active[dongleID]
	r.mu.Unlock()
	if !ok {
		return
	}
	n, _ := rec.file.Write(chunk)
	r.mu.Lock()
	rec.bytesWritten += int64(n)
	r.mu.Unlock()
}

// Status returns a snapshot of all active recordings.
func (r *Recorder) Status() []RecordingStatus {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]RecordingStatus, 0, len(r.active))
	for _, rec := range r.active {
		out = append(out, RecordingStatus{
			DongleID:     rec.dongleID,
			File:         rec.file.Name(),
			BytesWritten: rec.bytesWritten,
			Duration:     time.Since(rec.startedAt).Seconds(),
		})
	}
	return out
}

// IsRecording returns true if the dongle is currently being recorded.
func (r *Recorder) IsRecording(dongleID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.active[dongleID]
	return ok
}

// RecordingStatus is returned by Status().
type RecordingStatus struct {
	DongleID     string  `json:"dongleId"`
	File         string  `json:"file"`
	BytesWritten int64   `json:"bytesWritten"`
	Duration     float64 `json:"durationSec"`
}

// ---- SigMF metadata structs ----

type sigmfMeta struct {
	Global      sigmfGlobal       `json:"global"`
	Captures    []sigmfCapture    `json:"captures"`
	Annotations []map[string]any  `json:"annotations"`
}

type sigmfGlobal struct {
	Version    string `json:"core:version"`
	DataType   string `json:"core:datatype"`   // "cu8" = complex uint8
	SampleRate int    `json:"core:sample_rate"`
	HWInfo     string `json:"core:hw,omitempty"`
	Recorder   string `json:"core:recorder,omitempty"`
}

type sigmfCapture struct {
	SampleStart int64  `json:"core:sample_start"`
	Frequency   int64  `json:"core:frequency"`
	DateTime    string `json:"core:datetime,omitempty"`
}
