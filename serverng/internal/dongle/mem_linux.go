//go:build linux

package dongle

import "syscall"

// rusageMemMB returns the process RSS in megabytes from a Rusage snapshot.
// On Linux, Maxrss is in kilobytes.
func rusageMemMB(ru *syscall.Rusage) int {
	return int(ru.Maxrss / 1024)
}
