//! Shared time-code parsing for DCF77 and ALS162.
//!
//! Both signals carry the same 59-bit BCD clock fields from bit 20 onwards;
//! their station-specific announcement bits differ and are interpreted by the
//! caller. This module only turns the bit frame into a checked UTC instant.

use chrono::{NaiveDate, TimeZone, Utc};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TimeStandard {
    Dcf77,
    Als162,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TimeCode {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub weekday: u8,
    pub utc_offset_min: i32,
    pub unix: i64,
    pub dst: bool,
    pub leap_second: bool,
    pub clock_change: bool,
    pub holiday_today: bool,
    pub holiday_tomorrow: bool,
    pub text: String,
}

fn bit(bits: &[u8], index: usize) -> Option<u8> {
    match bits.get(index).copied()? {
        0 => Some(0),
        1 => Some(1),
        _ => None,
    }
}

fn bit_value(bits: &[u8], index: usize) -> Option<bool> {
    Some(bit(bits, index)? == 1)
}

fn even(bits: &[u8], start: usize, end: usize) -> Option<bool> {
    let mut ones = 0usize;
    for i in start..end {
        ones += usize::from(bit(bits, i)?);
    }
    Some(ones % 2 == 0)
}

fn bcd(bits: &[u8], start: usize, len: usize, weights: &[u32]) -> Option<u32> {
    let mut value = 0;
    for i in 0..len {
        if bit(bits, start + i)? == 1 {
            value += *weights.get(i)?;
        }
    }
    Some(value)
}

fn central_offset(bits: &[u8]) -> Option<i32> {
    match (bit_value(bits, 17)?, bit_value(bits, 18)?) {
        (true, false) => Some(120), // CEST
        (false, true) => Some(60),  // CET
        // Some transmitters leave both bits clear around an announcement;
        // CET is the safe fallback for a decoded clock.
        (false, false) => Some(60),
        (true, true) => None,
    }
}

/// Decode one 59-bit minute. Returns `None` for invalid BCD, parity, date or
/// station marker rather than emitting a plausible-looking wrong time.
pub(crate) fn decode(bits: &[u8], standard: TimeStandard) -> Option<TimeCode> {
    if bits.len() < 59 {
        return None;
    }
    if bit(bits, 0)? != 0 || bit(bits, 20)? != 1 {
        return None;
    }
    if !even(bits, 21, 29)? || !even(bits, 29, 36)? || !even(bits, 36, 59)? {
        return None;
    }

    let minute = bcd(bits, 21, 7, &[1, 2, 4, 8, 10, 20, 40])?;
    let hour = bcd(bits, 29, 6, &[1, 2, 4, 8, 10, 20])?;
    let day = bcd(bits, 36, 6, &[1, 2, 4, 8, 10, 20])?;
    let weekday = bcd(bits, 42, 3, &[1, 2, 4])? as u8;
    let month = bcd(bits, 45, 5, &[1, 2, 4, 8, 10])?;
    let year = 2000 + bcd(bits, 50, 8, &[1, 2, 4, 8, 10, 20, 40, 80])? as i32;

    if !(1..=7).contains(&weekday) || !(1..=12).contains(&month) || hour > 23 || minute > 59 {
        return None;
    }
    let date = NaiveDate::from_ymd_opt(year, month, day)?;
    let naive = date.and_hms_opt(hour, minute, 0)?;
    let offset = central_offset(bits)?;
    let unix = naive.and_utc().timestamp() - i64::from(offset) * 60;

    let leap_second = match standard {
        TimeStandard::Dcf77 => bit_value(bits, 19)?,
        TimeStandard::Als162 => bit_value(bits, 1)? || bit_value(bits, 2)?,
    };
    let clock_change = bit_value(bits, 16)?;
    let holiday_tomorrow = bit_value(bits, 13)?;
    let holiday_today = bit_value(bits, 14)?;

    let local = Utc
        .timestamp_opt(unix + i64::from(offset) * 60, 0)
        .single()?;
    let sign = if offset >= 0 { '+' } else { '-' };
    let offset_h = offset.abs() / 60;
    let offset_m = offset.abs() % 60;
    let text = format!(
        "{} {} ({}{:02}:{:02})",
        local.format("%Y-%m-%d %H:%M"),
        if offset == 120 { "CEST" } else { "CET" },
        sign,
        offset_h,
        offset_m
    );

    Some(TimeCode {
        year,
        month,
        day,
        hour,
        minute,
        weekday,
        utc_offset_min: offset,
        unix,
        dst: offset == 120,
        leap_second,
        clock_change,
        holiday_today,
        holiday_tomorrow,
        text,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bcd_bits(value: u32, weights: &[u32]) -> Vec<u8> {
        // BCD is units and tens, not a greedy sum: 26 is 20 + 4 + 2, never
        // 10 + 8 + 8. The first four weights are the units digit and the
        // remaining weights are its tens.
        let units = value % 10;
        let tens = value / 10;
        let split = weights.len().min(4);
        let mut out = vec![0u8; weights.len()];
        for i in 0..weights.len() {
            let digit = if i < split { units } else { tens };
            let bit = i - if i < split { 0 } else { split };
            out[i] = u8::from(digit & (1 << bit) != 0);
        }
        out
    }

    fn minute_bits(standard: TimeStandard) -> Vec<u8> {
        let mut b = vec![0u8; 59];
        b[20] = 1;
        let minute = bcd_bits(32, &[1, 2, 4, 8, 10, 20, 40]);
        let hour = bcd_bits(14, &[1, 2, 4, 8, 10, 20]);
        let day = bcd_bits(13, &[1, 2, 4, 8, 10, 20]);
        let weekday = bcd_bits(5, &[1, 2, 4]);
        let month = bcd_bits(11, &[1, 2, 4, 8, 10]);
        let year = bcd_bits(26, &[1, 2, 4, 8, 10, 20, 40, 80]);
        b[21..28].copy_from_slice(&minute);
        b[29..35].copy_from_slice(&hour);
        b[36..42].copy_from_slice(&day);
        b[42..45].copy_from_slice(&weekday);
        b[45..50].copy_from_slice(&month);
        b[50..58].copy_from_slice(&year);
        b[18] = 1; // CET
        if standard == TimeStandard::Dcf77 {
            b[19] = 0;
        }
        for (start, end) in [(21, 29), (29, 36), (36, 59)] {
            let ones = b[start..end - 1].iter().filter(|v| **v == 1).count();
            b[end - 1] = (ones % 2) as u8;
        }
        b
    }

    #[test]
    fn decodes_a_known_minute() {
        let code = decode(&minute_bits(TimeStandard::Dcf77), TimeStandard::Dcf77).unwrap();
        assert_eq!((code.year, code.month, code.day), (2026, 11, 13));
        assert_eq!((code.hour, code.minute), (14, 32));
        assert_eq!(code.utc_offset_min, 60);
        assert_eq!(code.weekday, 5);
    }

    #[test]
    fn rejects_bad_parity() {
        let mut bits = minute_bits(TimeStandard::Dcf77);
        bits[28] ^= 1;
        assert!(decode(&bits, TimeStandard::Dcf77).is_none());
    }
}
