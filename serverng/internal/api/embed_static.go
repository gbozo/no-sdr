//go:build production

package api

import (
	"embed"
	"io/fs"
)

//go:embed static/dist
var staticDist embed.FS

func getEmbeddedDist() fs.FS {
	sub, err := fs.Sub(staticDist, "static/dist")
	if err != nil {
		return nil
	}
	return sub
}
