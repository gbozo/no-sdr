//go:build darwin

package dongle

import "syscall"

// getMemoryMB returns the process RSS in megabytes.
// On Darwin, Maxrss from getrusage is in bytes.
func getMemoryMB() int {
	var ru syscall.Rusage
	syscall.Getrusage(syscall.RUSAGE_SELF, &ru)
	return int(ru.Maxrss / 1_048_576)
}
