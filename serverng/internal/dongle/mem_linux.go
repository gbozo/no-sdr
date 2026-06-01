//go:build linux

package dongle

import "syscall"

// getMemoryMB returns the process RSS in megabytes.
// On Linux, Maxrss from getrusage is in kilobytes.
func getMemoryMB() int {
	var ru syscall.Rusage
	syscall.Getrusage(syscall.RUSAGE_SELF, &ru)
	return int(ru.Maxrss / 1024)
}
