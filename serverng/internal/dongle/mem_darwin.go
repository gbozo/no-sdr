//go:build darwin

package dongle

import "syscall"

// rusageMemMB returns the process RSS in megabytes from a Rusage snapshot.
// On Darwin, Maxrss is in bytes.
func rusageMemMB(ru *syscall.Rusage) int {
	return int(ru.Maxrss / 1_048_576)
}
