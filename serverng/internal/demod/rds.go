package demod

import (
	"math"
	"strings"
)

// RdsData holds decoded RDS information from an FM broadcast.
type RdsData struct {
	PS  string `json:"ps,omitempty"`  // Station name (up to 8 chars)
	RT  string `json:"rt,omitempty"`  // Radio text (up to 64 chars)
	PI  uint16 `json:"pi,omitempty"`  // Programme Identification code
	PTY uint8  `json:"pty,omitempty"` // Programme type
}

// biquadCoeffsF64 holds coefficients for one biquad section (direct form II).
type biquadCoeffsF64 struct {
	b0, b1, b2 float64
	a1, a2     float64
}

// RdsDecoder extracts RDS data from FM stereo composite audio.
type RdsDecoder struct {
	sampleRate float64

	// 57kHz BPF (2 cascaded biquad sections)
	bpfState  [2][2]float64 // w[n-1], w[n-2] per section
	bpfCoeffs [2]biquadCoeffsF64

	// NCO for 57kHz mix-down
	ncoPhase float64
	ncoInc   float64

	// Low-pass filter after mix-down (1187.5 baud → ~2400 Hz cutoff)
	lpfState  [2]float64 // w[n-1], w[n-2]
	lpfCoeffs biquadCoeffsF64

	// Symbol clock recovery (1187.5 baud)
	symbolPhase float64
	symbolInc   float64
	prevSample  float64

	// Differential decode (biphase/Manchester)
	prevBit    int
	prevSymbol float64

	// Bit buffer for block assembly (26 bits per block)
	bitBuffer uint32
	bitCount  int

	// Block sync
	blockBuf [4]uint16 // 4 blocks per group (16 data bits each)
	blockIdx int
	synced   bool
	errCount int // consecutive CRC errors

	// RDS data output
	ps      [8]byte
	rt      [64]byte
	psValid [4]bool // which 2-char segments have been received
	rtValid [16]bool
	pi      uint16
	pty     uint8
	rtLen   int // known RT length (from 0x0D terminator)
}

// RDS CRC generator polynomial: x^10 + x^8 + x^7 + x^5 + x^4 + x^3 + 1
const rdsCrcPoly uint32 = 0x1B9

// RDS offset words (XORed with CRC during encoding to distinguish blocks)
// The syndrome of a correctly received 26-bit block equals the offset word.
var rdsOffsetWords = [5]uint16{
	252, // Block A  (0x0FC)
	408, // Block B  (0x198)
	360, // Block C  (0x168)
	436, // Block D  (0x1B4)
	848, // Block C' (0x350) — used in type B groups
}

// NewRdsDecoder creates a new RDS decoder for the given composite audio sample rate.
func NewRdsDecoder(sampleRate float64) *RdsDecoder {
	r := &RdsDecoder{
		sampleRate: sampleRate,
	}

	// NCO for 57kHz
	r.ncoInc = 2.0 * math.Pi * 57000.0 / sampleRate
	r.ncoPhase = 0

	// Symbol clock: 1187.5 baud
	r.symbolInc = 1187.5 / sampleRate
	r.symbolPhase = 0

	// Design 57kHz BPF: two cascaded 2nd-order sections
	// Center: 57000 Hz, bandwidth: ~4000 Hz (±2kHz for RDS)
	r.designBPF(57000.0, 4000.0)

	// Design LPF after mix-down: 2400 Hz cutoff (slightly above 1187.5 baud)
	r.designLPF(2400.0)

	return r
}

// designBPF designs a 4th-order Butterworth bandpass filter as 2 cascaded biquads.
func (r *RdsDecoder) designBPF(centerHz, bwHz float64) {
	// Use bilinear transform for BPF
	// For simplicity, design as a resonant biquad pair
	fc := centerHz / r.sampleRate
	bw := bwHz / r.sampleRate

	// Single resonant biquad centered at fc with bandwidth bw
	// Q = fc / bw
	q := fc / bw
	w0 := 2.0 * math.Pi * fc
	alpha := math.Sin(w0) / (2.0 * q)

	b0 := alpha
	b1 := 0.0
	b2 := -alpha
	a0 := 1.0 + alpha
	a1 := -2.0 * math.Cos(w0)
	a2 := 1.0 - alpha

	// Normalize
	coeffs := biquadCoeffsF64{
		b0: b0 / a0,
		b1: b1 / a0,
		b2: b2 / a0,
		a1: a1 / a0,
		a2: a2 / a0,
	}

	// Use same filter twice (cascaded) for steeper skirts
	r.bpfCoeffs[0] = coeffs
	r.bpfCoeffs[1] = coeffs
}

// designLPF designs a 2nd-order Butterworth low-pass filter.
func (r *RdsDecoder) designLPF(cutoffHz float64) {
	fc := cutoffHz / r.sampleRate
	w0 := 2.0 * math.Pi * fc
	q := 0.7071 // Butterworth Q
	alpha := math.Sin(w0) / (2.0 * q)

	cosW0 := math.Cos(w0)
	b0 := (1.0 - cosW0) / 2.0
	b1 := 1.0 - cosW0
	b2 := (1.0 - cosW0) / 2.0
	a0 := 1.0 + alpha
	a1 := -2.0 * cosW0
	a2 := 1.0 - alpha

	r.lpfCoeffs = biquadCoeffsF64{
		b0: b0 / a0,
		b1: b1 / a0,
		b2: b2 / a0,
		a1: a1 / a0,
		a2: a2 / a0,
	}
}

// biquadProcess processes one sample through a biquad filter (transposed direct form II).
func biquadProcess(x float64, state *[2]float64, c *biquadCoeffsF64) float64 {
	y := c.b0*x + state[0]
	state[0] = c.b1*x - c.a1*y + state[1]
	state[1] = c.b2*x - c.a2*y
	return y
}

// Process takes FM composite audio (from FM stereo demod, before L/R separation)
// and returns RDS data if a new complete group was decoded, or nil otherwise.
func (r *RdsDecoder) Process(composite []float32) *RdsData {
	var result *RdsData

	for _, sample := range composite {
		s := float64(sample)

		// Step 1: BPF at 57kHz — extract RDS subcarrier
		filtered := biquadProcess(s, &r.bpfState[0], &r.bpfCoeffs[0])
		filtered = biquadProcess(filtered, &r.bpfState[1], &r.bpfCoeffs[1])

		// Step 2: Mix down to baseband using 57kHz NCO
		cosNco := math.Cos(r.ncoPhase)
		baseband := filtered * 2.0 * cosNco // multiply by 2*cos for proper demod gain

		r.ncoPhase += r.ncoInc
		if r.ncoPhase >= 2.0*math.Pi {
			r.ncoPhase -= 2.0 * math.Pi
		}

		// Step 3: LPF to get baseband RDS signal
		baseband = biquadProcess(baseband, &r.lpfState, &r.lpfCoeffs)

		// Step 4: Clock recovery + symbol sampling
		r.symbolPhase += r.symbolInc
		if r.symbolPhase >= 1.0 {
			r.symbolPhase -= 1.0

			// Sample at symbol center — use sign of baseband for bit decision
			// Biphase (differential Manchester): bit = XOR of current and previous symbol polarity
			currentSymbol := baseband

			// Differential decode
			var bit int
			if (currentSymbol >= 0) != (r.prevSymbol >= 0) {
				bit = 1
			} else {
				bit = 0
			}
			r.prevSymbol = currentSymbol

			// Feed bit into block assembly
			rdsResult := r.processBit(bit)
			if rdsResult != nil {
				result = rdsResult
			}
		}

		// Zero-crossing based clock adjustment
		if (baseband >= 0) != (r.prevSample >= 0) {
			// Zero crossing detected — nudge symbol phase toward 0.5 (center)
			phaseError := r.symbolPhase - 0.5
			if phaseError > 0.5 {
				phaseError -= 1.0
			}
			r.symbolPhase -= phaseError * 0.05 // slow correction
			if r.symbolPhase < 0 {
				r.symbolPhase += 1.0
			}
		}
		r.prevSample = baseband
	}

	return result
}

// processBit handles one decoded bit, assembling into 26-bit blocks and groups.
func (r *RdsDecoder) processBit(bit int) *RdsData {
	// Shift bit into buffer
	r.bitBuffer = (r.bitBuffer << 1) | uint32(bit&1)
	r.bitCount++

	if !r.synced {
		// Looking for sync: check if current 26-bit window matches any block syndrome
		if r.bitCount >= 26 {
			for blockType := 0; blockType < 4; blockType++ {
				if r.checkSyndrome(r.bitBuffer, blockType) {
					// Found valid block — attempt sync
					r.synced = true
					r.blockIdx = blockType
					r.blockBuf[blockType] = uint16(r.bitBuffer >> 10) // top 16 bits are data
					r.blockIdx = (blockType + 1) % 4
					r.bitCount = 0
					r.errCount = 0
					return nil
				}
			}
		}
		return nil
	}

	// Synced: wait for 26 bits then check CRC
	if r.bitCount < 26 {
		return nil
	}

	// Check syndrome for current expected block
	if r.checkSyndrome(r.bitBuffer, r.blockIdx) {
		// Valid block
		r.blockBuf[r.blockIdx] = uint16(r.bitBuffer >> 10)
		r.errCount = 0
	} else {
		// CRC error
		r.errCount++
		if r.errCount > 10 {
			// Lost sync
			r.synced = false
			r.errCount = 0
			return nil
		}
		// Still try to use the data (might be okay despite CRC)
		r.blockBuf[r.blockIdx] = uint16(r.bitBuffer >> 10)
	}

	r.bitCount = 0

	// Check if we completed a full group (4 blocks)
	var result *RdsData
	if r.blockIdx == 3 {
		result = r.parseGroup()
	}

	r.blockIdx = (r.blockIdx + 1) % 4
	return result
}

// checkSyndrome verifies the CRC of a 26-bit block against the expected offset.
// Uses the standard RDS method: checkword XOR offset_word == CRC(dataword)
func (r *RdsDecoder) checkSyndrome(block26 uint32, blockType int) bool {
	dataword := (block26 >> 10) & 0xFFFF
	checkword := uint16(block26 & 0x3FF)
	calculatedCrc := rdsComputeSyndrome(dataword, 16)

	// Also check C' for block type 2 (type B groups use C' instead of C)
	if blockType == 2 {
		return (checkword^rdsOffsetWords[2]) == calculatedCrc ||
			(checkword^rdsOffsetWords[4]) == calculatedCrc
	}
	return (checkword ^ rdsOffsetWords[blockType]) == calculatedCrc
}

// rdsComputeSyndrome computes the CRC (remainder) for x over mlen bits using the RDS polynomial.
func rdsComputeSyndrome(x uint32, mlen int) uint16 {
	reg := uint32(0)
	for i := mlen - 1; i >= 0; i-- {
		reg = (reg << 1) | ((x >> uint(i)) & 1)
		if reg&(1<<10) != 0 {
			reg ^= rdsCrcPoly
		}
	}
	return uint16(reg & 0x3FF)
}

// parseGroup decodes a complete 4-block RDS group.
func (r *RdsDecoder) parseGroup() *RdsData {
	blockA := r.blockBuf[0]
	blockB := r.blockBuf[1]
	// blockC := r.blockBuf[2]
	// blockD := r.blockBuf[3]

	// Block A: PI code
	r.pi = blockA

	// Block B: group type + PTY
	groupType := (blockB >> 12) & 0x0F
	versionB := (blockB>>11)&1 == 1
	r.pty = uint8((blockB >> 5) & 0x1F)

	switch groupType {
	case 0:
		// Type 0A/0B: Programme Service name
		r.parsePS(blockB, r.blockBuf[3], versionB)
	case 2:
		// Type 2A/2B: Radio Text
		r.parseRT(blockB, r.blockBuf[2], r.blockBuf[3], versionB)
	}

	// Return RDS data snapshot
	return r.snapshot()
}

// parsePS extracts 2 characters of the PS name from a type 0 group.
func (r *RdsDecoder) parsePS(blockB, blockD uint16, versionB bool) {
	// PS segment address is in bits 0-1 of block B
	segment := int(blockB & 0x03)

	// Characters from block D
	c1 := byte((blockD >> 8) & 0xFF)
	c2 := byte(blockD & 0xFF)

	idx := segment * 2
	if idx < 7 {
		r.ps[idx] = sanitizeChar(c1)
		r.ps[idx+1] = sanitizeChar(c2)
		r.psValid[segment] = true
	}
}

// parseRT extracts characters of Radio Text from a type 2 group.
func (r *RdsDecoder) parseRT(blockB, blockC, blockD uint16, versionB bool) {
	segment := int(blockB & 0x0F)

	if versionB {
		// Type 2B: 2 chars from block D only
		idx := segment * 2
		if idx < 63 {
			c1 := byte((blockD >> 8) & 0xFF)
			c2 := byte(blockD & 0xFF)
			r.rt[idx] = sanitizeChar(c1)
			r.rt[idx+1] = sanitizeChar(c2)
			if segment < 16 {
				r.rtValid[segment] = true
			}
			// Check for CR terminator (0x0D)
			if c1 == 0x0D {
				r.rtLen = idx
			} else if c2 == 0x0D {
				r.rtLen = idx + 1
			}
		}
	} else {
		// Type 2A: 4 chars from blocks C and D
		idx := segment * 4
		if idx < 61 {
			c1 := byte((blockC >> 8) & 0xFF)
			c2 := byte(blockC & 0xFF)
			c3 := byte((blockD >> 8) & 0xFF)
			c4 := byte(blockD & 0xFF)
			r.rt[idx] = sanitizeChar(c1)
			r.rt[idx+1] = sanitizeChar(c2)
			r.rt[idx+2] = sanitizeChar(c3)
			r.rt[idx+3] = sanitizeChar(c4)
			if segment < 16 {
				r.rtValid[segment] = true
			}
			// Check for CR terminator
			for j := 0; j < 4; j++ {
				if r.rt[idx+j] == 0x0D || r.rt[idx+j] == 0 {
					r.rtLen = idx + j
					r.rt[idx+j] = 0 // null terminate
					break
				}
			}
		}
	}
}

// snapshot returns the current RDS data state.
func (r *RdsDecoder) snapshot() *RdsData {
	data := &RdsData{
		PI:  r.pi,
		PTY: r.pty,
	}

	// PS: only include if at least one segment received
	ps := r.CurrentPS()
	if ps != "" {
		data.PS = ps
	}

	// RT
	rt := r.CurrentRT()
	if rt != "" {
		data.RT = rt
	}

	return data
}

// Reset clears all RDS state.
func (r *RdsDecoder) Reset() {
	r.ncoPhase = 0
	r.symbolPhase = 0
	r.prevSample = 0
	r.prevSymbol = 0
	r.prevBit = 0
	r.bitBuffer = 0
	r.bitCount = 0
	r.blockBuf = [4]uint16{}
	r.blockIdx = 0
	r.synced = false
	r.errCount = 0
	r.ps = [8]byte{}
	r.rt = [64]byte{}
	r.psValid = [4]bool{}
	r.rtValid = [16]bool{}
	r.pi = 0
	r.pty = 0
	r.rtLen = 0

	// Clear filter states
	r.bpfState = [2][2]float64{}
	r.lpfState = [2]float64{}
}

// CurrentPS returns the current station name (may be partial).
func (r *RdsDecoder) CurrentPS() string {
	// Check if any segment is valid
	anyValid := false
	for _, v := range r.psValid {
		if v {
			anyValid = true
			break
		}
	}
	if !anyValid {
		return ""
	}

	// Build PS string, replacing unset segments with spaces
	var buf [8]byte
	for i := 0; i < 4; i++ {
		if r.psValid[i] {
			buf[i*2] = r.ps[i*2]
			buf[i*2+1] = r.ps[i*2+1]
		} else {
			buf[i*2] = ' '
			buf[i*2+1] = ' '
		}
	}

	return strings.TrimRight(string(buf[:]), " \x00")
}

// CurrentRT returns the current radio text (may be partial).
func (r *RdsDecoder) CurrentRT() string {
	// Check if any segment is valid
	anyValid := false
	for _, v := range r.rtValid {
		if v {
			anyValid = true
			break
		}
	}
	if !anyValid {
		return ""
	}

	length := r.rtLen
	if length <= 0 {
		// Find last valid segment to determine length
		for i := 15; i >= 0; i-- {
			if r.rtValid[i] {
				length = (i + 1) * 4
				break
			}
		}
	}
	if length > 64 {
		length = 64
	}
	if length <= 0 {
		return ""
	}

	return strings.TrimRight(string(r.rt[:length]), " \x00\x0D")
}

// sanitizeChar converts an RDS character to printable ASCII.
// RDS uses a subset of ASCII with some extensions.
func sanitizeChar(c byte) byte {
	if c >= 0x20 && c <= 0x7E {
		return c
	}
	if c == 0x0D {
		return c // CR is a valid terminator
	}
	return ' ' // replace non-printable with space
}
