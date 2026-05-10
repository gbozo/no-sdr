package api

import (
	_ "embed"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

// Embedded fallback band plans (always shipped with binary).
//
//go:embed bands/bands.json
var embeddedBands []byte

//go:embed bands/bands-r1.json
var embeddedBandsR1 []byte

//go:embed bands/bands-r2.json
var embeddedBandsR2 []byte

//go:embed bands/bands-r3.json
var embeddedBandsR3 []byte

// upstream URLs for weekly refresh (OpenWebRX GitHub raw content).
const (
	bandsURL   = "https://raw.githubusercontent.com/jketterl/openwebrx/master/htdocs/static/bands/bands.json"
	bandsR1URL = "https://raw.githubusercontent.com/jketterl/openwebrx/master/htdocs/static/bands/bands-r1.json"
	bandsR2URL = "https://raw.githubusercontent.com/jketterl/openwebrx/master/htdocs/static/bands/bands-r2.json"
	bandsR3URL = "https://raw.githubusercontent.com/jketterl/openwebrx/master/htdocs/static/bands/bands-r3.json"
)

// BandEntry is a single frequency band allocation entry.
type BandEntry struct {
	Name        string         `json:"name"`
	LowerBound  int64          `json:"lower_bound"`
	UpperBound  int64          `json:"upper_bound"`
	Frequencies map[string]any `json:"frequencies,omitempty"`
	Tags        []string       `json:"tags,omitempty"`
}

// BandPlanService holds cached band plans and performs weekly background refresh.
type BandPlanService struct {
	mu        sync.RWMutex
	plans     map[string][]BandEntry // keyed by "" | "r1" | "r2" | "r3"
	lastFetch time.Time
	logger    *slog.Logger
}

// NewBandPlanService creates a service pre-loaded with the embedded fallback data.
func NewBandPlanService(logger *slog.Logger) *BandPlanService {
	svc := &BandPlanService{logger: logger}
	svc.plans = map[string][]BandEntry{
		"":   mustParse(embeddedBands),
		"r1": mustParse(embeddedBandsR1),
		"r2": mustParse(embeddedBandsR2),
		"r3": mustParse(embeddedBandsR3),
	}
	return svc
}

// StartScheduler launches the weekly background refresh goroutine.
// It performs an immediate first fetch, then repeats every 7 days.
func (s *BandPlanService) StartScheduler() {
	go func() {
		// First fetch shortly after startup (30s delay so server is fully up).
		time.Sleep(30 * time.Second)
		s.refresh()

		ticker := time.NewTicker(7 * 24 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			s.refresh()
		}
	}()
}

// refresh fetches all four JSON files from upstream and updates the cache.
// On any error it logs and keeps the previous (embedded or last-fetched) data.
func (s *BandPlanService) refresh() {
	s.logger.Info("bandplan: starting weekly refresh from upstream")

	fetches := []struct {
		key string
		url string
	}{
		{"", bandsURL},
		{"r1", bandsR1URL},
		{"r2", bandsR2URL},
		{"r3", bandsR3URL},
	}

	newPlans := make(map[string][]BandEntry, 4)
	for _, f := range fetches {
		entries, err := fetchBands(f.url)
		if err != nil {
			s.logger.Error("bandplan: fetch failed — keeping existing data",
				"key", f.key, "url", f.url, "error", err)
			// Keep existing data for all keys and abort.
			return
		}
		newPlans[f.key] = entries
	}

	s.mu.Lock()
	s.plans = newPlans
	s.lastFetch = time.Now()
	s.mu.Unlock()

	total := 0
	for _, v := range newPlans {
		total += len(v)
	}
	s.logger.Info("bandplan: refresh complete", "entries", total)
}

// Handler returns an http.HandlerFunc for GET /api/bandplan.
// Optional query param: ?region=r1|r2|r3  (omit for global/generic).
func (s *BandPlanService) Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		region := r.URL.Query().Get("region") // "", "r1", "r2", "r3"

		s.mu.RLock()
		entries, ok := s.plans[region]
		lastFetch := s.lastFetch
		s.mu.RUnlock()

		if !ok {
			// Unknown region — fall back to generic.
			s.mu.RLock()
			entries = s.plans[""]
			s.mu.RUnlock()
		}

		resp := map[string]any{
			"region":  region,
			"bands":   entries,
			"updated": lastFetch, // zero value if still on embedded fallback
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// mustParse parses embedded JSON; panics on invalid data (caught at startup).
func mustParse(data []byte) []BandEntry {
	var entries []BandEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		panic("bandplan: failed to parse embedded bands JSON: " + err.Error())
	}
	return entries
}

// fetchBands GETs a URL and decodes the JSON array of BandEntry.
func fetchBands(url string) ([]BandEntry, error) {
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20)) // 1 MB limit
	if err != nil {
		return nil, err
	}

	var entries []BandEntry
	if err := json.Unmarshal(body, &entries); err != nil {
		return nil, err
	}
	return entries, nil
}
