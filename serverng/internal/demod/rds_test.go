package demod

import (
	"testing"
)

func TestRdsComputeSyndrome(t *testing.T) {
	// Test that a 26-bit block of all zeros produces syndrome 0
	syndrome := rdsComputeSyndrome(0, 26)
	if syndrome != 0 {
		t.Errorf("zero block syndrome: got 0x%03X, want 0x000", syndrome)
	}

	// Test that calcSyndrome(data, 16) computes CRC correctly
	// For data=0, CRC should be 0
	crc := rdsComputeSyndrome(0, 16)
	if crc != 0 {
		t.Errorf("CRC of zero data: got 0x%03X, want 0x000", crc)
	}
}

func TestRdsCheckSyndrome(t *testing.T) {
	r := NewRdsDecoder(240000)

	// Build a known block: 16 data bits + 10 check bits matching block A offset
	// Data: 0x1234 (PI code)
	data := uint32(0x1234)

	// Encode: compute check bits for data with offset A
	block := encodeRdsBlock(data, 0) // block A

	if !r.checkSyndrome(block, 0) {
		t.Errorf("valid block A failed syndrome check, block=0x%07X, syndrome=0x%03X, want=0x%03X",
			block, rdsComputeSyndrome(block, 26), rdsOffsetWords[0])
	}

	// Flip a bit — should fail
	corrupted := block ^ (1 << 5)
	if r.checkSyndrome(corrupted, 0) {
		t.Errorf("corrupted block A passed syndrome check, block=0x%07X", corrupted)
	}
}

func TestRdsCheckSyndromeBlockB(t *testing.T) {
	r := NewRdsDecoder(240000)

	data := uint32(0x5678)
	block := encodeRdsBlock(data, 1) // block B

	if !r.checkSyndrome(block, 1) {
		t.Errorf("valid block B failed syndrome check")
	}

	// Should fail for wrong block type
	if r.checkSyndrome(block, 0) {
		t.Errorf("block B passed as block A")
	}
}

func TestRdsReset(t *testing.T) {
	r := NewRdsDecoder(240000)

	// Populate some state
	r.pi = 0x1234
	r.ps[0] = 'A'
	r.psValid[0] = true
	r.synced = true
	r.bitCount = 15
	r.errCount = 5

	r.Reset()

	if r.pi != 0 {
		t.Errorf("Reset: pi not cleared")
	}
	if r.ps[0] != 0 {
		t.Errorf("Reset: ps not cleared")
	}
	if r.psValid[0] {
		t.Errorf("Reset: psValid not cleared")
	}
	if r.synced {
		t.Errorf("Reset: synced not cleared")
	}
	if r.bitCount != 0 {
		t.Errorf("Reset: bitCount not cleared")
	}
	if r.errCount != 0 {
		t.Errorf("Reset: errCount not cleared")
	}
}

func TestRdsPSExtraction(t *testing.T) {
	r := NewRdsDecoder(240000)

	// Simulate receiving 4 type-0A groups with PS "TEST FM "
	ps := "TEST FM "
	piCode := uint16(0x1234)

	for segment := 0; segment < 4; segment++ {
		// Block A: PI
		blockA := uint32(piCode)
		// Block B: group type 0A (0000), version A (0), PTY=1, PS segment
		blockB := uint32(0x0000 | (1 << 5) | uint32(segment))
		// Block C: not used for PS in this test
		// Block D: 2 PS chars
		c1 := ps[segment*2]
		c2 := ps[segment*2+1]
		blockD := uint32(c1)<<8 | uint32(c2)

		// Feed as encoded blocks
		r.synced = true
		r.blockIdx = 0

		// Manually inject blocks to test parsing
		r.blockBuf[0] = uint16(blockA)
		r.blockBuf[1] = uint16(blockB)
		r.blockBuf[2] = 0
		r.blockBuf[3] = uint16(blockD)
		r.blockIdx = 3

		// Call parseGroup
		r.parseGroup()
	}

	got := r.CurrentPS()
	want := "TEST FM"
	if got != want {
		t.Errorf("PS extraction: got %q, want %q", got, want)
	}

	if r.pi != piCode {
		t.Errorf("PI code: got 0x%04X, want 0x%04X", r.pi, piCode)
	}
}

func TestRdsRTExtraction(t *testing.T) {
	r := NewRdsDecoder(240000)

	// Simulate receiving type-2A groups with RT "Hello World"
	rt := "Hello World\x0D   " // 0x0D terminates
	piCode := uint16(0xABCD)

	segments := (len(rt) + 3) / 4
	for segment := 0; segment < segments; segment++ {
		// Block B: group type 2A (0010 0), PTY=5, RT segment
		blockB := uint32(0x2000 | (5 << 5) | uint32(segment))

		// Block C: 2 chars
		idx := segment * 4
		var c1, c2, c3, c4 byte
		if idx < len(rt) {
			c1 = rt[idx]
		}
		if idx+1 < len(rt) {
			c2 = rt[idx+1]
		}
		if idx+2 < len(rt) {
			c3 = rt[idx+2]
		}
		if idx+3 < len(rt) {
			c4 = rt[idx+3]
		}
		blockC := uint32(c1)<<8 | uint32(c2)
		blockD := uint32(c3)<<8 | uint32(c4)

		r.blockBuf[0] = piCode
		r.blockBuf[1] = uint16(blockB)
		r.blockBuf[2] = uint16(blockC)
		r.blockBuf[3] = uint16(blockD)
		r.blockIdx = 3

		r.parseGroup()
	}

	got := r.CurrentRT()
	want := "Hello World"
	if got != want {
		t.Errorf("RT extraction: got %q, want %q", got, want)
	}
}

func TestRdsNewDecoder(t *testing.T) {
	r := NewRdsDecoder(240000)
	if r == nil {
		t.Fatal("NewRdsDecoder returned nil")
	}
	if r.sampleRate != 240000 {
		t.Errorf("sampleRate: got %v, want 240000", r.sampleRate)
	}
	if r.synced {
		t.Error("new decoder should not be synced")
	}
}

func TestRdsProcessEmptyInput(t *testing.T) {
	r := NewRdsDecoder(240000)
	result := r.Process(nil)
	if result != nil {
		t.Error("Process(nil) should return nil")
	}
	result = r.Process([]float32{})
	if result != nil {
		t.Error("Process([]) should return nil")
	}
}

func TestSanitizeChar(t *testing.T) {
	tests := []struct {
		in   byte
		want byte
	}{
		{'A', 'A'},
		{' ', ' '},
		{'~', '~'},
		{0x00, ' '},
		{0x1F, ' '},
		{0x7F, ' '},
		{0x0D, 0x0D}, // CR is valid
	}
	for _, tt := range tests {
		got := sanitizeChar(tt.in)
		if got != tt.want {
			t.Errorf("sanitizeChar(0x%02X): got 0x%02X, want 0x%02X", tt.in, got, tt.want)
		}
	}
}

// encodeRdsBlock creates a 26-bit block from 16-bit data with CRC + offset for given block type.
// The resulting syndrome of the full 26-bit block will equal the offset word.
func encodeRdsBlock(data16 uint32, blockType int) uint32 {
	data := data16 & 0xFFFF

	// Compute CRC over 16 data bits using calcSyndrome(data, 16)
	crc := rdsComputeSyndrome(data, 16)

	// Check word = CRC XOR offset word
	checkword := crc ^ rdsOffsetWords[blockType]

	// Assemble 26-bit block: 16 data bits (MSB) | 10 check bits (LSB)
	block := (data << 10) | uint32(checkword)

	return block
}
