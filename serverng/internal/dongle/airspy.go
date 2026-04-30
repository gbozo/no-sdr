package dongle

// AirspyTcpSource connects to an airspy_tcp server.
// Same wire protocol as rtl_tcp (12-byte header + 5-byte commands + raw IQ stream)
// but typically operates at higher sample rates (2.5/6/10 MSPS).
type AirspyTcpSource struct {
	*RtlTcpSource // embed — identical protocol
}

// NewAirspyTcpSource creates a new airspy_tcp source client.
func NewAirspyTcpSource(cfg RtlTcpConfig) *AirspyTcpSource {
	return &AirspyTcpSource{RtlTcpSource: NewRtlTcpSource(cfg)}
}
