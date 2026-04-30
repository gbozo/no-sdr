package dongle

// RspTcpSource connects to an rsp_tcp server (SDRplay RSP1/2/duo/dx).
// Extends rtl_tcp protocol with additional commands for RSP-specific features.
// Standard rtl_tcp commands (0x01-0x0E) work as normal; RSP extensions
// use command bytes in the 0x20+ range.
type RspTcpSource struct {
	*RtlTcpSource // embed — base protocol is rtl_tcp compatible
}

// NewRspTcpSource creates a new rsp_tcp source client.
func NewRspTcpSource(cfg RtlTcpConfig) *RspTcpSource {
	return &RspTcpSource{RtlTcpSource: NewRtlTcpSource(cfg)}
}

// RSP-specific extended commands

// SetRfGainReduction sets RF gain reduction (20-59 dB).
func (r *RspTcpSource) SetRfGainReduction(db uint32) error {
	return r.Command(0x20, db)
}

// SetLnaState sets LNA state (0-9 depending on model).
func (r *RspTcpSource) SetLnaState(state uint32) error {
	return r.Command(0x21, state)
}

// SetAntennaPort sets antenna port (0=A, 1=B, for RSP2/duo).
func (r *RspTcpSource) SetAntennaPort(port uint32) error {
	return r.Command(0x22, port)
}

// SetNotchFilter enables/disables broadcast notch filter.
func (r *RspTcpSource) SetNotchFilter(enabled uint32) error {
	return r.Command(0x23, enabled)
}

// SetRefClock sets reference clock output.
func (r *RspTcpSource) SetRefClock(enabled uint32) error {
	return r.Command(0x24, enabled)
}
