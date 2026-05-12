//go:build !gpu_vulkan

package gpu

// FFTContext is a stub type for non-GPU builds.
// On GPU builds this type is defined in vkfft.go.
type FFTContext struct{}

// Process is a stub that always returns ErrNotAvailable.
func (f *FFTContext) Process(_ []byte) ([]float32, error) { return nil, ErrNotAvailable }

// Close is a no-op stub.
func (f *FFTContext) Close() {}

// IqPipelineContext is a stub type for non-GPU builds.
// On GPU builds this type is defined in iq_pipeline.go.
type IqPipelineContext struct{}

// Process is a stub that always returns ErrNotAvailable.
func (p *IqPipelineContext) Process(_ []byte, _ []*IqClientState) ([][]int16, error) {
	return nil, ErrNotAvailable
}

// Close is a no-op stub.
func (p *IqPipelineContext) Close() {}

// MaxIqClients is the maximum batch size for the IQ pipeline.
const MaxIqClients = 64

// IqClientState holds per-client IQ pipeline state.
// On GPU builds this is defined in iq_pipeline.go.
type IqClientState struct {
	Phase    float64
	PhaseInc float64
	B0_0, B1_0, B2_0, A1_0, A2_0 float64
	B0_1, B1_1, B2_1, A1_1, A2_1 float64
	StI0Z1, StI0Z2, StI1Z1, StI1Z2 float64
	StQ0Z1, StQ0Z2, StQ1Z1, StQ1Z2 float64
	DecimFactor int
	DCEnabled   bool
	DCAlpha     float64
	DCI         float64
	DCQ         float64
}

// NewIqClientState is a stub constructor.
func NewIqClientState(_, _, _ int, _ bool) *IqClientState { return &IqClientState{} }

// SetTuneOffset is a stub.
func (s *IqClientState) SetTuneOffset(_ int, _ int) {}

// SetBandwidth is a stub.
func (s *IqClientState) SetBandwidth(_ int, _ int) {}

// Reset is a stub.
func (s *IqClientState) Reset() {}

// FmStereoContext is a stub type for non-GPU builds.
// On GPU builds this type is defined in fm_pipeline.go.
type FmStereoContext struct{}

// Process is a stub that always returns ErrNotAvailable.
func (f *FmStereoContext) Process(_, _, _ []float32, _ []*FmClientState, _, _ int) ([][]float32, error) {
	return nil, ErrNotAvailable
}

// Close is a no-op stub.
func (f *FmStereoContext) Close() {}

// MaxFmClients is the maximum batch size for the FM stereo pipeline.
const MaxFmClients = 32

// MaxFmInputSamples is the maximum input samples per chunk.
const MaxFmInputSamples = 8192

// FmClientState holds per-client FM stereo state.
// On GPU builds this is defined in fm_pipeline.go.
type FmClientState struct {
	LprBuf       [64]float32
	LrBuf        [64]float32
	LprPos       int
	LrPos        int
	DeemphL      float32
	DeemphR      float32
	DeemphAlpha  float32
	DcPrevL      float32
	DcOutPrevL   float32
	DcPrevR      float32
	DcOutPrevR   float32
	DecimCounter int
}

// NewFmClientState is a stub constructor.
func NewFmClientState(_ int, _ float64) *FmClientState { return &FmClientState{} }

// Reset is a stub.
func (s *FmClientState) Reset() {}

// probe returns a zero Capability when the gpu_vulkan build tag is absent.
func probe() Capability {
	return Capability{Available: false}
}

// newBackend is unreachable without gpu_vulkan (probe always returns Available=false),
// but must be defined to satisfy the linker in all build configurations.
func newBackend(_ Capability) (*Backend, error) {
	return nil, ErrNotAvailable
}
