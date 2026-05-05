// ============================================================
// node-sdr — RDS (Radio Data System) Decoder
// ============================================================
// Pure TypeScript implementation of RDS decoding from FM composite
// signal. Extracts PS name, RadioText, PTY, PI code, CT, and more.
//
// Signal chain:
//   composite (240kHz) → BPF 57kHz → NCO mix → LPF 2.4kHz
//   → decimate ÷10 → symbol sync → biphase decode → delta decode
//   → block sync (CRC) → group parser → RDS data
// ============================================================

// ---- RDS Data Interface ----

export interface RdsData {
  pi: number | null;            // Programme Identification (16-bit)
  ps: string;                   // Programme Service name (8 chars)
  rt: string;                   // RadioText (up to 64 chars)
  pty: number | null;           // Programme Type (0-31)
  ptyName: string;              // PTY label
  tp: boolean;                  // Traffic Programme
  ta: boolean;                  // Traffic Announcement
  ms: boolean;                  // Music/Speech (true=music)
  ct: string;                   // Clock Time (ISO-ish)
  af: number[];                 // Alternative Frequencies (MHz)
  synced: boolean;              // Block sync acquired
  ecc: number | null;           // Extended Country Code (group 1A)
  ptyn: string;                 // Programme Type Name 8-char (group 10A)
  eon: EonEntry[];              // Enhanced Other Networks (group 14A)
}

export interface EonEntry {
  pi: number;    // PI of other network
  ps: string;    // PS name of other network (8 chars)
  af: number[];  // AFs for the other network (MHz)
}

export function emptyRdsData(): RdsData {
  return {
    pi: null, ps: '', rt: '', pty: null, ptyName: '',
    tp: false, ta: false, ms: false, ct: '', af: [],
    synced: false, ecc: null, ptyn: '', eon: [],
  };
}

// ---- Constants ----

const RDS_SUBCARRIER_HZ = 57000;
const RDS_BITRATE = 1187.5;

// Parity check matrix (IEC 62106, 26 rows for 26-bit block)
const PARITY_MATRIX = [
  0x200, 0x100, 0x080, 0x040, 0x020, 0x010, 0x008, 0x004, 0x002, 0x001,
  0x2DC, 0x16E, 0x0B7, 0x287, 0x39F, 0x313, 0x355, 0x376, 0x1BB, 0x201,
  0x3DC, 0x1EE, 0x0F7, 0x2A7, 0x38F, 0x31B,
];

// Syndromes for each offset word
const SYNDROME_A      = 0x3D8;
const SYNDROME_B      = 0x3D4;
const SYNDROME_C      = 0x25C;
const SYNDROME_CPRIME = 0x3CC;
const SYNDROME_D      = 0x258;

// PTY names (RDS standard, Europe; RBDS US uses different labels)
const PTY_NAMES = [
  'None', 'News', 'Current Affairs', 'Information', 'Sport', 'Education',
  'Drama', 'Culture', 'Science', 'Varied', 'Pop Music', 'Rock Music',
  'Easy Listening', 'Light Classical', 'Serious Classical', 'Other Music',
  'Weather', 'Finance', "Children's", 'Social Affairs', 'Religion',
  'Phone In', 'Travel', 'Leisure', 'Jazz', 'Country', 'National Music',
  'Oldies', 'Folk Music', 'Documentary', 'Alarm Test', 'Alarm',
];

// ---- Syndrome Calculation ----

function calculateSyndrome(block: number): number {
  let syndrome = 0;
  for (let i = 0; i < 26; i++) {
    if ((block >> (25 - i)) & 1) syndrome ^= PARITY_MATRIX[i];
  }
  return syndrome;
}

type Offset = 'A' | 'B' | 'C' | 'Cprime' | 'D' | 'invalid';

function getOffsetForSyndrome(syndrome: number): Offset {
  switch (syndrome) {
    case SYNDROME_A: return 'A';
    case SYNDROME_B: return 'B';
    case SYNDROME_C: return 'C';
    case SYNDROME_CPRIME: return 'Cprime';
    case SYNDROME_D: return 'D';
    default: return 'invalid';
  }
}

function offsetToIndex(offset: Offset): number {
  switch (offset) {
    case 'A': return 0;
    case 'B': return 1;
    case 'C': case 'Cprime': return 2;
    case 'D': return 3;
    default: return 0;
  }
}

function nextOffset(offset: Offset): Offset {
  switch (offset) {
    case 'A': return 'B';
    case 'B': return 'C';
    case 'C': case 'Cprime': return 'D';
    case 'D': return 'A';
    default: return 'A';
  }
}

// ---- Simple 2nd-order IIR Biquad ----
// (Local copy to avoid importing from demodulators)

class Biquad {
  private b0: number; private b1: number; private b2: number;
  private a1: number; private a2: number;
  private z1 = 0; private z2 = 0;

  constructor(b0: number, b1: number, b2: number, a1: number, a2: number) {
    this.b0 = b0; this.b1 = b1; this.b2 = b2;
    this.a1 = a1; this.a2 = a2;
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  reset(): void { this.z1 = 0; this.z2 = 0; }

  static bandpass(freq: number, Q: number, fs: number): Biquad {
    const w0 = 2 * Math.PI * freq / fs;
    const alpha = Math.sin(w0) / (2 * Q);
    const cosW0 = Math.cos(w0);
    const a0 = 1 + alpha;
    return new Biquad(
      alpha / a0, 0, -alpha / a0,
      -2 * cosW0 / a0, (1 - alpha) / a0,
    );
  }

  static lowpass(freq: number, Q: number, fs: number): Biquad {
    const w0 = 2 * Math.PI * freq / fs;
    const alpha = Math.sin(w0) / (2 * Q);
    const cosW0 = Math.cos(w0);
    const a0 = 1 + alpha;
    return new Biquad(
      (1 - cosW0) / 2 / a0,
      (1 - cosW0) / a0,
      (1 - cosW0) / 2 / a0,
      -2 * cosW0 / a0,
      (1 - alpha) / a0,
    );
  }
}

// ---- Block Sync State Machine ----

class BlockSync {
  private register = 0;
  private bitCount = 0;
  private synced = false;
  private expectedOffset: Offset = 'A';
  private group: (number | null)[] = [null, null, null, null];
  private blockIndex = 0;
  private errorCount = 0;
  private readonly MAX_ERRORS = 10;
  private goodBlocks = 0;

  get isSynced(): boolean { return this.synced; }

  pushBit(bit: boolean): (number | null)[] | null {
    this.register = ((this.register << 1) | (bit ? 1 : 0)) & 0x3FFFFFF; // 26-bit

    if (!this.synced) {
      // Acquisition: check every incoming bit
      const syndrome = calculateSyndrome(this.register);
      const offset = getOffsetForSyndrome(syndrome);
      if (offset !== 'invalid') {
        // Found a valid syndrome — start tracking
        this.synced = true;
        this.blockIndex = offsetToIndex(offset);
        this.expectedOffset = nextOffset(offset);
        this.bitCount = 0;
        this.errorCount = 0;
        this.goodBlocks = 1;
        this.group = [null, null, null, null];
        // Store this block's data
        this.group[this.blockIndex] = (this.register >> 10) & 0xFFFF;
        this.blockIndex = (this.blockIndex + 1) % 4;
      }
      return null;
    }

    // Tracking: count 26 bits per block
    this.bitCount++;
    if (this.bitCount < 26) return null;
    this.bitCount = 0;

    const syndrome = calculateSyndrome(this.register);
    let offset = getOffsetForSyndrome(syndrome);

    // Allow C/C' interchangeability
    if (this.expectedOffset === 'C' && offset === 'Cprime') {
      // valid, keep it
    } else if (offset !== this.expectedOffset) {
      offset = 'invalid';
    }

    if (offset !== 'invalid') {
      this.group[this.blockIndex] = (this.register >> 10) & 0xFFFF;
      this.errorCount = 0;
      this.goodBlocks++;
    } else {
      this.group[this.blockIndex] = null; // mark as bad
      this.errorCount++;
      if (this.errorCount > this.MAX_ERRORS) {
        this.synced = false;
        this.goodBlocks = 0;
        return null;
      }
    }

    this.expectedOffset = nextOffset(this.expectedOffset);
    this.blockIndex = (this.blockIndex + 1) % 4;

    // Complete group when we've wrapped to block A
    if (this.blockIndex === 0) {
      const result = [...this.group] as (number | null)[];
      this.group = [null, null, null, null];
      return result;
    }
    return null;
  }

  reset(): void {
    this.register = 0;
    this.bitCount = 0;
    this.synced = false;
    this.expectedOffset = 'A';
    this.group = [null, null, null, null];
    this.blockIndex = 0;
    this.errorCount = 0;
    this.goodBlocks = 0;
  }
}

// ---- Group Parser ----

function rdsChar(code: number): string {
  // RDS character set — mostly ASCII for 0x20-0x7F, with a few exceptions
  if (code >= 0x20 && code <= 0x7E) return String.fromCharCode(code);
  if (code === 0x0D) return '\r'; // carriage return = end of RT
  return ' '; // everything else → space
}

class GroupParser {
  private psChars: string[] = Array(8).fill(' ');
  private rtChars: string[] = Array(64).fill(' ');
  private rtAbFlag = -1;
  private ptynChars: string[] = Array(8).fill(' ');
  private eonMap: Map<number, EonEntry> = new Map();

  parse(group: (number | null)[], data: RdsData): void {
    const [blockA, blockB, blockC, blockD] = group;

    // Block A = PI code (always)
    if (blockA !== null) {
      data.pi = blockA;
    }

    // Block B is required for group type info
    if (blockB === null) return;

    const groupType = (blockB >> 12) & 0xF;
    const versionB = (blockB >> 11) & 1;
    const tp = !!((blockB >> 10) & 1);
    const pty = (blockB >> 5) & 0x1F;

    data.tp = tp;
    data.pty = pty;
    data.ptyName = PTY_NAMES[pty] || 'Unknown';

    switch (groupType) {
      case 0: // 0A / 0B — Basic tuning + PS name
        this.parseGroup0(blockB, blockC, blockD, data, versionB);
        break;
      case 1: // 1A — Programme Item Number + ECC
        if (versionB === 0) this.parseGroup1A(blockC, blockD, data);
        break;
      case 2: // 2A / 2B — RadioText
        this.parseGroup2(blockB, blockC, blockD, data, versionB);
        break;
      case 4: // 4A — Clock Time
        if (versionB === 0) this.parseGroup4A(blockB, blockC, blockD, data);
        break;
      case 10: // 10A — Programme Type Name (PTYN)
        if (versionB === 0) this.parseGroup10A(blockB, blockC, blockD, data);
        break;
      case 14: // 14A / 14B — Enhanced Other Networks
        this.parseGroup14(blockB, blockC, blockD, data, versionB);
        break;
    }
  }

  private parseGroup0(
    b: number, c: number | null, d: number | null, data: RdsData, versionB: number,
  ): void {
    const segAddr = b & 0x3;
    data.ta = !!((b >> 4) & 1);
    data.ms = !!((b >> 3) & 1);

    // AF from block C (0A only)
    if (versionB === 0 && c !== null) {
      const af1Code = (c >> 8) & 0xFF;
      const af2Code = c & 0xFF;
      this.decodeAF(af1Code, data);
      this.decodeAF(af2Code, data);
    }

    // PS chars from block D
    if (d !== null) {
      this.psChars[segAddr * 2] = rdsChar((d >> 8) & 0xFF);
      this.psChars[segAddr * 2 + 1] = rdsChar(d & 0xFF);
      data.ps = this.psChars.join('').trimEnd();
    }
  }

  private parseGroup2(
    b: number, c: number | null, d: number | null, data: RdsData, versionB: number,
  ): void {
    const abFlag = (b >> 4) & 1;
    const segAddr = b & 0xF;

    // A/B flag change → clear RT buffer
    if (this.rtAbFlag !== -1 && abFlag !== this.rtAbFlag) {
      this.rtChars.fill(' ');
    }
    this.rtAbFlag = abFlag;

    if (versionB === 0) {
      // 2A: 4 chars per group (2 from C, 2 from D)
      const pos = segAddr * 4;
      if (c !== null) {
        this.rtChars[pos] = rdsChar((c >> 8) & 0xFF);
        this.rtChars[pos + 1] = rdsChar(c & 0xFF);
      }
      if (d !== null) {
        this.rtChars[pos + 2] = rdsChar((d >> 8) & 0xFF);
        this.rtChars[pos + 3] = rdsChar(d & 0xFF);
      }
    } else {
      // 2B: 2 chars per group (from D only)
      const pos = segAddr * 2;
      if (d !== null) {
        this.rtChars[pos] = rdsChar((d >> 8) & 0xFF);
        this.rtChars[pos + 1] = rdsChar(d & 0xFF);
      }
    }

    // Trim at CR if present
    const str = this.rtChars.join('');
    const crIdx = str.indexOf('\r');
    data.rt = (crIdx >= 0 ? str.substring(0, crIdx) : str).trimEnd();
  }

  private parseGroup4A(
    b: number, c: number | null, d: number | null, data: RdsData,
  ): void {
    if (c === null || d === null) return;

    const mjd = ((b & 0x3) << 15) | ((c >> 1) & 0x7FFF);
    const hour = ((c & 1) << 4) | ((d >> 12) & 0xF);
    const minute = (d >> 6) & 0x3F;
    const offsetSign = (d >> 5) & 1;
    const offsetHalfHours = d & 0x1F;

    // MJD to calendar date
    const yp = Math.floor((mjd - 15078.2) / 365.25);
    const mp = Math.floor((mjd - 14956.1 - Math.floor(yp * 365.25)) / 30.6001);
    const day = mjd - 14956 - Math.floor(yp * 365.25) - Math.floor(mp * 30.6001);
    const month = (mp === 14 || mp === 15) ? mp - 13 : mp - 1;
    const year = (mp === 14 || mp === 15) ? yp + 1901 : yp + 1900;

    const localOffset = (offsetSign ? -1 : 1) * offsetHalfHours * 30;
    const totalMinutes = hour * 60 + minute + localOffset;
    const h = Math.floor(totalMinutes / 60) % 24;
    const m = ((totalMinutes % 60) + 60) % 60;

    data.ct = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ` +
              `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  private decodeAF(code: number, data: RdsData): void {
    if (code >= 1 && code <= 204) {
      const freqMhz = Math.round((87.6 + code * 0.1) * 10) / 10;
      if (!data.af.includes(freqMhz)) {
        data.af.push(freqMhz);
        data.af.sort((a, b) => a - b);
      }
    }
  }

  // Group 1A: Extended Country Code + Language Code
  private parseGroup1A(c: number | null, _d: number | null, data: RdsData): void {
    if (c === null) return;
    // Block C bits 15–8 = Language Code (informational), bits 7–0 = ECC
    data.ecc = c & 0xFF;
  }

  // Group 10A: Programme Type Name (PTYN) — 8-char name, 2 chars per group
  private parseGroup10A(b: number, c: number | null, d: number | null, data: RdsData): void {
    const segAddr = b & 0x1; // bit 0 selects chars 0-1 vs 2-3 of each half
    // A/B flag in bit 4 — if changed, clear the PTYN buffer
    // (simplified: no explicit AB tracking for PTYN)
    if (c !== null) {
      this.ptynChars[segAddr * 4]     = rdsChar((c >> 8) & 0xFF);
      this.ptynChars[segAddr * 4 + 1] = rdsChar(c & 0xFF);
    }
    if (d !== null) {
      this.ptynChars[segAddr * 4 + 2] = rdsChar((d >> 8) & 0xFF);
      this.ptynChars[segAddr * 4 + 3] = rdsChar(d & 0xFF);
    }
    data.ptyn = this.ptynChars.join('').trimEnd();
  }

  // Group 14A: Enhanced Other Networks
  private parseGroup14(
    b: number, c: number | null, d: number | null, data: RdsData, versionB: number,
  ): void {
    const eonPi = d; // Block D = ON PI (other network PI)
    if (eonPi === null) return;

    let entry = this.eonMap.get(eonPi);
    if (!entry) {
      entry = { pi: eonPi, ps: '        ', af: [] };
      this.eonMap.set(eonPi, entry);
    }

    if (versionB === 0) {
      // 14A: variant code in bits 3-0 of block B
      const variant = b & 0x0F;
      if (variant <= 3 && c !== null) {
        // Variants 0-3: PS name segments (2 chars each)
        const chars = entry.ps.padEnd(8, ' ').split('');
        chars[variant * 2]     = rdsChar((c >> 8) & 0xFF);
        chars[variant * 2 + 1] = rdsChar(c & 0xFF);
        entry.ps = chars.join('');
      } else if ((variant >= 4 && variant <= 11) && c !== null) {
        // Variants 4-11: mapped AF pairs
        const af1 = (c >> 8) & 0xFF;
        const af2 = c & 0xFF;
        const addAF = (code: number) => {
          if (code >= 1 && code <= 204) {
            const mhz = Math.round((87.6 + code * 0.1) * 10) / 10;
            if (!entry!.af.includes(mhz)) {
              entry!.af.push(mhz);
              entry!.af.sort((a, b) => a - b);
            }
          }
        };
        addAF(af1);
        addAF(af2);
      }
    }
    // Rebuild EON list for RdsData output
    data.eon = Array.from(this.eonMap.values())
      .map(e => ({ ...e, ps: e.ps.trimEnd() }));
  }

  reset(): void {
    this.psChars.fill(' ');
    this.rtChars.fill(' ');
    this.ptynChars.fill(' ');
    this.rtAbFlag = -1;
    this.eonMap.clear();
  }
}

// ---- Symbol Sync (early-late gate, simplified) ----

class SymbolSync {
  private samplesPerSymbol: number;
  private phase = 0;
  private prevSample = 0;
  private accumulator = 0;
  private sampleCount = 0;

  constructor(sampleRate: number) {
    this.samplesPerSymbol = sampleRate / (RDS_BITRATE * 2); // PSK symbol rate = 2× bit rate
  }

  push(sample: number): number | null {
    this.accumulator += sample;
    this.sampleCount++;
    this.phase += 1.0 / this.samplesPerSymbol;

    if (this.phase >= 1.0) {
      this.phase -= 1.0;
      const symbolValue = this.accumulator / this.sampleCount;
      this.accumulator = 0;
      this.sampleCount = 0;

      // Timing error: use zero-crossing between prev and current
      // Adjust phase slightly
      if ((this.prevSample > 0) !== (symbolValue > 0)) {
        // Zero crossing near boundary — nudge phase
        this.phase += 0.01;
      }
      this.prevSample = symbolValue;
      return symbolValue;
    }
    return null;
  }

  reset(): void {
    this.phase = 0;
    this.prevSample = 0;
    this.accumulator = 0;
    this.sampleCount = 0;
  }
}

// ---- Biphase Decoder (Differential Manchester) ----

class BiphaseDecoder {
  private prevSymbol = 0;
  private clock = 0;
  private clockPolarity = 0;
  private clockHistory: Float32Array;
  private readonly WINDOW = 128;

  constructor() {
    this.clockHistory = new Float32Array(this.WINDOW);
  }

  push(pskSymbol: number): boolean | null {
    // Biphase: transition between consecutive PSK symbols
    const diff = pskSymbol * this.prevSymbol;
    const hasTransition = diff < 0; // sign change
    const energy = Math.abs(pskSymbol - this.prevSymbol);

    const idx = this.clock % this.WINDOW;
    this.clockHistory[idx] = energy;

    const isDataPhase = (this.clock % 2) === this.clockPolarity;

    this.clock++;

    // Periodically re-evaluate clock polarity
    if (this.clock >= this.WINDOW) {
      let evenSum = 0, oddSum = 0;
      for (let i = 0; i < this.WINDOW; i += 2) {
        evenSum += this.clockHistory[i];
        oddSum += this.clockHistory[i + 1];
      }
      // Data transitions have more energy on even or odd symbols
      this.clockPolarity = evenSum > oddSum ? 0 : 1;
      this.clock = 0;
    }

    this.prevSymbol = pskSymbol;

    if (isDataPhase) {
      // Bit value: transition = 1, no transition = 0 (or vice versa — 
      // polarity is resolved by differential decoding)
      return hasTransition;
    }
    return null;
  }

  reset(): void {
    this.prevSymbol = 0;
    this.clock = 0;
    this.clockPolarity = 0;
    this.clockHistory.fill(0);
  }
}

// ---- Delta Decoder (Differential → Absolute) ----

class DeltaDecoder {
  private prev = false;

  decode(bit: boolean): boolean {
    const out = bit !== this.prev;
    this.prev = bit;
    return out;
  }

  reset(): void { this.prev = false; }
}

// ---- Main RDS Decoder ----

export class RdsDecoder {
  // DSP chain
  private bpf1: Biquad;         // narrow BPF at 57 kHz
  private bpf2: Biquad;         // second BPF for sharper response
  private lpfI: Biquad;         // baseband LPF I
  private lpfQ: Biquad;         // baseband LPF Q

  // NCO
  private ncoPhase = 0;
  private ncoPhaseInc: number;

  // Decimation
  private decimateCounter = 0;
  private readonly DECIMATE: number;
  private readonly decimatedRate: number;

  // Demod chain
  private symbolSync: SymbolSync;
  private biphaseDecoder = new BiphaseDecoder();
  private deltaDecoder = new DeltaDecoder();
  private blockSync = new BlockSync();
  private groupParser = new GroupParser();

  // Output
  private data: RdsData;
  private onData?: (data: RdsData) => void;

  constructor(sampleRate = 240000) {
    // Use two cascaded BPFs for sharper selectivity
    this.bpf1 = Biquad.bandpass(RDS_SUBCARRIER_HZ, 10, sampleRate);
    this.bpf2 = Biquad.bandpass(RDS_SUBCARRIER_HZ, 10, sampleRate);

    // NCO at 57 kHz
    this.ncoPhaseInc = 2 * Math.PI * RDS_SUBCARRIER_HZ / sampleRate;

    // Decimation factor: bring to ~24 kHz (enough for 2.4 kHz RDS bandwidth)
    this.DECIMATE = 10;
    this.decimatedRate = sampleRate / this.DECIMATE;

    // LPF at 2.4 kHz (after mix-down to baseband)
    this.lpfI = Biquad.lowpass(2400, 0.707, this.decimatedRate);
    this.lpfQ = Biquad.lowpass(2400, 0.707, this.decimatedRate);

    // Symbol sync at decimated rate
    this.symbolSync = new SymbolSync(this.decimatedRate);

    this.data = emptyRdsData();
  }

  /** Feed one composite (MPX) sample at 240 kHz */
  pushSample(composite: number): void {
    // 1. Bandpass filter at 57 kHz (cascaded for sharper rolloff)
    let filtered = this.bpf1.process(composite);
    filtered = this.bpf2.process(filtered);

    // 2. Mix down to baseband using NCO
    const cosN = Math.cos(this.ncoPhase);
    const sinN = Math.sin(this.ncoPhase);
    const iRaw = filtered * cosN;
    const qRaw = filtered * sinN;
    this.ncoPhase += this.ncoPhaseInc;
    if (this.ncoPhase > 2 * Math.PI) this.ncoPhase -= 2 * Math.PI;

    // 3. Decimate
    this.decimateCounter++;
    if (this.decimateCounter < this.DECIMATE) return;
    this.decimateCounter = 0;

    // 4. LPF the baseband
    const iBase = this.lpfI.process(iRaw);
    // const qBase = this.lpfQ.process(qRaw); // Q channel not strictly needed for BPSK

    // 5. Symbol synchronization
    const symbol = this.symbolSync.push(iBase);
    if (symbol === null) return;

    // 6. Biphase decode
    const biphase = this.biphaseDecoder.push(symbol);
    if (biphase === null) return;

    // 7. Delta decode
    const bit = this.deltaDecoder.decode(biphase);

    // 8. Block sync → group
    const group = this.blockSync.pushBit(bit);
    this.data.synced = this.blockSync.isSynced;

    if (group === null) return;

    // 9. Parse group
    this.groupParser.parse(group, this.data);

    // 10. Notify
    this.onData?.(this.data);
  }

  /** Process a batch of composite samples (more efficient) */
  pushSamples(compositeBuffer: Float32Array | number[], start: number, length: number): void {
    for (let i = 0; i < length; i++) {
      this.pushSample(compositeBuffer[start + i] as number);
    }
  }

  setCallback(cb: (data: RdsData) => void): void {
    this.onData = cb;
  }

  getData(): RdsData {
    return this.data;
  }

  reset(): void {
    this.bpf1.reset();
    this.bpf2.reset();
    this.lpfI.reset();
    this.lpfQ.reset();
    this.ncoPhase = 0;
    this.decimateCounter = 0;
    this.symbolSync.reset();
    this.biphaseDecoder.reset();
    this.deltaDecoder.reset();
    this.blockSync.reset();
    this.groupParser.reset();
    this.data = emptyRdsData();
  }
}
