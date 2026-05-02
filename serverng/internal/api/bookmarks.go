package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/gbozo/no-sdr/serverng/internal/config"
)

// bookmarksHandler returns all bookmarks.
// GET /api/admin/bookmarks
func bookmarksHandler(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		bm := cfg.Bookmarks
		if bm == nil {
			bm = []config.Bookmark{}
		}
		writeJSON(w, http.StatusOK, bm)
	}
}

// createBookmarkHandler adds a new bookmark.
// POST /api/admin/bookmarks
func createBookmarkHandler(cfg *config.Config, ver *config.ConfigVersion) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var bm config.Bookmark
		if err := json.NewDecoder(r.Body).Decode(&bm); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
			return
		}
		if bm.ID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bookmark id is required"})
			return
		}
		if bm.Name == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bookmark name is required"})
			return
		}
		if bm.Frequency <= 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "frequency must be > 0"})
			return
		}

		// Check for duplicate ID
		for _, existing := range cfg.Bookmarks {
			if existing.ID == bm.ID {
				writeJSON(w, http.StatusConflict, map[string]string{"error": "bookmark with this id already exists"})
				return
			}
		}

		cfg.Bookmarks = append(cfg.Bookmarks, bm)
		newVer := bumpVersion(ver)
		setVersionHeader(w, newVer)
		writeJSON(w, http.StatusCreated, bm)
	}
}

// updateBookmarkHandler updates an existing bookmark.
// PUT /api/admin/bookmarks/{id}
func updateBookmarkHandler(cfg *config.Config, ver *config.ConfigVersion) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var updated config.Bookmark
		if err := json.NewDecoder(r.Body).Decode(&updated); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
			return
		}

		for i, bm := range cfg.Bookmarks {
			if bm.ID == id {
				updated.ID = id // Ensure ID cannot be changed
				cfg.Bookmarks[i] = updated
				newVer := bumpVersion(ver)
				setVersionHeader(w, newVer)
				writeJSON(w, http.StatusOK, updated)
				return
			}
		}
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "bookmark not found"})
	}
}

// deleteBookmarkHandler removes a bookmark.
// DELETE /api/admin/bookmarks/{id}
func deleteBookmarkHandler(cfg *config.Config, ver *config.ConfigVersion) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		for i, bm := range cfg.Bookmarks {
			if bm.ID == id {
				cfg.Bookmarks = append(cfg.Bookmarks[:i], cfg.Bookmarks[i+1:]...)
				newVer := bumpVersion(ver)
				setVersionHeader(w, newVer)
				writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
				return
			}
		}
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "bookmark not found"})
	}
}
