package dongle

import "context"

// Source is the interface all IQ data sources implement.
type Source interface {
	Run(ctx context.Context, out chan<- []byte)
	Close() error
}

// CommandableSource can receive tuning commands (for profile switches).
type CommandableSource interface {
	Source
	SetFrequency(hz uint32) error
	SetSampleRate(hz uint32) error
	SetGain(tenthsDb uint32) error
	SetGainMode(mode uint32) error
	SetDirectSampling(mode uint32) error
	SetBiasT(enabled uint32) error
	SetAgcMode(mode uint32) error
	SetOffsetTuning(mode uint32) error
	SetFrequencyCorrection(ppm uint32) error
}

// Compile-time interface compliance checks.
var (
	_ Source            = (*DemoSource)(nil)
	_ Source            = (*RtlTcpSource)(nil)
	_ Source            = (*AirspyTcpSource)(nil)
	_ Source            = (*HfpTcpSource)(nil)
	_ Source            = (*RspTcpSource)(nil)
	_ Source            = (*RtlSdrSource)(nil)
	_ CommandableSource = (*RtlTcpSource)(nil)
)
