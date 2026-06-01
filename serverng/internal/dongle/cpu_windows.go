//go:build windows

package dongle

import "syscall"

func getCPUTimeNanos() int64 {
	var creationTime, exitTime, kernelTime, userTime syscall.Filetime
	h, _ := syscall.GetCurrentProcess()
	syscall.GetProcessTimes(h, &creationTime, &exitTime, &kernelTime, &userTime)
	kernel := int64(kernelTime.HighDateTime)<<32 + int64(kernelTime.LowDateTime)
	user := int64(userTime.HighDateTime)<<32 + int64(userTime.LowDateTime)
	return (kernel + user) * 100
}
