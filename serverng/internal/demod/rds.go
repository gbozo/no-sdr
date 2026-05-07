package demod

import (
	"math"
	"strings"
)

// PTY names per RDS standard (Europe). Index = PTY code 0–31.
var ptyNames = [32]string{
	"None", "News", "Current Affairs", "Information", "Sport", "Education",
	"Drama", "Culture", "Science", "Varied", "Pop Music", "Rock Music",
	"Easy Listening", "Light Classical", "Serious Classical", "Other Music",
	"Weather", "Finance", "Children's", "Social Affairs", "Religion",
	"Phone In", "Travel", "Leisure", "Jazz", "Country", "National Music",
	"Oldies", "Folk Music", "Documentary", "Alarm Test", "Alarm",
}

// RdsData holds decoded RDS information from an FM broadcast.
// Field names and types match the TypeScript RdsData interface consumed by the client.
type RdsData struct {
	PS      string   `json:"ps"`      // Station name (up to 8 chars)
	RT      string   `json:"rt"`      // Radio text (up to 64 chars)
	PI      uint16   `json:"pi"`      // Programme Identification code (always present)
	PTY     uint8    `json:"pty"`     // Programme type code
	PtyName string   `json:"ptyName"` // Human-readable PTY label
	Synced  bool     `json:"synced"`  // Block sync acquired
	ECC     *uint8   `json:"ecc"`     // Extended Country Code (group 1A); nil if not yet received
	PTYN    string   `json:"ptyn"`    // Programme Type Name 8-char (group 10A)
	EON     []EonEntry `json:"eon"`   // Enhanced Other Networks (group 14A)
}

// EonEntry holds data for one Enhanced Other Network (group 14A).
type EonEntry struct {
	PI uint16   `json:"pi"` // PI of the other network
	PS string   `json:"ps"` // PS name of the other network
	AF []float32 `json:"af"` // Alternative frequencies (MHz)
}

// ---- Biquad filter (transposed direct form II) ----

type biquadCoeffs struct {
	b0, b1, b2 float64
	a1, a2     float64
}

type biquadState struct {
	z1, z2 float64
}

func (s *biquadState) process(x float64, c *biquadCoeffs) float64 {
	y := c.b0*x + s.z1
	s.z1 = c.b1*x - c.a1*y + s.z2
	s.z2 = c.b2*x - c.a2*y
	return y
}

// bandpassCoeffs designs a 2nd-order Butterworth bandpass biquad.
// freq and fs in Hz, Q is quality factor.
func bandpassCoeffs(freq, Q, fs float64) biquadCoeffs {
	w0 := 2.0 * math.Pi * freq / fs
	alpha := math.Sin(w0) / (2.0 * Q)
	cosW0 := math.Cos(w0)
	a0 := 1 + alpha
	return biquadCoeffs{
		b0: alpha / a0,
		b1: 0,
		b2: -alpha / a0,
		a1: -2 * cosW0 / a0,
		a2: (1 - alpha) / a0,
	}
}

// lowpassCoeffs designs a 2nd-order Butterworth lowpass biquad.
func lowpassCoeffs(freq, Q, fs float64) biquadCoeffs {
	w0 := 2.0 * math.Pi * freq / fs
	alpha := math.Sin(w0) / (2.0 * Q)
	cosW0 := math.Cos(w0)
	a0 := 1 + alpha
	return biquadCoeffs{
		b0: (1 - cosW0) / 2.0 / a0,
		b1: (1 - cosW0) / a0,
		b2: (1 - cosW0) / 2.0 / a0,
		a1: -2 * cosW0 / a0,
		a2: (1 - alpha) / a0,
	}
}

// ---- Symbol sync (Gardner TED, matching TypeScript SymbolSync) ----

type symbolSync struct {
	samplesPerSymbol float64
	phase            float64
	accumulator      float64
	sampleCount      int

	// Gardner TED state
	prevSymbolValue  float64
	midSample        float64
	halfSymbolPhase  float64
	midCaptured      bool

	// PI loop filter for timing
	loopGain   float64 // proportional
	loopBeta   float64 // integral
	freqOffset float64 // accumulated frequency adjustment
}

func newSymbolSync(decimatedRate float64) *symbolSync {
	sps := decimatedRate / (rdsBitrate * 2)
	// Loop bandwidth: ~1% of symbol rate
	BLTs := 0.01
	damping := 1.0
	denominator := 1.0 + 2.0*damping*BLTs + BLTs*BLTs
	return &symbolSync{
		samplesPerSymbol: sps,
		loopGain:         (4.0 * damping * BLTs) / denominator,
		loopBeta:         (4.0 * BLTs * BLTs) / denominator,
	}
}

// push returns a symbol value at the symbol clock boundary, or (0, false) if not yet.
func (s *symbolSync) push(sample float64) (float64, bool) {
	s.accumulator += sample
	s.sampleCount++
	s.phase += 1.0 / s.samplesPerSymbol
	s.halfSymbolPhase += 1.0 / s.samplesPerSymbol

	// Capture mid-point sample (at half-symbol boundary)
	if !s.midCaptured && s.halfSymbolPhase >= 0.5 {
		if s.sampleCount > 0 {
			s.midSample = s.accumulator / float64(s.sampleCount)
		}
		s.midCaptured = true
	}

	if s.phase >= 1.0 {
		s.phase -= 1.0
		s.halfSymbolPhase = 0
		sym := s.accumulator / float64(s.sampleCount)
		s.accumulator = 0
		s.sampleCount = 0
		s.midCaptured = false

		// Gardner TED: error = (prevSymbol - currentSymbol) * midSample
		ted := (s.prevSymbolValue - sym) * s.midSample

		// PI loop filter
		s.freqOffset += s.loopBeta * ted
		phaseAdj := s.loopGain*ted + s.freqOffset

		// Apply timing correction (clamp to prevent instability)
		maxAdj := 0.3 / s.samplesPerSymbol
		if phaseAdj > maxAdj {
			phaseAdj = maxAdj
		} else if phaseAdj < -maxAdj {
			phaseAdj = -maxAdj
		}
		s.phase += phaseAdj

		s.prevSymbolValue = sym
		return sym, true
	}
	return 0, false
}

func (s *symbolSync) reset() {
	s.phase = 0
	s.prevSymbolValue = 0
	s.midSample = 0
	s.halfSymbolPhase = 0
	s.midCaptured = false
	s.accumulator = 0
	s.sampleCount = 0
	s.freqOffset = 0
}

// ---- Biphase decoder (clock-polarity tracking, matching TypeScript BiphaseDecoder) ----

const biphaseWindow = 128

type biphaseDecoder struct {
	prevSymbol    float64
	clock         int
	clockPolarity int
	history       [biphaseWindow]float64
}

// push returns (bit, true) at data phase, or (false, false) on reference phase.
func (b *biphaseDecoder) push(sym float64) (bool, bool) {
	diff := sym * b.prevSymbol
	hasTransition := diff < 0
	energy := math.Abs(sym - b.prevSymbol)

	idx := b.clock % biphaseWindow
	b.history[idx] = energy

	isDataPhase := (b.clock%2) == b.clockPolarity
	b.clock++

	// Periodically re-evaluate clock polarity
	if b.clock >= biphaseWindow {
		var evenSum, oddSum float64
		for i := 0; i < biphaseWindow; i += 2 {
			evenSum += b.history[i]
			if i+1 < biphaseWindow {
				oddSum += b.history[i+1]
			}
		}
		if evenSum > oddSum {
			b.clockPolarity = 0
		} else {
			b.clockPolarity = 1
		}
		b.clock = 0
	}

	b.prevSymbol = sym

	if isDataPhase {
		return hasTransition, true
	}
	return false, false
}

func (b *biphaseDecoder) reset() {
	b.prevSymbol = 0
	b.clock = 0
	b.clockPolarity = 0
	b.history = [biphaseWindow]float64{}
}

// ---- Delta decoder (differential Manchester → absolute bits) ----

type deltaDecoder struct {
	prev bool
}

func (d *deltaDecoder) decode(bit bool) bool {
	out := bit != d.prev
	d.prev = bit
	return out
}

func (d *deltaDecoder) reset() { d.prev = false }

// ---- Block sync ----

// RDS parity check matrix (IEC 62106, 26 rows) — matches TypeScript PARITY_MATRIX.
var parityMatrix = [26]uint32{
	0x200, 0x100, 0x080, 0x040, 0x020, 0x010, 0x008, 0x004, 0x002, 0x001,
	0x2DC, 0x16E, 0x0B7, 0x287, 0x39F, 0x313, 0x355, 0x376, 0x1BB, 0x201,
	0x3DC, 0x1EE, 0x0F7, 0x2A7, 0x38F, 0x31B,
}

// Syndromes for each offset word (matching TypeScript constants).
const (
	syndromeA      uint32 = 0x3D8
	syndromeB      uint32 = 0x3D4
	syndromeC      uint32 = 0x25C
	syndromeCprime uint32 = 0x3CC
	syndromeD      uint32 = 0x258
)

// singleBitSyndromes maps a syndrome value to the bit position (0-25) that caused it.
// Used for single-bit error correction: if (receivedSyndrome XOR expectedOffsetSyndrome)
// matches an entry, we can correct by flipping that bit.
var singleBitSyndromes map[uint32]int

func init() {
	singleBitSyndromes = make(map[uint32]int, 26)
	for i := 0; i < 26; i++ {
		singleBitSyndromes[parityMatrix[i]] = 25 - i
	}
}

// syndromeForOffset returns the expected syndrome for a given offset type.
func syndromeForOffset(s rdsSyndrome) uint32 {
	switch s {
	case synA:
		return syndromeA
	case synB:
		return syndromeB
	case synC:
		return syndromeC
	case synCprime:
		return syndromeCprime
	case synD:
		return syndromeD
	default:
		return 0
	}
}

// tryCorrectBlock attempts single-bit error correction on a 26-bit block.
// Returns the corrected block and true if successful, or (0, false) if not correctable.
func tryCorrectBlock(register uint32, expected rdsSyndrome) (uint32, bool) {
	syndrome := calculateSyndrome(register)
	// Try expected offset
	errorSyn := syndrome ^ syndromeForOffset(expected)
	if bitPos, ok := singleBitSyndromes[errorSyn]; ok {
		return register ^ (1 << bitPos), true
	}
	// For C position, also try C' (stations may alternate)
	if expected == synC {
		errorSyn = syndrome ^ syndromeCprime
		if bitPos, ok := singleBitSyndromes[errorSyn]; ok {
			return register ^ (1 << bitPos), true
		}
	}
	return 0, false
}

type rdsSyndrome int

const (
	synInvalid rdsSyndrome = iota
	synA
	synB
	synC
	synCprime
	synD
)

func calculateSyndrome(block uint32) uint32 {
	var syndrome uint32
	for i := 0; i < 26; i++ {
		if (block>>(25-i))&1 != 0 {
			syndrome ^= parityMatrix[i]
		}
	}
	return syndrome
}

func getSyndrome(block uint32) rdsSyndrome {
	switch calculateSyndrome(block) {
	case syndromeA:
		return synA
	case syndromeB:
		return synB
	case syndromeC:
		return synC
	case syndromeCprime:
		return synCprime
	case syndromeD:
		return synD
	default:
		return synInvalid
	}
}

func syndromeToIndex(s rdsSyndrome) int {
	switch s {
	case synA:
		return 0
	case synB:
		return 1
	case synC, synCprime:
		return 2
	case synD:
		return 3
	default:
		return 0
	}
}

func nextSyndrome(s rdsSyndrome) rdsSyndrome {
	switch s {
	case synA:
		return synB
	case synB:
		return synC
	case synC, synCprime:
		return synD
	case synD:
		return synA
	default:
		return synA
	}
}

const maxBlockErrors = 10

type blockSync struct {
	register       uint32
	bitCount       int
	synced         bool
	expectedOffset rdsSyndrome
	group          [4]int32 // -1 = absent/bad, else 16-bit data word
	blockIndex     int
	errorCount     int
	goodBlocks     int
}

func newBlockSync() *blockSync {
	b := &blockSync{expectedOffset: synA}
	b.group[0] = -1
	b.group[1] = -1
	b.group[2] = -1
	b.group[3] = -1
	return b
}

// pushBit returns (group, true) when a complete 4-block group is assembled, else (_, false).
func (b *blockSync) pushBit(bit bool) ([4]int32, bool) {
	var one uint32
	if bit {
		one = 1
	}
	b.register = ((b.register << 1) | one) & 0x3FFFFFF // 26-bit shift register

	if !b.synced {
		syn := getSyndrome(b.register)
		if syn != synInvalid {
			b.synced = true
			b.blockIndex = syndromeToIndex(syn)
			b.expectedOffset = nextSyndrome(syn)
			b.bitCount = 0
			b.errorCount = 0
			b.goodBlocks = 1
			b.group = [4]int32{-1, -1, -1, -1}
			b.group[b.blockIndex] = int32((b.register >> 10) & 0xFFFF)
			b.blockIndex = (b.blockIndex + 1) % 4
		}
		return [4]int32{}, false
	}

	// Tracking: count 26 bits per block
	b.bitCount++
	if b.bitCount < 26 {
		return [4]int32{}, false
	}
	b.bitCount = 0

	syn := getSyndrome(b.register)
	var offset rdsSyndrome = synInvalid

	if b.expectedOffset == synC && syn == synCprime {
		offset = synCprime
	} else if syn == b.expectedOffset {
		offset = syn
	}

	if offset != synInvalid {
		b.group[b.blockIndex] = int32((b.register >> 10) & 0xFFFF)
		b.errorCount = 0
		b.goodBlocks++
	} else {
		// Attempt single-bit error correction before marking block as bad
		if corrected, ok := tryCorrectBlock(b.register, b.expectedOffset); ok {
			b.group[b.blockIndex] = int32((corrected >> 10) & 0xFFFF)
			b.errorCount = 0
			b.goodBlocks++
		} else {
			b.group[b.blockIndex] = -1 // bad block
			b.errorCount++
			if b.errorCount > maxBlockErrors {
				b.synced = false
				b.goodBlocks = 0
				return [4]int32{}, false
			}
		}
	}

	b.expectedOffset = nextSyndrome(b.expectedOffset)
	b.blockIndex = (b.blockIndex + 1) % 4

	// Complete group when we've wrapped to block A
	if b.blockIndex == 0 {
		result := b.group
		b.group = [4]int32{-1, -1, -1, -1}
		return result, true
	}
	return [4]int32{}, false
}

func (b *blockSync) reset() {
	b.register = 0
	b.bitCount = 0
	b.synced = false
	b.expectedOffset = synA
	b.group = [4]int32{-1, -1, -1, -1}
	b.blockIndex = 0
	b.errorCount = 0
	b.goodBlocks = 0
}

// ---- Group parser ----

type groupParser struct {
	psChars  [8]byte
	rtChars  [64]byte
	rtAbFlag int
	ptynChars [8]byte
	eonMap   map[uint16]*EonEntry // keyed by ON PI
}

func newGroupParser() *groupParser {
	gp := &groupParser{rtAbFlag: -1, eonMap: make(map[uint16]*EonEntry)}
	for i := range gp.psChars {
		gp.psChars[i] = ' '
	}
	for i := range gp.rtChars {
		gp.rtChars[i] = ' '
	}
	for i := range gp.ptynChars {
		gp.ptynChars[i] = ' '
	}
	return gp
}

func rdsChar(code byte) byte {
	if code >= 0x20 && code <= 0x7E {
		return code
	}
	if code == 0x0D {
		return code // CR = RadioText terminator
	}
	return ' '
}

func (gp *groupParser) parse(group [4]int32, data *RdsData) {
	blockA := group[0]
	blockB := group[1]
	blockC := group[2]
	blockD := group[3]

	if blockA != -1 {
		data.PI = uint16(blockA)
	}
	if blockB == -1 {
		return
	}

	groupType := uint8((blockB >> 12) & 0x0F)
	versionB := ((blockB >> 11) & 1) == 1
	pty := uint8((blockB >> 5) & 0x1F)
	data.PTY = pty
	if int(pty) < len(ptyNames) {
		data.PtyName = ptyNames[pty]
	} else {
		data.PtyName = "Unknown"
	}

	switch groupType {
	case 0:
		// Type 0A/0B: Programme Service name
		if blockD != -1 {
			segment := int(blockB & 0x03)
			idx := segment * 2
			if idx < 8 {
				gp.psChars[idx] = rdsChar(byte((blockD >> 8) & 0xFF))
				gp.psChars[idx+1] = rdsChar(byte(blockD & 0xFF))
			}
		}
		data.PS = strings.TrimRight(string(gp.psChars[:]), " \x00")

	case 1:
		// Type 1A: Programme Item Number + Extended Country Code
		if !versionB && blockC != -1 {
			ecc := uint8(blockC & 0xFF)
			data.ECC = &ecc
		}

	case 2:
		// Type 2A/2B: RadioText
		segment := int(blockB & 0x0F)
		abFlag := int((blockB >> 4) & 1)
		if gp.rtAbFlag != abFlag {
			for i := range gp.rtChars {
				gp.rtChars[i] = ' '
			}
			gp.rtAbFlag = abFlag
		}
		if versionB {
			if blockD != -1 {
				idx := segment * 2
				if idx < 62 {
					gp.rtChars[idx] = rdsChar(byte((blockD >> 8) & 0xFF))
					gp.rtChars[idx+1] = rdsChar(byte(blockD & 0xFF))
				}
			}
		} else {
			if blockC != -1 && blockD != -1 {
				idx := segment * 4
				if idx < 60 {
					gp.rtChars[idx] = rdsChar(byte((blockC >> 8) & 0xFF))
					gp.rtChars[idx+1] = rdsChar(byte(blockC & 0xFF))
					gp.rtChars[idx+2] = rdsChar(byte((blockD >> 8) & 0xFF))
					gp.rtChars[idx+3] = rdsChar(byte(blockD & 0xFF))
				}
			}
		}
		rtEnd := 64
		for i := 0; i < 64; i++ {
			if gp.rtChars[i] == 0x0D || gp.rtChars[i] == 0 {
				rtEnd = i
				break
			}
		}
		data.RT = strings.TrimRight(string(gp.rtChars[:rtEnd]), " \x00\x0D")

	case 10:
		// Type 10A: Programme Type Name (PTYN) — 8 chars, 4 per group
		if !versionB {
			segment := int(blockB & 0x01) // bit 0 → segment 0 or 1
			if blockC != -1 {
				idx := segment * 4
				gp.ptynChars[idx] = rdsChar(byte((blockC >> 8) & 0xFF))
				gp.ptynChars[idx+1] = rdsChar(byte(blockC & 0xFF))
			}
			if blockD != -1 {
				idx := segment*4 + 2
				gp.ptynChars[idx] = rdsChar(byte((blockD >> 8) & 0xFF))
				gp.ptynChars[idx+1] = rdsChar(byte(blockD & 0xFF))
			}
			data.PTYN = strings.TrimRight(string(gp.ptynChars[:]), " \x00")
		}

	case 14:
		// Type 14A: Enhanced Other Networks
		if !versionB && blockD != -1 {
			onPI := uint16(blockD)
			entry, ok := gp.eonMap[onPI]
			if !ok {
				entry = &EonEntry{PI: onPI, PS: "        "}
				gp.eonMap[onPI] = entry
			}
			variant := int(blockB & 0x0F)
			switch {
			case variant <= 3 && blockC != -1:
				// PS name: 2 chars per variant
				psBytes := []byte(entry.PS)
				if len(psBytes) < 8 {
					psBytes = append(psBytes, make([]byte, 8-len(psBytes))...)
				}
				psBytes[variant*2] = rdsChar(byte((blockC >> 8) & 0xFF))
				psBytes[variant*2+1] = rdsChar(byte(blockC & 0xFF))
				entry.PS = string(psBytes)
			case variant >= 4 && variant <= 11 && blockC != -1:
				// Mapped AFs
				af1 := byte((blockC >> 8) & 0xFF)
				af2 := byte(blockC & 0xFF)
				addAF := func(code byte) {
					if code >= 1 && code <= 204 {
						mhz := float32(87.6 + float64(code)*0.1)
						mhz = float32(int(mhz*10+0.5)) / 10 // round to 1dp
						for _, f := range entry.AF {
							if f == mhz {
								return
							}
						}
						entry.AF = append(entry.AF, mhz)
					}
				}
				addAF(af1)
				addAF(af2)
			}
			// Rebuild EON slice
			data.EON = make([]EonEntry, 0, len(gp.eonMap))
			for _, e := range gp.eonMap {
				data.EON = append(data.EON, EonEntry{
					PI: e.PI,
					PS: strings.TrimRight(e.PS, " \x00"),
					AF: append([]float32{}, e.AF...),
				})
			}
		}
	}
}

func (gp *groupParser) reset() {
	for i := range gp.psChars {
		gp.psChars[i] = ' '
	}
	for i := range gp.rtChars {
		gp.rtChars[i] = ' '
	}
	for i := range gp.ptynChars {
		gp.ptynChars[i] = ' '
	}
	gp.rtAbFlag = -1
	gp.eonMap = make(map[uint16]*EonEntry)
}

// ---- Main RDS decoder ----

const (
	rdsSubcarrierHz = 57000.0
	rdsBitrate      = 1187.5
	rdsDecimate     = 10 // 240kHz → 24kHz decimation factor
)

// RdsDecoder extracts RDS data from FM stereo composite audio.
// Matches the TypeScript RdsDecoder algorithm exactly.
type RdsDecoder struct {
	// BPF at 57kHz (two cascaded biquads for sharper selectivity)
	bpf1     biquadCoeffs
	bpf1s    biquadState
	bpf2     biquadCoeffs
	bpf2s    biquadState

	// NCO for mix-down
	ncoPhase float64
	ncoInc   float64

	// Decimation
	decimCounter int

	// LPF after mix-down (I channel only — Q not needed for BPSK)
	lpfI  biquadCoeffs
	lpfIs biquadState

	// Demod chain
	symSync  *symbolSync
	biphase  biphaseDecoder
	delta    deltaDecoder
	blkSync  *blockSync
	grpParse *groupParser

	// Current accumulated RDS data
	data RdsData
}

// NewRdsDecoder creates a new RDS decoder for the given composite audio sample rate.
// sampleRate should be the composite input rate (typically 240000 Hz for WFM).
func NewRdsDecoder(sampleRate float64) *RdsDecoder {
	decimatedRate := sampleRate / rdsDecimate

	r := &RdsDecoder{
		bpf1:    bandpassCoeffs(rdsSubcarrierHz, 10, sampleRate),
		bpf2:    bandpassCoeffs(rdsSubcarrierHz, 10, sampleRate),
		ncoInc:  2.0 * math.Pi * rdsSubcarrierHz / sampleRate,
		lpfI:    lowpassCoeffs(2400, 0.707, decimatedRate),
		symSync:  newSymbolSync(decimatedRate),
		blkSync:  newBlockSync(),
		grpParse: newGroupParser(),
		data:     RdsData{EON: []EonEntry{}},
	}
	return r
}

// Process takes FM composite audio (from FmStereoDemod.GetComposite()) at the full
// input sample rate (e.g., 240kHz) and returns an updated *RdsData if new RDS data
// was decoded in this batch, or nil if nothing new.
func (r *RdsDecoder) Process(composite []float32) *RdsData {
	return r.processInternal(composite, nil)
}

// ProcessWithPilot is like Process but uses pilot-locked phase for coherent RDS demodulation.
// pilotPhases must be the same length as composite and contains the 19kHz pilot phase per sample.
// When pilot is locked, this eliminates NCO drift and greatly improves block decode rate.
func (r *RdsDecoder) ProcessWithPilot(composite []float32, pilotPhases []float64) *RdsData {
	return r.processInternal(composite, pilotPhases)
}

func (r *RdsDecoder) processInternal(composite []float32, pilotPhases []float64) *RdsData {
	var updated bool
	usePilot := pilotPhases != nil && len(pilotPhases) == len(composite)

	for idx, s := range composite {
		x := float64(s)

		// 1. Bandpass filter at 57kHz (two cascaded stages)
		filtered := r.bpf1s.process(x, &r.bpf1)
		filtered = r.bpf2s.process(filtered, &r.bpf2)

		// 2. Mix down to baseband
		var iRaw float64
		if usePilot {
			// Pilot-locked: RDS subcarrier = 3 × pilot phase (57 = 3 × 19 kHz)
			rdsPhase := 3.0 * pilotPhases[idx]
			iRaw = filtered * math.Cos(rdsPhase)
		} else {
			// Free-running NCO fallback
			cosN := math.Cos(r.ncoPhase)
			iRaw = filtered * cosN
			r.ncoPhase += r.ncoInc
			if r.ncoPhase >= 2.0*math.Pi {
				r.ncoPhase -= 2.0 * math.Pi
			}
		}

		// 3. Decimate by rdsDecimate
		r.decimCounter++
		if r.decimCounter < rdsDecimate {
			continue
		}
		r.decimCounter = 0

		// 4. LPF the baseband
		iBase := r.lpfIs.process(iRaw, &r.lpfI)

		// 5. Symbol sync
		sym, ok := r.symSync.push(iBase)
		if !ok {
			continue
		}

		// 6. Biphase decode
		bit, isData := r.biphase.push(sym)
		if !isData {
			continue
		}

		// 7. Delta decode
		absBit := r.delta.decode(bit)

		// 8. Block sync
		group, complete := r.blkSync.pushBit(absBit)
		if !complete {
			continue
		}

		// 9. Parse group into accumulated data
		r.grpParse.parse(group, &r.data)
		updated = true
	}

	if updated {
		snapshot := r.data
		snapshot.Synced = r.blkSync.synced
		return &snapshot
	}
	return nil
}

// Reset clears all decoder state.
func (r *RdsDecoder) Reset() {
	r.bpf1s = biquadState{}
	r.bpf2s = biquadState{}
	r.lpfIs = biquadState{}
	r.ncoPhase = 0
	r.decimCounter = 0
	r.symSync.reset()
	r.biphase.reset()
	r.delta.reset()
	r.blkSync.reset()
	r.grpParse.reset()
	r.data = RdsData{EON: []EonEntry{}}
}
