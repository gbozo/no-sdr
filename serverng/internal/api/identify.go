package api

import (
	"crypto/rand"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"sync"
	"time"

	"github.com/gbozo/no-sdr/serverng/internal/config"
)

// GetOpusPCMFunc is set by main.go to the dongle manager's PCM capture function.
// It returns the last `secs` seconds of decoded mono PCM for a given clientID,
// or nil if the client is not on the Opus codec path.
var GetOpusPCMFunc func(clientID string, secs int) []float32

// ---- One-time identify token store ----

const (
	identifyTokenTTL    = 20 * time.Second
	identifyRateWindow  = 60 * time.Second
	identifyRateMax     = 3 // max tokens per persistentID per minute
)

// identifyTokenRecord holds all state for a single issued token.
type identifyTokenRecord struct {
	connClientID string    // internal WS connection ID (changes on reconnect)
	persistentID string    // stable client UUID (from localStorage)
	expiresAt    time.Time
}

// identifyClientState tracks per-persistent-client rate and pending token state.
type identifyClientState struct {
	pendingToken string      // currently active (unconsumed) token, "" if none
	issuedAt     []time.Time // timestamps of tokens issued in the last identifyRateWindow
}

// IssueResult is returned by IssueIdentifyToken.
type IssueResult struct {
	Token string // non-empty on success
	Err   string // human-readable error for the client toast, empty on success
}

var (
	identifyMu       sync.Mutex
	identifyTokenMap = map[string]*identifyTokenRecord{} // token → record
	identifyClients  = map[string]*identifyClientState{} // persistentID → state
)

// IssueIdentifyToken creates a one-time recognition token for a client.
//
// Rules (all enforced atomically):
//  1. If the client already has an unconsumed pending token → reject (must consume first).
//  2. If the client has issued ≥ identifyRateMax tokens in the last identifyRateWindow → reject.
//  3. Otherwise issue a new UUID token tied to this connection.
//
// Returns IssueResult with Token set on success or Err set on failure.
func IssueIdentifyToken(connClientID, persistentID string) IssueResult {
	identifyMu.Lock()
	defer identifyMu.Unlock()

	now := time.Now()

	// Purge globally expired tokens
	for k, v := range identifyTokenMap {
		if now.After(v.expiresAt) {
			// Also clear pending flag if this was the client's pending token
			if cs, ok := identifyClients[v.persistentID]; ok && cs.pendingToken == k {
				cs.pendingToken = ""
			}
			delete(identifyTokenMap, k)
		}
	}

	// Ensure client state exists
	cs, ok := identifyClients[persistentID]
	if !ok {
		cs = &identifyClientState{}
		identifyClients[persistentID] = cs
	}

	// Rule 1: pending token still active for this client?
	if cs.pendingToken != "" {
		if rec, exists := identifyTokenMap[cs.pendingToken]; exists && now.Before(rec.expiresAt) {
			return IssueResult{Err: "a recognition request is already pending — please wait for it to complete or expire"}
		}
		cs.pendingToken = "" // stale reference, clear it
	}

	// Rule 2: rate limit — count tokens issued within the rate window
	cutoff := now.Add(-identifyRateWindow)
	valid := cs.issuedAt[:0]
	for _, t := range cs.issuedAt {
		if t.After(cutoff) {
			valid = append(valid, t)
		}
	}
	cs.issuedAt = valid
	if len(cs.issuedAt) >= identifyRateMax {
		oldest := cs.issuedAt[0]
		retryIn := int(identifyRateWindow.Seconds()) - int(now.Sub(oldest).Seconds())
		if retryIn < 1 {
			retryIn = 1
		}
		return IssueResult{Err: fmt.Sprintf("rate limit reached — max %d recognitions per minute, retry in %ds", identifyRateMax, retryIn)}
	}

	// Issue token
	token := generateUUID()
	identifyTokenMap[token] = &identifyTokenRecord{
		connClientID: connClientID,
		persistentID: persistentID,
		expiresAt:    now.Add(identifyTokenTTL),
	}
	cs.pendingToken = token
	cs.issuedAt = append(cs.issuedAt, now)

	return IssueResult{Token: token}
}

// consumeIdentifyToken validates and single-use-consumes a token.
// Returns the connection clientID it was issued for, or an error.
func consumeIdentifyToken(token string) (string, error) {
	identifyMu.Lock()
	defer identifyMu.Unlock()

	rec, ok := identifyTokenMap[token]
	if !ok {
		return "", fmt.Errorf("invalid or already used token")
	}
	if time.Now().After(rec.expiresAt) {
		delete(identifyTokenMap, token)
		return "", fmt.Errorf("token expired")
	}
	connClientID := rec.connClientID

	// Clear pending flag on the client state
	if cs, exists := identifyClients[rec.persistentID]; exists && cs.pendingToken == token {
		cs.pendingToken = ""
	}
	delete(identifyTokenMap, token) // single-use
	return connClientID, nil
}

// generateUUID produces a random UUID v4 using crypto/rand.
func generateUUID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// ---- HTTP handlers ----

// identifyHandler handles music recognition requests.
//
// POST /api/identify (multipart/form-data)
//   - token: one-time UUID issued by IssueIdentifyToken (required)
//   - file:  WAV audio blob from the client (optional — Opus path uses server-side PCM capture)
func identifyHandler(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 8<<20)
		if err := r.ParseMultipartForm(8 << 20); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid multipart body"})
			return
		}

		token := r.FormValue("token")
		if token == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "token required"})
			return
		}

		// Validate and consume token — single-use, 20s TTL
		connClientID, err := consumeIdentifyToken(token)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
			return
		}

		rcfg := RecognizerConfig{
			AuddAPIKey:           cfg.Server.AuddAPIKey,
			ACRCloudHost:         cfg.Server.ACRCloudHost,
			ACRCloudAccessKey:    cfg.Server.ACRCloudAccessKey,
			ACRCloudAccessSecret: cfg.Server.ACRCloudAccessSecret,
		}

		var wav []byte

		// Check if a WAV file was uploaded (ADPCM/none codec path)
		var fileHeader *multipart.FileHeader
		if r.MultipartForm != nil && r.MultipartForm.File != nil {
			if files := r.MultipartForm.File["file"]; len(files) > 0 {
				fileHeader = files[0]
			}
		}

		if fileHeader != nil {
			f, ferr := fileHeader.Open()
			if ferr != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cannot read uploaded file"})
				return
			}
			defer f.Close()
			wav, err = io.ReadAll(f)
			if err != nil || len(wav) < 44 {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid WAV audio"})
				return
			}
		} else {
			// No file — use server-side Opus PCM capture
			if GetOpusPCMFunc == nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "PCM capture not available"})
				return
			}
			pcm := GetOpusPCMFunc(connClientID, 10)
			if len(pcm) == 0 {
				writeJSON(w, http.StatusUnprocessableEntity, map[string]string{
					"error": "no audio buffered — ensure Opus codec is active and audio has been playing",
				})
				return
			}
			wav = encodeWAV(pcm, 1, 48000)
		}

		result, err := recognizeFromWAV(rcfg, wav)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if result == nil {
			writeJSON(w, http.StatusOK, map[string]any{"match": false})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"match": true, "result": result})
	}
}

// recognizeFromWAV submits a pre-encoded WAV blob to recognition services.
func recognizeFromWAV(cfg RecognizerConfig, wav []byte) (*RecognizeResult, error) {
	if cfg.AuddAPIKey != "" {
		res, err := recognizeAudD(cfg.AuddAPIKey, wav)
		if err == nil && res != nil {
			res.Service = "audd"
			return res, nil
		}
	}
	if cfg.ACRCloudHost != "" && cfg.ACRCloudAccessKey != "" && cfg.ACRCloudAccessSecret != "" {
		res, err := recognizeACRCloud(cfg.ACRCloudHost, cfg.ACRCloudAccessKey, cfg.ACRCloudAccessSecret, wav)
		if err == nil && res != nil {
			res.Service = "acrcloud"
			return res, nil
		}
	}
	if cfg.AuddAPIKey == "" && cfg.ACRCloudHost == "" {
		return nil, fmt.Errorf("no recognition API configured (set auddApiKey or acrcloud* in config.yaml)")
	}
	return nil, nil
}

// identifyStatusHandler reports whether recognition is configured.
func identifyStatusHandler(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{
			"available": cfg.Server.AuddAPIKey != "" || cfg.Server.ACRCloudAccessKey != "",
		})
	}
}
