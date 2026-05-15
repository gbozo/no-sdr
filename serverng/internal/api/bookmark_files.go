package api

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// implementedModes lists the demodulation modes the client can actually handle.
var implementedModes = map[string]bool{
	"wfm":       true,
	"nfm":       true,
	"am":        true,
	"am-stereo": true,
	"sam":       true,
	"usb":       true,
	"lsb":       true,
	"cw":        true,
	"raw":       true,
}

// modulationToMode maps OpenWebRX-style modulation names to our DemodMode strings.
var modulationToMode = map[string]string{
	"fm":      "wfm",
	"wfm":     "wfm",
	"nfm":     "nfm",
	"am":      "am",
	"usb":     "usb",
	"lsb":     "lsb",
	"cw":      "cw",
	"sam":     "sam",
	// digital / unsupported — kept as-is for tooltip display
	"acars":   "acars",
	"dsc":     "dsc",
	"fax":     "fax",
	"wfax":    "fax",
	"hfdl":    "hfdl",
	"rtty450": "rtty450",
	"sitorb":  "sitorb",
	"vdl2":    "vdl2",
}

// fileBookmarkRaw is the shape of a single entry in the JSON bookmark files.
type fileBookmarkRaw struct {
	Name        string `json:"name"`
	Frequency   int64  `json:"frequency"`
	Modulation  string `json:"modulation"`
	Description string `json:"description"`
	Bandwidth   int    `json:"bandwidth"`
}

// PublicBookmark is the response shape for the public /api/bookmarks endpoint.
// It extends config.Bookmark with source + implemented flags.
type PublicBookmark struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Frequency   int64  `json:"frequency"`
	Mode        string `json:"mode"`
	Bandwidth   int    `json:"bandwidth,omitempty"`
	Description string `json:"description,omitempty"`
	// Source distinguishes where this bookmark came from.
	// "config" = config.yaml, "file" = bookmarks directory file.
	Source string `json:"source"`
	// Implemented indicates whether the client can actually demodulate this mode.
	Implemented bool `json:"implemented"`
}

// stableID generates a deterministic ID for a file-sourced bookmark so that
// IDs are stable across server restarts without requiring a stored UUID.
// Format: file-<sha256-6chars-of-"path:name:freq">
func stableID(filePath, name string, frequency int64) string {
	h := sha256.Sum256([]byte(fmt.Sprintf("%s:%s:%d", filePath, name, frequency)))
	return fmt.Sprintf("file-%x", h[:3])
}

// LoadFileBookmarks walks the given directory recursively and loads all
// .json files as bookmark lists. Unknown modulations are preserved so the
// client can display them in the tooltip.
func LoadFileBookmarks(dir string) ([]PublicBookmark, error) {
	var result []PublicBookmark

	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable entries
		}
		if d.IsDir() || !strings.EqualFold(filepath.Ext(path), ".json") {
			return nil
		}

		data, err := os.ReadFile(path)
		if err != nil {
			return nil // skip unreadable files
		}

		var raw []fileBookmarkRaw
		if err := json.Unmarshal(data, &raw); err != nil {
			return nil // skip malformed files
		}

		// Use a relative path for ID generation to stay path-independent.
		rel, _ := filepath.Rel(dir, path)

		for _, r := range raw {
			if r.Name == "" || r.Frequency <= 0 {
				continue
			}
			mod := strings.ToLower(strings.TrimSpace(r.Modulation))
			mode, ok := modulationToMode[mod]
			if !ok {
				// Preserve unknown mode as-is for tooltip display.
				mode = mod
			}
			result = append(result, PublicBookmark{
				ID:          stableID(rel, r.Name, r.Frequency),
				Name:        r.Name,
				Frequency:   r.Frequency,
				Mode:        mode,
				Bandwidth:   r.Bandwidth,
				Description: r.Description,
				Source:      "file",
				Implemented: implementedModes[mode],
			})
		}
		return nil
	})

	return result, err
}
