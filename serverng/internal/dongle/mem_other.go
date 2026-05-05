//go:build !linux && !darwin

package dongle

import "syscall"

// rusageMemMB returns the process RSS in megabytes from a Rusage snapshot.
// Fallback for other platforms — Maxrss units are not standardised.
func rusageMemMB(ru *syscall.Rusage) int {
	return int(ru.Maxrss / 1024)
}
