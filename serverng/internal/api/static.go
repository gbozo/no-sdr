package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// SPAHandler serves static files with SPA fallback.
// For paths that don't match an existing file, it serves index.html.
func SPAHandler(staticDir string) http.HandlerFunc {
	fs := http.Dir(staticDir)

	return func(w http.ResponseWriter, r *http.Request) {
		// Clean the path
		path := r.URL.Path
		if !strings.HasPrefix(path, "/") {
			path = "/" + path
		}

		// Check if the file exists
		fullPath := filepath.Join(staticDir, filepath.Clean(path))
		info, err := os.Stat(fullPath)
		if err != nil || info.IsDir() {
			// File doesn't exist or is a directory — serve index.html (SPA fallback)
			http.ServeFile(w, r, filepath.Join(staticDir, "index.html"))
			return
		}

		// File exists — serve it directly
		http.FileServer(fs).ServeHTTP(w, r)
	}
}
