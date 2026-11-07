//! RDS (Radio Data System) decoder for FM broadcast.
//!
//! Mirrors `serverng/internal/demod/rds.go` and the TypeScript client decoder.

use std::collections::HashMap;
use std::f64::consts::PI;

use serde::{Deserialize, Serialize};

/// PTY names per RDS standard (Europe). Index = PTY code 0–31.
pub const PTY_NAMES: [&str; 32] = [
    "None",
    "News",
    "Current Affairs",
    "Information",
    "Sport",
    "Education",
    "Drama",
    "Culture",
    "Science",
    "Varied",
    "Pop Music",
    "Rock Music",
    "Easy Listening",
    "Light Classical",
    "Serious Classical",
    "Other Music",
    "Weather",
    "Finance",
    "Children's",
    "Social Affairs",
    "Religion",
    "Phone In",
    "Travel",
    "Leisure",
    "Jazz",
    "Country",
    "National Music",
    "Oldies",
    "Folk Music",
    "Documentary",
    "Alarm Test",
    "Alarm",
];

/// Station clock from group 4A.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdsClock {
    pub year: i32,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
    /// Signed offset from UTC in half-hours (+4 = UTC+02:00).
    pub offset_half_hours: i8,
}

/// One Enhanced Other Network entry (group 14A).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EonEntry {
    pub pi: u16,
    pub ps: String,
    pub af: Vec<f32>,
}

/// Decoded RDS information. Field names match the TypeScript `RdsData`
/// interface consumed by the client.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdsData {
    pub ps: String,
    pub rt: String,
    pub pi: u16,
    pub pty: u8,
    pub pty_name: String,
    pub synced: bool,
    pub ecc: Option<u8>,
    pub ptyn: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clock: Option<RdsClock>,
    pub eon: Vec<EonEntry>,
}

impl Default for RdsData {
    fn default() -> Self {
        Self {
            ps: String::new(),
            rt: String::new(),
            pi: 0,
            pty: 0,
            pty_name: String::new(),
            synced: false,
            ecc: None,
            ptyn: String::new(),
            clock: None,
            eon: Vec::new(),
        }
    }
}

// ---- Biquad filter (transposed direct form II) ----

#[derive(Clone, Copy, Debug, Default)]
struct BiquadCoeffs {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}

#[derive(Clone, Copy, Debug, Default)]
struct BiquadState {
    z1: f64,
    z2: f64,
}

impl BiquadState {
    fn process(&mut self, x: f64, c: &BiquadCoeffs) -> f64 {
        let y = c.b0 * x + self.z1;
        self.z1 = c.b1 * x - c.a1 * y + self.z2;
        self.z2 = c.b2 * x - c.a2 * y;
        y
    }
}

fn bandpass_coeffs(freq: f64, q: f64, fs: f64) -> BiquadCoeffs {
    let w0 = 2.0 * PI * freq / fs;
    let alpha = w0.sin() / (2.0 * q);
    let cos_w0 = w0.cos();
    let a0 = 1.0 + alpha;
    BiquadCoeffs {
        b0: alpha / a0,
        b1: 0.0,
        b2: -alpha / a0,
        a1: -2.0 * cos_w0 / a0,
        a2: (1.0 - alpha) / a0,
    }
}

fn lowpass_coeffs(freq: f64, q: f64, fs: f64) -> BiquadCoeffs {
    let w0 = 2.0 * PI * freq / fs;
    let alpha = w0.sin() / (2.0 * q);
    let cos_w0 = w0.cos();
    let a0 = 1.0 + alpha;
    BiquadCoeffs {
        b0: (1.0 - cos_w0) / 2.0 / a0,
        b1: (1.0 - cos_w0) / a0,
        b2: (1.0 - cos_w0) / 2.0 / a0,
        a1: -2.0 * cos_w0 / a0,
        a2: (1.0 - alpha) / a0,
    }
}

// ---- Symbol sync (Gardner TED) ----

struct SymbolSync {
    samples_per_symbol: f64,
    phase: f64,
    accumulator: f64,
    sample_count: usize,
    prev_symbol_value: f64,
    mid_sample: f64,
    half_symbol_phase: f64,
    mid_captured: bool,
    loop_gain: f64,
    loop_beta: f64,
    freq_offset: f64,
}

impl SymbolSync {
    fn new(decimated_rate: f64) -> Self {
        let sps = decimated_rate / (RDS_BITRATE * 2.0);
        let blts = 0.01;
        let damping = 1.0;
        let denominator = 1.0 + 2.0 * damping * blts + blts * blts;
        Self {
            samples_per_symbol: sps,
            phase: 0.0,
            accumulator: 0.0,
            sample_count: 0,
            prev_symbol_value: 0.0,
            mid_sample: 0.0,
            half_symbol_phase: 0.0,
            mid_captured: false,
            loop_gain: (4.0 * damping * blts) / denominator,
            loop_beta: (4.0 * blts * blts) / denominator,
            freq_offset: 0.0,
        }
    }

    /// Returns the symbol value at the symbol clock boundary when one is due.
    fn push(&mut self, sample: f64) -> Option<f64> {
        self.accumulator += sample;
        self.sample_count += 1;
        self.phase += 1.0 / self.samples_per_symbol;
        self.half_symbol_phase += 1.0 / self.samples_per_symbol;

        if !self.mid_captured && self.half_symbol_phase >= 0.5 {
            if self.sample_count > 0 {
                self.mid_sample = self.accumulator / self.sample_count as f64;
            }
            self.mid_captured = true;
        }

        if self.phase >= 1.0 {
            self.phase -= 1.0;
            self.half_symbol_phase = 0.0;
            let sym = self.accumulator / self.sample_count as f64;
            self.accumulator = 0.0;
            self.sample_count = 0;
            self.mid_captured = false;

            // Gardner TED.
            let ted = (self.prev_symbol_value - sym) * self.mid_sample;

            // PI loop filter.
            self.freq_offset += self.loop_beta * ted;
            let mut phase_adj = self.loop_gain * ted + self.freq_offset;

            let max_adj = 0.3 / self.samples_per_symbol;
            phase_adj = phase_adj.clamp(-max_adj, max_adj);
            self.phase += phase_adj;

            self.prev_symbol_value = sym;
            return Some(sym);
        }
        None
    }

    fn reset(&mut self) {
        self.phase = 0.0;
        self.prev_symbol_value = 0.0;
        self.mid_sample = 0.0;
        self.half_symbol_phase = 0.0;
        self.mid_captured = false;
        self.accumulator = 0.0;
        self.sample_count = 0;
        self.freq_offset = 0.0;
    }
}

// ---- Biphase decoder (clock polarity tracking) ----

const BIPHASE_WINDOW: usize = 128;

struct BiphaseDecoder {
    prev_symbol: f64,
    clock: usize,
    clock_polarity: usize,
    history: [f64; BIPHASE_WINDOW],
}

impl BiphaseDecoder {
    fn new() -> Self {
        Self {
            prev_symbol: 0.0,
            clock: 0,
            clock_polarity: 0,
            history: [0.0; BIPHASE_WINDOW],
        }
    }

    /// Returns `Some(bit)` at the data phase, `None` at the reference phase.
    fn push(&mut self, sym: f64) -> Option<bool> {
        let diff = sym * self.prev_symbol;
        let has_transition = diff < 0.0;
        let energy = (sym - self.prev_symbol).abs();

        let idx = self.clock % BIPHASE_WINDOW;
        self.history[idx] = energy;

        let is_data_phase = (self.clock % 2) == self.clock_polarity;
        self.clock += 1;

        if self.clock >= BIPHASE_WINDOW {
            let mut even_sum = 0.0;
            let mut odd_sum = 0.0;
            let mut i = 0;
            while i < BIPHASE_WINDOW {
                even_sum += self.history[i];
                if i + 1 < BIPHASE_WINDOW {
                    odd_sum += self.history[i + 1];
                }
                i += 2;
            }
            self.clock_polarity = if even_sum > odd_sum { 0 } else { 1 };
            self.clock = 0;
        }

        self.prev_symbol = sym;

        if is_data_phase {
            Some(has_transition)
        } else {
            None
        }
    }

    fn reset(&mut self) {
        self.prev_symbol = 0.0;
        self.clock = 0;
        self.clock_polarity = 0;
        self.history = [0.0; BIPHASE_WINDOW];
    }
}

// ---- Delta decoder ----

struct DeltaDecoder {
    prev: bool,
}

impl DeltaDecoder {
    fn new() -> Self {
        Self { prev: false }
    }

    fn decode(&mut self, bit: bool) -> bool {
        let out = bit != self.prev;
        self.prev = bit;
        out
    }

    fn reset(&mut self) {
        self.prev = false;
    }
}

// ---- Block sync ----

/// RDS parity check matrix (IEC 62106, 26 rows).
const PARITY_MATRIX: [u32; 26] = [
    0x200, 0x100, 0x080, 0x040, 0x020, 0x010, 0x008, 0x004, 0x002, 0x001, 0x2DC, 0x16E, 0x0B7,
    0x287, 0x39F, 0x313, 0x355, 0x376, 0x1BB, 0x201, 0x3DC, 0x1EE, 0x0F7, 0x2A7, 0x38F, 0x31B,
];

const SYNDROME_A: u32 = 0x3D8;
const SYNDROME_B: u32 = 0x3D4;
const SYNDROME_C: u32 = 0x25C;
const SYNDROME_C_PRIME: u32 = 0x3CC;
const SYNDROME_D: u32 = 0x258;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RdsSyndrome {
    Invalid,
    A,
    B,
    C,
    CPrime,
    D,
}

/// Longest error burst corrected in tracking. Two covers the single-bit and
/// adjacent-pair errors a marginal signal produces while leaving enough unused
/// syndromes that noise cannot hold sync indefinitely (the same trade-off the
/// sdroxide decoder documents).
const MAX_BURST: usize = 2;

/// Syndrome -> error pattern for every burst of up to [`MAX_BURST`] bits.
fn burst_table() -> &'static std::collections::HashMap<u32, u32> {
    use std::sync::OnceLock;
    static TABLE: OnceLock<std::collections::HashMap<u32, u32>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut map = std::collections::HashMap::new();
        for len in 1..=MAX_BURST {
            let interior = if len <= 2 { 1u32 } else { 1 << (len - 2) };
            for fill in 0..interior {
                let pattern = if len == 1 {
                    1u32
                } else {
                    1 | (fill << 1) | (1 << (len - 1))
                };
                for pos in 0..=(26 - len) {
                    let err = pattern << pos;
                    map.entry(calculate_syndrome(err)).or_insert(err);
                }
            }
        }
        map
    })
}

fn syndrome_for_offset(s: RdsSyndrome) -> u32 {
    match s {
        RdsSyndrome::A => SYNDROME_A,
        RdsSyndrome::B => SYNDROME_B,
        RdsSyndrome::C => SYNDROME_C,
        RdsSyndrome::CPrime => SYNDROME_C_PRIME,
        RdsSyndrome::D => SYNDROME_D,
        RdsSyndrome::Invalid => 0,
    }
}

fn try_correct_block(register: u32, expected: RdsSyndrome) -> Option<u32> {
    let syndrome = calculate_syndrome(register);
    let table = burst_table();

    let try_expected = |want: u32| -> Option<u32> {
        let error_syn = syndrome ^ want;
        // Bursts of up to MAX_BURST bits (includes the old single-bit cases).
        table.get(&error_syn).map(|err| register ^ err)
    };

    if let Some(fixed) = try_expected(syndrome_for_offset(expected)) {
        return Some(fixed);
    }
    if expected == RdsSyndrome::C {
        if let Some(fixed) = try_expected(SYNDROME_C_PRIME) {
            return Some(fixed);
        }
    }
    None
}

fn calculate_syndrome(block: u32) -> u32 {
    let mut syndrome = 0u32;
    for i in 0..26 {
        if (block >> (25 - i)) & 1 != 0 {
            syndrome ^= PARITY_MATRIX[i];
        }
    }
    syndrome
}

fn get_syndrome(block: u32) -> RdsSyndrome {
    match calculate_syndrome(block) {
        SYNDROME_A => RdsSyndrome::A,
        SYNDROME_B => RdsSyndrome::B,
        SYNDROME_C => RdsSyndrome::C,
        SYNDROME_C_PRIME => RdsSyndrome::CPrime,
        SYNDROME_D => RdsSyndrome::D,
        _ => RdsSyndrome::Invalid,
    }
}

fn syndrome_to_index(s: RdsSyndrome) -> usize {
    match s {
        RdsSyndrome::A => 0,
        RdsSyndrome::B => 1,
        RdsSyndrome::C | RdsSyndrome::CPrime => 2,
        RdsSyndrome::D => 3,
        RdsSyndrome::Invalid => 0,
    }
}

fn next_syndrome(s: RdsSyndrome) -> RdsSyndrome {
    match s {
        RdsSyndrome::A => RdsSyndrome::B,
        RdsSyndrome::B => RdsSyndrome::C,
        RdsSyndrome::C | RdsSyndrome::CPrime => RdsSyndrome::D,
        RdsSyndrome::D => RdsSyndrome::A,
        RdsSyndrome::Invalid => RdsSyndrome::A,
    }
}

const MAX_BLOCK_ERRORS: usize = 10;

struct BlockSync {
    register: u32,
    bit_count: usize,
    synced: bool,
    expected_offset: RdsSyndrome,
    group: [i32; 4],
    block_index: usize,
    error_count: usize,
    good_blocks: usize,
}

impl BlockSync {
    fn new() -> Self {
        Self {
            register: 0,
            bit_count: 0,
            synced: false,
            expected_offset: RdsSyndrome::A,
            group: [-1; 4],
            block_index: 0,
            error_count: 0,
            good_blocks: 0,
        }
    }

    /// Returns a complete 4-block group when assembled.
    fn push_bit(&mut self, bit: bool) -> Option<[i32; 4]> {
        let one = u32::from(bit);
        self.register = ((self.register << 1) | one) & 0x03FF_FFFF;

        if !self.synced {
            let syn = get_syndrome(self.register);
            if syn != RdsSyndrome::Invalid {
                self.synced = true;
                self.block_index = syndrome_to_index(syn);
                self.expected_offset = next_syndrome(syn);
                self.bit_count = 0;
                self.error_count = 0;
                self.good_blocks = 1;
                self.group = [-1; 4];
                self.group[self.block_index] = ((self.register >> 10) & 0xFFFF) as i32;
                self.block_index = (self.block_index + 1) % 4;
            }
            return None;
        }

        // Tracking: count 26 bits per block.
        self.bit_count += 1;
        if self.bit_count < 26 {
            return None;
        }
        self.bit_count = 0;

        let syn = get_syndrome(self.register);
        let mut offset = RdsSyndrome::Invalid;

        if self.expected_offset == RdsSyndrome::C && syn == RdsSyndrome::CPrime {
            offset = RdsSyndrome::CPrime;
        } else if syn == self.expected_offset {
            offset = syn;
        }

        if offset != RdsSyndrome::Invalid {
            self.group[self.block_index] = ((self.register >> 10) & 0xFFFF) as i32;
            self.error_count = 0;
            self.good_blocks += 1;
        } else if let Some(corrected) = try_correct_block(self.register, self.expected_offset) {
            self.group[self.block_index] = ((corrected >> 10) & 0xFFFF) as i32;
            self.error_count = 0;
            self.good_blocks += 1;
        } else {
            self.group[self.block_index] = -1;
            self.error_count += 1;
            if self.error_count > MAX_BLOCK_ERRORS {
                self.synced = false;
                self.good_blocks = 0;
                return None;
            }
        }

        self.expected_offset = next_syndrome(self.expected_offset);
        self.block_index = (self.block_index + 1) % 4;

        if self.block_index == 0 {
            let result = self.group;
            self.group = [-1; 4];
            return Some(result);
        }
        None
    }

    fn reset(&mut self) {
        self.register = 0;
        self.bit_count = 0;
        self.synced = false;
        self.expected_offset = RdsSyndrome::A;
        self.group = [-1; 4];
        self.block_index = 0;
        self.error_count = 0;
        self.good_blocks = 0;
    }
}

// ---- Group parser ----

struct GroupParser {
    ps_chars: [u8; 8],
    rt_chars: [u8; 64],
    rt_ab_flag: i32,
    ptyn_chars: [u8; 8],
    eon_map: HashMap<u16, EonEntry>,
}

impl GroupParser {
    fn new() -> Self {
        Self {
            ps_chars: [b' '; 8],
            rt_chars: [b' '; 64],
            rt_ab_flag: -1,
            ptyn_chars: [b' '; 8],
            eon_map: HashMap::new(),
        }
    }

    fn parse(&mut self, group: [i32; 4], data: &mut RdsData) {
        let block_a = group[0];
        let block_b = group[1];
        let block_c = group[2];
        let block_d = group[3];

        if block_a != -1 {
            data.pi = block_a as u16;
        }
        if block_b == -1 {
            return;
        }

        let group_type = ((block_b >> 12) & 0x0F) as u8;
        let version_b = ((block_b >> 11) & 1) == 1;
        let pty = ((block_b >> 5) & 0x1F) as u8;
        data.pty = pty;
        data.pty_name = PTY_NAMES
            .get(pty as usize)
            .copied()
            .unwrap_or("Unknown")
            .to_string();

        match group_type {
            0 => {
                // Type 0A/0B: Programme Service name.
                if block_d != -1 {
                    let segment = (block_b & 0x03) as usize;
                    let idx = segment * 2;
                    if idx < 8 {
                        self.ps_chars[idx] = rds_char(((block_d >> 8) & 0xFF) as u8);
                        self.ps_chars[idx + 1] = rds_char((block_d & 0xFF) as u8);
                    }
                    data.ps = trim_right(&self.ps_chars, &[b' ', 0x00]);
                }
            }
            1 => {
                // Type 1A: Programme Item Number + Extended Country Code.
                if !version_b && block_c != -1 {
                    data.ecc = Some((block_c & 0xFF) as u8);
                }
            }
            2 => {
                // Type 2A/2B: RadioText.
                let seg_bits: i32 = if version_b { 0x1F } else { 0x0F };
                let segment = (block_b & seg_bits) as usize;
                let ab_flag = ((block_b >> 4) & 1) as i32;
                if self.rt_ab_flag != ab_flag {
                    self.rt_chars = [b' '; 64];
                    self.rt_ab_flag = ab_flag;
                }
                if version_b {
                    if block_d != -1 {
                        let idx = segment * 2;
                        if idx < 62 {
                            self.rt_chars[idx] = rds_char(((block_d >> 8) & 0xFF) as u8);
                            self.rt_chars[idx + 1] = rds_char((block_d & 0xFF) as u8);
                        }
                    }
                } else if block_c != -1 && block_d != -1 {
                    let idx = segment * 4;
                    if idx < 60 {
                        self.rt_chars[idx] = rds_char(((block_c >> 8) & 0xFF) as u8);
                        self.rt_chars[idx + 1] = rds_char((block_c & 0xFF) as u8);
                        self.rt_chars[idx + 2] = rds_char(((block_d >> 8) & 0xFF) as u8);
                        self.rt_chars[idx + 3] = rds_char((block_d & 0xFF) as u8);
                    }
                }
                let mut rt_end = 64usize;
                for (i, &b) in self.rt_chars.iter().enumerate() {
                    if b == 0x0D || b == 0 {
                        rt_end = i;
                        break;
                    }
                }
                data.rt = trim_right(&self.rt_chars[..rt_end], &[b' ', 0x00, 0x0D]);
            }
            4 => {
                // Type 4A: station clock (MJD + UTC time + local offset).
                if !version_b && block_c != -1 && block_d != -1 {
                    let b = block_b as u32;
                    let c = block_c as u32;
                    let d = block_d as u32;
                    let mjd = ((b & 0x3) << 15) | (c >> 1);
                    let hour = (((c & 1) << 4) | (d >> 12)) as u8;
                    let minute = ((d >> 6) & 0x3f) as u8;
                    let half_hours = (d & 0x1f) as i8;
                    let offset = if d & 0x20 != 0 { -half_hours } else { half_hours };
                    if hour <= 23 && minute <= 59 && (15_079..=88_127).contains(&mjd) {
                        if let Some((year, month, day)) = mjd_to_date(mjd) {
                            data.clock = Some(RdsClock {
                                year,
                                month,
                                day,
                                hour,
                                minute,
                                offset_half_hours: offset,
                            });
                        }
                    }
                }
            }
            10 => {
                // Type 10A: Programme Type Name (PTYN), 8 chars, 4 per group.
                if !version_b {
                    let segment = (block_b & 0x01) as usize;
                    if block_c != -1 {
                        let idx = segment * 4;
                        self.ptyn_chars[idx] = rds_char(((block_c >> 8) & 0xFF) as u8);
                        self.ptyn_chars[idx + 1] = rds_char((block_c & 0xFF) as u8);
                    }
                    if block_d != -1 {
                        let idx = segment * 4 + 2;
                        self.ptyn_chars[idx] = rds_char(((block_d >> 8) & 0xFF) as u8);
                        self.ptyn_chars[idx + 1] = rds_char((block_d & 0xFF) as u8);
                    }
                    data.ptyn = trim_right(&self.ptyn_chars, &[b' ', 0x00]);
                }
            }
            14 => {
                // Type 14A: Enhanced Other Networks.
                if !version_b && block_d != -1 {
                    let on_pi = block_d as u16;
                    let entry = self
                        .eon_map
                        .entry(on_pi)
                        .or_insert_with(|| EonEntry {
                            pi: on_pi,
                            ps: "        ".to_string(),
                            af: Vec::new(),
                        });
                    let variant = (block_b & 0x0F) as usize;
                    if variant <= 3 && block_c != -1 {
                        // PS name: 2 chars per variant.
                        let mut ps_bytes = entry.ps.clone().into_bytes();
                        if ps_bytes.len() < 8 {
                            ps_bytes.resize(8, 0);
                        }
                        ps_bytes[variant * 2] = rds_char(((block_c >> 8) & 0xFF) as u8);
                        ps_bytes[variant * 2 + 1] = rds_char((block_c & 0xFF) as u8);
                        entry.ps = String::from_utf8_lossy(&ps_bytes).into_owned();
                    } else if (4..=11).contains(&variant) && block_c != -1 {
                        // Mapped AFs.
                        let af1 = ((block_c >> 8) & 0xFF) as u8;
                        let af2 = (block_c & 0xFF) as u8;
                        add_af(entry, af1);
                        add_af(entry, af2);
                    }
                    // Rebuild EON slice.
                    data.eon = self
                        .eon_map
                        .values()
                        .map(|e| EonEntry {
                            pi: e.pi,
                            ps: trim_right(e.ps.as_bytes(), &[b' ', 0x00]),
                            af: e.af.clone(),
                        })
                        .collect();
                }
            }
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.ps_chars = [b' '; 8];
        self.rt_chars = [b' '; 64];
        self.ptyn_chars = [b' '; 8];
        self.rt_ab_flag = -1;
        self.eon_map.clear();
    }
}

/// Modified Julian Date to a calendar date (standard RDS arithmetic).
fn mjd_to_date(mjd: u32) -> Option<(i32, u8, u8)> {
    let yp = ((mjd as f64 - 15_078.2) / 365.25) as i32;
    let mp = ((mjd as f64 - 14_956.1 - (yp as f64 * 365.25).floor()) / 30.6001) as i32;
    let day = mjd as i32
        - 14_956
        - (yp as f64 * 365.25).floor() as i32
        - (mp as f64 * 30.6001).floor() as i32;
    let k = i32::from(mp == 14 || mp == 15);
    let year = yp + k + 1900;
    let month = mp - 1 - k * 12;
    if (1..=12).contains(&month) && (1..=31).contains(&day) {
        Some((year, month as u8, day as u8))
    } else {
        None
    }
}

fn add_af(entry: &mut EonEntry, code: u8) {
    if (1..=204).contains(&code) {
        let mut mhz = (87.6 + code as f64 * 0.1) as f32;
        mhz = ((mhz * 10.0 + 0.5) as i32) as f32 / 10.0;
        if !entry.af.contains(&mhz) {
            entry.af.push(mhz);
        }
    }
}

fn rds_char(code: u8) -> u8 {
    if (0x20..=0x7E).contains(&code) {
        return code;
    }
    if code == 0x0D {
        return code; // CR = RadioText terminator
    }
    b' '
}

/// Equivalent of Go's `strings.TrimRight(s, cutset)`.
fn trim_right(bytes: &[u8], cutset: &[u8]) -> String {
    let mut end = bytes.len();
    while end > 0 && cutset.contains(&bytes[end - 1]) {
        end -= 1;
    }
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

// ---- Main RDS decoder ----

const RDS_SUBCARRIER_HZ: f64 = 57_000.0;
const RDS_BITRATE: f64 = 1187.5;
const RDS_DECIMATE: usize = 10;

pub struct RdsDecoder {
    bpf1: BiquadCoeffs,
    bpf1s: BiquadState,
    bpf2: BiquadCoeffs,
    bpf2s: BiquadState,

    nco_phase: f64,
    nco_inc: f64,

    decim_counter: usize,

    lpf_i: BiquadCoeffs,
    lpf_is: BiquadState,

    sym_sync: SymbolSync,
    biphase: BiphaseDecoder,
    delta: DeltaDecoder,
    blk_sync: BlockSync,
    grp_parse: GroupParser,

    data: RdsData,
}

impl RdsDecoder {
    /// Creates a decoder for the given FM composite sample rate (typically 240 kHz).
    pub fn new(sample_rate: f64) -> Self {
        let decimated_rate = sample_rate / RDS_DECIMATE as f64;
        Self {
            bpf1: bandpass_coeffs(RDS_SUBCARRIER_HZ, 10.0, sample_rate),
            bpf1s: BiquadState::default(),
            bpf2: bandpass_coeffs(RDS_SUBCARRIER_HZ, 10.0, sample_rate),
            bpf2s: BiquadState::default(),
            nco_phase: 0.0,
            nco_inc: 2.0 * PI * RDS_SUBCARRIER_HZ / sample_rate,
            decim_counter: 0,
            lpf_i: lowpass_coeffs(2400.0, 0.707, decimated_rate),
            lpf_is: BiquadState::default(),
            sym_sync: SymbolSync::new(decimated_rate),
            biphase: BiphaseDecoder::new(),
            delta: DeltaDecoder::new(),
            blk_sync: BlockSync::new(),
            grp_parse: GroupParser::new(),
            data: RdsData::default(),
        }
    }

    /// Processes FM composite audio. Returns updated data when a new group completed.
    pub fn process(&mut self, composite: &[f32]) -> Option<RdsData> {
        self.process_internal(composite, None)
    }

    /// Like [`process`](Self::process) but uses the pilot-locked phase for the
    /// 57 kHz subcarrier (3× the 19 kHz pilot phase).
    pub fn process_with_pilot(
        &mut self,
        composite: &[f32],
        pilot_phases: &[f64],
    ) -> Option<RdsData> {
        self.process_internal(composite, Some(pilot_phases))
    }

    fn process_internal(
        &mut self,
        composite: &[f32],
        pilot_phases: Option<&[f64]>,
    ) -> Option<RdsData> {
        let mut updated = false;
        let use_pilot = pilot_phases.map_or(false, |p| p.len() == composite.len());

        for (idx, &s) in composite.iter().enumerate() {
            let x = s as f64;

            // 1. Bandpass filter at 57 kHz (two cascaded stages).
            let filtered = self.bpf1s.process(x, &self.bpf1);
            let filtered = self.bpf2s.process(filtered, &self.bpf2);

            // 2. Mix down to baseband.
            let i_raw = if use_pilot {
                let rds_phase = 3.0 * pilot_phases.unwrap()[idx];
                filtered * rds_phase.sin()
            } else {
                let cos_n = self.nco_phase.cos();
                let v = filtered * cos_n;
                self.nco_phase += self.nco_inc;
                if self.nco_phase >= 2.0 * PI {
                    self.nco_phase -= 2.0 * PI;
                }
                v
            };

            // 3. Decimate by 10.
            self.decim_counter += 1;
            if self.decim_counter < RDS_DECIMATE {
                continue;
            }
            self.decim_counter = 0;

            // 4. LPF the baseband.
            let i_base = self.lpf_is.process(i_raw, &self.lpf_i);

            // 5. Symbol sync.
            let Some(sym) = self.sym_sync.push(i_base) else {
                continue;
            };

            // 6. Biphase decode.
            let Some(bit) = self.biphase.push(sym) else {
                continue;
            };

            // 7. Delta decode.
            let abs_bit = self.delta.decode(bit);

            // 8. Block sync.
            let Some(group) = self.blk_sync.push_bit(abs_bit) else {
                continue;
            };

            // 9. Parse group into accumulated data.
            self.grp_parse.parse(group, &mut self.data);
            updated = true;
        }

        if updated {
            let mut snapshot = self.data.clone();
            snapshot.synced = self.blk_sync.synced;
            Some(snapshot)
        } else {
            None
        }
    }

    /// Clears all decoder state.
    pub fn reset(&mut self) {
        self.bpf1s = BiquadState::default();
        self.bpf2s = BiquadState::default();
        self.lpf_is = BiquadState::default();
        self.nco_phase = 0.0;
        self.decim_counter = 0;
        self.sym_sync.reset();
        self.biphase.reset();
        self.delta.reset();
        self.blk_sync.reset();
        self.grp_parse.reset();
        self.data = RdsData::default();
    }

    pub fn synced(&self) -> bool {
        self.blk_sync.synced
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pty_names_are_complete() {
        assert_eq!(PTY_NAMES.len(), 32);
        assert_eq!(PTY_NAMES[0], "None");
        assert_eq!(PTY_NAMES[31], "Alarm");
    }

    #[test]
    fn syndromes_and_parity_matrix() {
        // An all-zero block has syndrome zero (not a valid offset word).
        assert_eq!(get_syndrome(0), RdsSyndrome::Invalid);
        // Every parity-matrix row must map to a unique bit position.
        let mut seen = std::collections::HashSet::new();
        for (i, &m) in PARITY_MATRIX.iter().enumerate() {
            assert!(seen.insert(m), "duplicate parity row at {i}");
        }
    }

    #[test]
    fn group4a_decodes_clock() {
        // 2000-01-01 12:34 UTC+02:00 (MJD 51544, +4 half-hours).
        let mjd = 51544u32;
        let b = (4u16 << 12) | ((mjd >> 15) as u16 & 0x3);
        let c = (((mjd & 0x7FFF) << 1) as u16) | ((12u16 >> 4) & 1);
        let d = ((12u16 & 0xF) << 12) | (34 << 6) | 4;
        let mut parser = GroupParser::new();
        let mut data = RdsData::default();
        parser.parse([0x1234, b as i32, c as i32, d as i32], &mut data);
        let clock = data.clock.expect("clock");
        assert_eq!((clock.year, clock.month, clock.day), (2000, 1, 1));
        assert_eq!((clock.hour, clock.minute), (12, 34));
        assert_eq!(clock.offset_half_hours, 4);
    }

    #[test]
    fn eon_af_mapping_rounds_to_1dp() {
        let mut e = EonEntry {
            pi: 1,
            ps: "        ".into(),
            af: vec![],
        };
        add_af(&mut e, 1); // 87.6 + 0.1
        add_af(&mut e, 204); // 108.0
        add_af(&mut e, 204); // deduplicated
        assert_eq!(e.af, vec![87.7, 108.0]);
    }

    #[test]
    fn trim_right_matches_go_cutset() {
        assert_eq!(trim_right(b"ABC   \0", &[b' ', 0x00]), "ABC");
        assert_eq!(trim_right(b"  ", &[b' ', 0x00]), "");
    }

    #[test]
    fn group_parser_updates_ps_and_rt() {
        let mut gp = GroupParser::new();
        let mut data = RdsData::default();

        // Group 0A, PTY 10, segment 0, block D = "AB".
        let b = (0u32 << 12) | (10u32 << 5) | 0; // type 0, version A, pty 10, segment 0
        let d = ((b'A' as u32) << 8) | b'B' as u32;
        gp.parse([0x1234, b as i32, -1, d as i32], &mut data);
        assert_eq!(data.pi, 0x1234);
        assert_eq!(data.pty, 10);
        assert_eq!(data.pty_name, "Pop Music");
        assert_eq!(data.ps, "AB");
    }

    #[test]
    fn burst_correction_recovers_one_and_two_bit_errors() {
        // Syndrome is linear, so a burst's syndrome is independent of the block.
        let blocks = [0x0123_4567u32 & 0x03FF_FFFF, 0x02AB_CDEF & 0x03FF_FFFF, 0x0000_0001];
        for block in blocks {
            for pos in 0..26 {
                let err = 1u32 << pos;
                let corrupted = block ^ err;
                let syn = calculate_syndrome(corrupted) ^ calculate_syndrome(block);
                assert_eq!(burst_table().get(&syn), Some(&err), "single bit {pos}");
            }
            for pos in 0..25 {
                let err = 0b11u32 << pos;
                let corrupted = block ^ err;
                let syn = calculate_syndrome(corrupted) ^ calculate_syndrome(block);
                assert_eq!(burst_table().get(&syn), Some(&err), "pair at {pos}");
            }
        }
    }

    #[test]
    fn decoder_runs_without_panicking_on_noise() {
        let mut dec = RdsDecoder::new(240_000.0);
        // Deterministic pseudo-noise.
        let mut state = 0x12345678u32;
        let samples: Vec<f32> = (0..48_000)
            .map(|_| {
                state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                (state as f32 / u32::MAX as f32) - 0.5
            })
            .collect();
        let _ = dec.process(&samples);
        dec.reset();
        assert!(!dec.synced());
    }
}
