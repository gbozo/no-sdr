use std::collections::HashMap;

/// Varicode for a printable ASCII byte, or `""` if unmapped. Bits are sent
/// most-significant first; a `00` separator is appended between characters.
/// Shared with the THOR modem, which streams the same varicode through its FEC.
pub(crate) fn varicode(b: u8) -> &'static str {
    match b {
        b' ' => "1",
        b'!' => "111111111",
        b'"' => "101011111",
        b'#' => "111110101",
        b'$' => "111011011",
        b'%' => "1011010101",
        b'&' => "1010111011",
        b'\'' => "101111111",
        b'(' => "11111011",
        b')' => "11110111",
        b'*' => "101101111",
        b'+' => "111011111",
        b',' => "1110101",
        b'-' => "110101",
        b'.' => "1010111",
        b'/' => "110101111",
        b'0' => "10110111",
        b'1' => "10111101",
        b'2' => "11101101",
        b'3' => "11111111",
        b'4' => "101110111",
        b'5' => "101011011",
        b'6' => "101101011",
        b'7' => "110101101",
        b'8' => "110101011",
        b'9' => "110110111",
        b':' => "11110101",
        b';' => "110111101",
        b'<' => "111101101",
        b'=' => "1010101",
        b'>' => "111010111",
        b'?' => "1010101111",
        b'@' => "1010111101",
        b'A' => "1111101",
        b'B' => "11101011",
        b'C' => "10101101",
        b'D' => "10110101",
        b'E' => "1110111",
        b'F' => "11011011",
        b'G' => "11111101",
        b'H' => "101010101",
        b'I' => "1111111",
        b'J' => "111111101",
        b'K' => "101111101",
        b'L' => "11010111",
        b'M' => "10111011",
        b'N' => "11011101",
        b'O' => "10101011",
        b'P' => "11010101",
        b'Q' => "111011101",
        b'R' => "10101111",
        b'S' => "1101111",
        b'T' => "1101101",
        b'U' => "101010111",
        b'V' => "110110101",
        b'W' => "101011101",
        b'X' => "101110101",
        b'Y' => "101111011",
        b'Z' => "1010101101",
        b'[' => "111110111",
        b'\\' => "111101111",
        b']' => "111111011",
        b'^' => "1010111111",
        b'_' => "101101101",
        b'`' => "1011011111",
        b'a' => "1011",
        b'b' => "1011111",
        b'c' => "101111",
        b'd' => "101101",
        b'e' => "11",
        b'f' => "111101",
        b'g' => "1011011",
        b'h' => "101011",
        b'i' => "1101",
        b'j' => "111101011",
        b'k' => "10111111",
        b'l' => "11011",
        b'm' => "111011",
        b'n' => "1111",
        b'o' => "111",
        b'p' => "111111",
        b'q' => "110111111",
        b'r' => "10101",
        b's' => "10111",
        b't' => "101",
        b'u' => "110111",
        b'v' => "1111011",
        b'w' => "1101011",
        b'x' => "11011111",
        b'y' => "1011101",
        b'z' => "111010101",
        b'{' => "1010110111",
        b'|' => "110111011",
        b'}' => "1010110101",
        b'~' => "1011010111",
        b'\n' => "11101",
        b'\r' => "11111",
        _ => "",
    }
}

/// Reverse Varicode map (bit string → character), for decoding.
fn revmap() -> HashMap<&'static str, char> {
    let mut m = HashMap::new();
    for b in 0u8..=127 {
        let code = varicode(b);
        if !code.is_empty() {
            m.entry(code).or_insert(b as char);
        }
    }
    m
}

pub struct VaricodeRx {
    rx_word: String,
    map: HashMap<&'static str, char>,
}

impl VaricodeRx {
    pub fn new() -> Self {
        VaricodeRx {
            rx_word: String::new(),
            map: revmap(),
        }
    }

    /// Feed one differential bit; returns the decoded character at a `00`
    /// boundary (or `None` while a code is still accumulating).
    pub fn push_bit(&mut self, bit: u8) -> Option<char> {
        // A Varicode always starts with '1'; drop leading/idle zeros so a stray
        // pre-character '0' can't corrupt the next code (e.g. after idle).
        if self.rx_word.is_empty() && bit == 0 {
            return None;
        }
        self.rx_word.push(if bit == 1 { '1' } else { '0' });
        if self.rx_word.ends_with("00") {
            let code = &self.rx_word[..self.rx_word.len() - 2];
            let c = if code.is_empty() {
                None
            } else {
                self.map.get(code).copied()
            };
            self.rx_word.clear();
            c
        } else {
            if self.rx_word.len() > 20 {
                self.rx_word.clear(); // no terminator in a plausible length — resync
            }
            None
        }
    }
}

impl Default for VaricodeRx {
    fn default() -> Self {
        Self::new()
    }
}
