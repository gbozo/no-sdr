//go:build !gpu_vulkan

package gpu

// probe returns a zero Capability when the gpu_vulkan build tag is absent.
func probe() Capability {
	return Capability{Available: false}
}

// newBackend is unreachable without gpu_vulkan (probe always returns Available=false),
// but must be defined to satisfy the linker in all build configurations.
func newBackend(_ Capability) (*Backend, error) {
	return nil, ErrNotAvailable
}
