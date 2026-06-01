//go:build !linux && !darwin && !windows

package dongle

func getCPUTimeNanos() int64 {
	return 0
}
