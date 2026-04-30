package dongle

// HfpTcpSource connects to an hfp_tcp server (AirSpy HF+).
// Same wire protocol as rtl_tcp. HF coverage: DC-31 MHz, 60-260 MHz.
type HfpTcpSource struct {
	*RtlTcpSource // embed — identical protocol
}

// NewHfpTcpSource creates a new hfp_tcp source client.
func NewHfpTcpSource(cfg RtlTcpConfig) *HfpTcpSource {
	return &HfpTcpSource{RtlTcpSource: NewRtlTcpSource(cfg)}
}
