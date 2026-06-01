//go:build !production

package api

import "io/fs"

func getEmbeddedDist() fs.FS {
	return nil
}
