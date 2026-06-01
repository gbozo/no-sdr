//go:build !linux && !darwin && !windows

package dongle

func getMemoryMB() int {
	return 0
}
