package api

import (
	"errors"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func init() {
	mime.AddExtensionType(".webmanifest", "application/manifest+json")
}

// SPAHandler serves static files with SPA fallback.
// In a production build (with the production build tag), files are served from
// the embedded dist directory. Otherwise, the filesystem at staticDir is used.
func SPAHandler(staticDir string) http.HandlerFunc {
	// Production build: serve from embedded dist
	if ef := getEmbeddedDist(); ef != nil {
		fsrv := http.FileServer(http.FS(ef))
		return func(w http.ResponseWriter, r *http.Request) {
			path := strings.TrimPrefix(r.URL.Path, "/")
			if _, err := ef.Open(path); errors.Is(err, fs.ErrNotExist) {
				r.URL.Path = "/"
			}
			fsrv.ServeHTTP(w, r)
		}
	}

	// Development fallback: serve from filesystem
	fsys := http.Dir(staticDir)

	return func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if !strings.HasPrefix(path, "/") {
			path = "/" + path
		}

		fullPath := filepath.Join(staticDir, filepath.Clean(path))
		info, err := os.Stat(fullPath)
		if err != nil || info.IsDir() {
			http.ServeFile(w, r, filepath.Join(staticDir, "index.html"))
			return
		}

		http.FileServer(fsys).ServeHTTP(w, r)
	}
}
