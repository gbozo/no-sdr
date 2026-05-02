// ============================================================
// node-sdr — RDS (Radio Data System) Decoder  [server-side]
// ============================================================
// Pure TypeScript implementation of RDS decoding from FM composite
// signal. No browser dependencies — runs in Node.js.
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
}

export function emptyRdsData(): RdsData {
  return {
    pi: null, ps: '', rt: '', pty: null, ptyName: '',
    tp: false, ta: false, ms: false, ct: '', af: [], synced: false,
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

// PTY names (RDS standard, Europe)
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
      const syndrome = calculateSyndrome(this.register);
      const offset = getOffsetForSyndrome(syndrome);
      if (offset !== 'invalid') {
        this.synced = true;
        this.blockIndex = offsetToIndex(offset);
        this.expectedOffset = nextOffset(offset);
        this.bitCount = 0;
        this.errorCount = 0;
        this.goodBlocks = 1;
        this.group = [null, null, null, null];
        this.group[this.blockIndex] = (this.register >> 10) & 0xFFFF;
        this.blockIndex = (this.blockIndex + 1) % 4;
      }
      return null;
    }

    this.bitCount++;
    if (this.bitCount < 26) return null;
    this.bitCount = 0;

    const syndrome = calculateSyndrome(this.register);
    let offset = getOffsetForSyndrome(syndrome);

    if (this.expectedOffset === 'C' && offset === 'Cprime') {
      // valid
    } else if (offset !== this.expectedOffset) {
      offset = 'invalid';
    }

    if (offset !== 'invalid') {
      this.group[this.blockIndex] = (this.register >> 10) & 0xFFFF;
      this.errorCount = 0;
      this.goodBlocks++;
    } else {
      this.group[this.blockIndex] = null;
      this.errorCount++;
      if (this.errorCount > this.MAX_ERRORS) {
        this.synced = false;
        this.goodBlocks = 0;
        return null;
      }
    }

    this.expectedOffset = nextOffset(this.expectedOffset);
    this.blockIndex = (this.blockIndex + 1) % 4;

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
  if (code >= 0x20 && code <= 0x7E) return String.fromCharCode(code);
  if (code === 0x0D) return '\r';
  return ' ';
}

class GroupParser {
  private psChars: string[] = Array(8).fill(' ');
  private rtChars: string[] = Array(64).fill(' ');
  private rtAbFlag = -1;

  parse(group: (number | null)[], data: RdsData): void {
    const [blockA, blockB, blockC, blockD] = group;

    if (blockA !== null) {
      data.pi = blockA;
    }

    if (blockB === null) return;

    const groupType = (blockB >> 12) & 0xF;
    const versionB = (blockB >> 11) & 1;
    const tp = !!((blockB >> 10) & 1);
    const pty = (blockB >> 5) & 0x1F;

    data.tp = tp;
    data.pty = pty;
    data.ptyName = PTY_NAMES[pty] || 'Unknown';

    switch (groupType) {
      case 0:
        this.parseGroup0(blockB, blockC, blockD, data, versionB);
        break;
      case 2:
        this.parseGroup2(blockB, blockC, blockD, data, versionB);
        break;
      case 4:
        if (versionB === 0) this.parseGroup4A(blockB, blockC, blockD, data);
        break;
    }
  }

  private parseGroup0(
    b: number, c: number | null, d: number | null, data: RdsData, versionB: number,
  ): void {
    const segAddr = b & 0x3;
    data.ta = !!((b >> 4) & 1);
    data.ms = !!((b >> 3) & 1);

    if (versionB === 0 && c !== null) {
      const af1Code = (c >> 8) & 0xFF;
      const af2Code = c & 0xFF;
      this.decodeAF(af1Code, data);
      this.decodeAF(af2Code, data);
    }

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

    if (this.rtAbFlag !== -1 && abFlag !== this.rtAbFlag) {
      this.rtChars.fill(' ');
    }
    this.rtAbFlag = abFlag;

    if (versionB === 0) {
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
      const pos = segAddr * 2;
      if (d !== null) {
        this.rtChars[pos] = rdsChar((d >> 8) & 0xFF);
        this.rtChars[pos + 1] = rdsChar(d & 0xFF);
      }
    }

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
      const freqMhz = 87.6 + code * 0.1;
      if (!data.af.includes(freqMhz)) {
        data.af.push(freqMhz);
        data.af.sort((a, b) => a - b);
      }
    }
  }

  reset(): void {
    this.psChars.fill(' ');
    this.rtChars.fill(' ');
    this.rtAbFlag = -1;
  }
}

// ---- Symbol Sync (early-late gate) ----

class SymbolSync {
  private samplesPerSymbol: number;
  private phase = 0;
  private prevSample = 0;
  private accumulator = 0;
  private sampleCount = 0;

  constructor(sampleRate: number) {
    this.samplesPerSymbol = sampleRate / (RDS_BITRATE * 2);
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

      if ((this.prevSample > 0) !== (symbolValue > 0)) {
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
  private clockHistory: Float64Array;
  private readonly WINDOW = 128;

  constructor() {
    this.clockHistory = new Float64Array(this.WINDOW);
  }

  push(pskSymbol: number): boolean | null {
    const diff = pskSymbol * this.prevSymbol;
    const hasTransition = diff < 0;
    const energy = Math.abs(pskSymbol - this.prevSymbol);

    const idx = this.clock % this.WINDOW;
    this.clockHistory[idx] = energy;

    const isDataPhase = (this.clock % 2) === this.clockPolarity;

    this.clock++;

    if (this.clock >= this.WINDOW) {
      let evenSum = 0, oddSum = 0;
      for (let i = 0; i < this.WINDOW; i += 2) {
        evenSum += this.clockHistory[i];
        oddSum += this.clockHistory[i + 1];
      }
      this.clockPolarity = evenSum > oddSum ? 0 : 1;
      this.clock = 0;
    }

    this.prevSymbol = pskSymbol;

    if (isDataPhase) {
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
  private bpf1: Biquad;
  private bpf2: Biquad;
  private lpfI: Biquad;
  private lpfQ: Biquad;

  private ncoPhase = 0;
  private ncoPhaseInc: number;

  // NCO lookup table — replaces Math.cos(ncoPhase) at 240 kHz.
  // 4096 entries, power-of-2 for bitwise-AND index wrap.
  private readonly ncoTableSize = 4096;
  private readonly ncoTableMask = 4095;
  private readonly ncoTableScale: number;
  private readonly ncoCosTable: Float32Array;

  private decimateCounter = 0;
  private readonly DECIMATE: number;
  private readonly decimatedRate: number;

  private symbolSync: SymbolSync;
  private biphaseDecoder = new BiphaseDecoder();
  private deltaDecoder = new DeltaDecoder();
  private blockSync = new BlockSync();
  private groupParser = new GroupParser();

  private data: RdsData;
  private onData?: (data: RdsData) => void;

  constructor(sampleRate = 240000) {
    this.bpf1 = Biquad.bandpass(RDS_SUBCARRIER_HZ, 10, sampleRate);
    this.bpf2 = Biquad.bandpass(RDS_SUBCARRIER_HZ, 10, sampleRate);

    this.ncoPhaseInc = 2 * Math.PI * RDS_SUBCARRIER_HZ / sampleRate;

    // Build NCO cosine table
    this.ncoTableScale = this.ncoTableSize / (2 * Math.PI);
    this.ncoCosTable = new Float32Array(this.ncoTableSize);
    for (let i = 0; i < this.ncoTableSize; i++) {
      this.ncoCosTable[i] = Math.cos((2 * Math.PI * i) / this.ncoTableSize);
    }

    this.DECIMATE = 10;
    this.decimatedRate = sampleRate / this.DECIMATE;

    this.lpfI = Biquad.lowpass(2400, 0.707, this.decimatedRate);
    this.lpfQ = Biquad.lowpass(2400, 0.707, this.decimatedRate);

    this.symbolSync = new SymbolSync(this.decimatedRate);

    this.data = emptyRdsData();
  }

  /** Feed one composite (MPX) sample at 240 kHz */
  pushSample(composite: number): void {
    let filtered = this.bpf1.process(composite);
    filtered = this.bpf2.process(filtered);

    // NCO table lookup replaces Math.cos(ncoPhase) — 240,000 calls/sec eliminated
    const idx = ((this.ncoPhase * this.ncoTableScale + 0.5) | 0) & this.ncoTableMask;
    const iRaw = filtered * this.ncoCosTable[idx];
    this.ncoPhase += this.ncoPhaseInc;
    if (this.ncoPhase > 6.283185307179586) this.ncoPhase -= 6.283185307179586;

    this.decimateCounter++;
    if (this.decimateCounter < this.DECIMATE) return;
    this.decimateCounter = 0;

    const iBase = this.lpfI.process(iRaw);

    const symbol = this.symbolSync.push(iBase);
    if (symbol === null) return;

    const biphase = this.biphaseDecoder.push(symbol);
    if (biphase === null) return;

    const bit = this.deltaDecoder.decode(biphase);

    const group = this.blockSync.pushBit(bit);
    this.data.synced = this.blockSync.isSynced;

    if (group === null) return;

    this.groupParser.parse(group, this.data);

    this.onData?.(this.data);
  }

  /** Process a batch of composite samples */
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
