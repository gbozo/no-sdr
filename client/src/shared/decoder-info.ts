// ============================================================
// node-sdr — Digital decoder reference data
// ============================================================
// Human-readable operating notes shown by the decoder info panel.
// Frequencies are dial frequencies for USB/data modes unless noted.
// The waterfall previews are illustrative, not recordings.

import type { DigitalMode } from './types';

export type DecoderPreviewStyle =
  | 'mfsk'       // slotted multi-tone weak-signal modes
  | 'narrow'     // very narrow continuous carrier
  | 'rtty'       // two-tone FSK
  | 'burst'      // packet/data bursts
  | 'wide'       // wideband continuous/data
  | 'pulse'      // short pulse trains
  | 'time'       // low-frequency time code
  | 'fax';       // continuous swept image modes

export interface DecoderFrequency {
  label: string;
  hz: number;
}

export interface DecoderInfo {
  protocol: string;
  timing: string;
  waterfall: string;
  tips: string[];
  frequencies: DecoderFrequency[];
  preview: DecoderPreviewStyle;
}

const HF_WEAK_SIGNAL_TIPS = [
  'Use USB and tune the dial frequency shown, then decode 200–3000 Hz above it.',
  'Signals are usually narrow; widen the waterfall zoom rather than the demod filter.',
  'UTC timing is critical — slots start on exact clock boundaries.',
];

const HF_TEXT_TIPS = [
  'Use USB (or LSB below 10 MHz) and centre the signal in the passband.',
  'Most activity is in the 1.8–28 MHz amateur bands.',
  'A narrow filter and noise reduction help; the decoder expects audio from the demodulator.',
];

const VHF_BURST_TIPS = [
  'Use the stated demodulator/bandwidth and tune the channel centre.',
  'Bursts are intermittent — leave the decoder running over several minutes.',
  'A clean, strong signal is more important than a wide waterfall span.',
];

const METEOR_TIPS = [
  'Meteor-scatter bursts are short and sporadic; monitor through a shower peak.',
  'Use a horizontally polarised antenna for best results.',
  'UTC timing and mutual frequency tolerance matter more than signal strength.',
];

const TIME_TIPS = [
  'Use a narrow AM/SSB filter around the carrier.',
  'The audio is a 1 bit/s time code, not speech or data tones.',
  'Long integration helps in noisy urban environments.',
];

export const DECODER_INFO: Record<DigitalMode, DecoderInfo> = {
  ft8: {
    protocol: '8-FSK, 15 s slots, ~50 Hz message bandwidth',
    timing: '15 s UTC-aligned slots; transmit and receive alternate',
    waterfall: 'A dense block of eight short tone bars inside ~2.8 kHz, lasting about 12.6 s. Several stations appear as parallel blocks at different audio offsets.',
    tips: HF_WEAK_SIGNAL_TIPS,
    frequencies: [
      { label: '160 m', hz: 1_840_000 },
      { label: '80 m', hz: 3_573_000 },
      { label: '60 m', hz: 5_357_000 },
      { label: '40 m', hz: 7_074_000 },
      { label: '30 m', hz: 10_136_000 },
      { label: '20 m', hz: 14_074_000 },
      { label: '17 m', hz: 18_100_000 },
      { label: '15 m', hz: 21_074_000 },
      { label: '12 m', hz: 24_915_000 },
      { label: '10 m', hz: 28_074_000 },
      { label: '6 m', hz: 50_313_000 },
    ],
    preview: 'mfsk',
  },
  ft4: {
    protocol: '4-FSK, 7.5 s slots, ~250 Hz message bandwidth',
    timing: '7.5 s UTC-aligned slots',
    waterfall: 'Like FT8 but compressed into half the time: shorter, wider-spaced tone bars and more frequent slots.',
    tips: HF_WEAK_SIGNAL_TIPS,
    frequencies: [
      { label: '80 m', hz: 3_575_000 },
      { label: '40 m', hz: 7_047_500 },
      { label: '30 m', hz: 10_140_000 },
      { label: '20 m', hz: 14_080_000 },
      { label: '17 m', hz: 18_104_000 },
      { label: '15 m', hz: 21_140_000 },
      { label: '12 m', hz: 24_919_000 },
      { label: '10 m', hz: 28_180_000 },
      { label: '6 m', hz: 50_318_000 },
    ],
    preview: 'mfsk',
  },
  ft2: {
    protocol: 'Fast slotted MFSK, 3.75 s slots',
    timing: '3.75 s UTC-aligned slots',
    waterfall: 'Very short blocks of tone bars — four times faster than FT8. Easy to mistake for noise bursts unless the waterfall is zoomed in.',
    tips: HF_WEAK_SIGNAL_TIPS,
    frequencies: [
      { label: '80 m', hz: 3_573_000 },
      { label: '40 m', hz: 7_074_000 },
      { label: '20 m', hz: 14_074_000 },
      { label: '15 m', hz: 21_074_000 },
      { label: '10 m', hz: 28_074_000 },
      { label: '6 m', hz: 50_313_000 },
    ],
    preview: 'mfsk',
  },
  fst4: {
    protocol: '4-GFSK, 15 s–30 min sequences, very narrow',
    timing: 'Selectable 15/30/60/120/300/900/1800 s slots',
    waterfall: 'Extremely narrow, low-rate tone traces. Long transmissions look like a slowly stepping line rather than a block.',
    tips: HF_WEAK_SIGNAL_TIPS,
    frequencies: [
      { label: '160 m', hz: 1_836_000 },
      { label: '80 m', hz: 3_568_000 },
      { label: '40 m', hz: 7_078_000 },
      { label: '30 m', hz: 10_140_000 },
      { label: '20 m', hz: 14_080_000 },
      { label: '17 m', hz: 18_104_000 },
      { label: '15 m', hz: 21_080_000 },
      { label: '10 m', hz: 28_080_000 },
      { label: '6 m', hz: 50_320_000 },
    ],
    preview: 'mfsk',
  },
  q65: {
    protocol: '65-tone FSK, 30/60/120/300 s sequences',
    timing: 'Selectable 30–300 s slots; used for EME and scatter',
    waterfall: 'Very narrow, slow multi-tone traces. Signals can be weaker than the noise floor and still decode after long integration.',
    tips: [
      'Use the agreed Q65 sub-mode and UTC sequence length.',
      'EME work needs accurate frequency and Doppler correction.',
      'Signals may be invisible in a single waterfall frame — let the decoder integrate.',
    ],
    frequencies: [
      { label: '6 m', hz: 50_275_000 },
      { label: '2 m', hz: 144_120_000 },
      { label: '70 cm', hz: 432_065_000 },
      { label: '23 cm', hz: 1_296_175_000 },
    ],
    preview: 'mfsk',
  },
  jt65: {
    protocol: '65-FSK, 60 s slots, ~180 Hz bandwidth',
    timing: '60 s UTC-aligned slots',
    waterfall: 'A narrow, dense 65-tone block lasting about 46 s. Often visible as a faint, slightly stepped vertical band.',
    tips: HF_WEAK_SIGNAL_TIPS,
    frequencies: [
      { label: '160 m', hz: 1_838_000 },
      { label: '80 m', hz: 3_570_000 },
      { label: '40 m', hz: 7_076_000 },
      { label: '30 m', hz: 10_138_000 },
      { label: '20 m', hz: 14_076_000 },
      { label: '17 m', hz: 18_102_000 },
      { label: '15 m', hz: 21_076_000 },
      { label: '10 m', hz: 28_076_000 },
      { label: '6 m', hz: 50_310_000 },
    ],
    preview: 'mfsk',
  },
  jt9: {
    protocol: '9-FSK, 60 s slots, ~16 Hz bandwidth',
    timing: '60 s UTC-aligned slots',
    waterfall: 'A very thin, slowly varying line or small tone cluster. It is much narrower than JT65 and easy to overlook in a wide view.',
    tips: HF_WEAK_SIGNAL_TIPS,
    frequencies: [
      { label: '160 m', hz: 1_839_000 },
      { label: '80 m', hz: 3_572_000 },
      { label: '40 m', hz: 7_078_000 },
      { label: '30 m', hz: 10_140_000 },
      { label: '20 m', hz: 14_078_000 },
      { label: '17 m', hz: 18_104_000 },
      { label: '15 m', hz: 21_078_000 },
      { label: '10 m', hz: 28_078_000 },
      { label: '6 m', hz: 50_312_000 },
    ],
    preview: 'narrow',
  },
  wspr: {
    protocol: '4-FSK, 2 min slots, ~6 Hz bandwidth',
    timing: '2 min UTC-aligned slots (even minutes)',
    waterfall: 'An extremely thin, slow four-tone trace over two minutes. It looks like a faint vertical hairline, not a broad data burst.',
    tips: [
      'WSPR is a propagation beacon mode, not a QSO mode.',
      'Tune the dial frequency and decode around 1500 Hz audio.',
      'Use long integrations; signals can be far below the visual noise floor.',
    ],
    frequencies: [
      { label: '160 m', hz: 1_836_600 },
      { label: '80 m', hz: 3_568_600 },
      { label: '60 m', hz: 5_287_200 },
      { label: '40 m', hz: 7_038_600 },
      { label: '30 m', hz: 10_138_700 },
      { label: '20 m', hz: 14_095_600 },
      { label: '17 m', hz: 18_104_600 },
      { label: '15 m', hz: 21_094_600 },
      { label: '10 m', hz: 28_124_600 },
      { label: '6 m', hz: 50_293_000 },
      { label: '2 m', hz: 144_489_000 },
    ],
    preview: 'narrow',
  },
  pi4: {
    protocol: '4-FSK beacon, 1 min mixed-mode beacon sequence',
    timing: 'Synchronised 1 min beacon cycle',
    waterfall: 'A short, narrow beacon telemetry burst followed by a CW carrier/identification in the same minute.',
    tips: [
      'PI4 is a beacon mode; tune the beacon carrier and decode its telemetry.',
      'Use the nominal beacon frequency for your band and region.',
      'Beacons are usually horizontally polarised and run continuously.',
    ],
    frequencies: [
      { label: '6 m beacon', hz: 50_293_000 },
      { label: '2 m beacon', hz: 144_489_000 },
      { label: '70 cm beacon', hz: 432_489_000 },
    ],
    preview: 'mfsk',
  },
  js8: {
    protocol: '8-FSK, 15 s slots, JS8Call messaging',
    timing: '15 s UTC-aligned slots',
    waterfall: 'Similar to FT8 but often wider and more conversational; multiple stations appear as slotted tone blocks.',
    tips: [
      'Use USB and the published JS8Call dial frequency.',
      'Unlike FT8, JS8 supports free-text and store-and-forward messaging.',
      'Decode 500–2500 Hz above the dial.',
    ],
    frequencies: [
      { label: '160 m', hz: 1_842_000 },
      { label: '80 m', hz: 3_578_000 },
      { label: '40 m', hz: 7_078_000 },
      { label: '30 m', hz: 10_130_000 },
      { label: '20 m', hz: 14_078_000 },
      { label: '17 m', hz: 18_104_000 },
      { label: '15 m', hz: 21_078_000 },
      { label: '10 m', hz: 28_078_000 },
      { label: '6 m', hz: 50_318_000 },
    ],
    preview: 'mfsk',
  },
  msk144: {
    protocol: 'MSK, 15 s slots, ~2 kHz bandwidth',
    timing: '15 s periods; short meteor pings',
    waterfall: 'Short, broadband bursts lasting milliseconds to seconds. Individual pings look like vertical streaks.',
    tips: METEOR_TIPS,
    frequencies: [
      { label: '6 m', hz: 50_280_000 },
      { label: '2 m', hz: 144_150_000 },
      { label: '1.25 m', hz: 222_100_000 },
      { label: '70 cm', hz: 432_100_000 },
    ],
    preview: 'pulse',
  },
  fsk441: {
    protocol: '4-FSK, 30 s periods, ~2 kHz bandwidth',
    timing: '30 s periods; legacy meteor-scatter mode',
    waterfall: 'Short broadband pings and streaks, similar to MSK144 but with looser frequency tolerance.',
    tips: METEOR_TIPS,
    frequencies: [
      { label: '6 m', hz: 50_260_000 },
      { label: '2 m', hz: 144_140_000 },
      { label: '1.25 m', hz: 222_080_000 },
      { label: '70 cm', hz: 432_080_000 },
    ],
    preview: 'pulse',
  },
  adsb: {
    protocol: '1090 MHz Mode S extended squitter, PPM pulses',
    timing: 'Spontaneous, several messages per second per aircraft',
    waterfall: 'Not a continuous data block: very short, bright vertical pulses spread across ~1 MHz. A busy sky looks like sparse vertical static.',
    tips: [
      'Use a 2.4 MSPS profile centred on 1090 MHz for full sensitivity.',
      'A dedicated 1090 MHz antenna/filter dramatically improves range.',
      'Messages are short; the table fills over time as aircraft reply.',
    ],
    frequencies: [
      { label: 'ADS-B / Mode S', hz: 1_090_000_000 },
    ],
    preview: 'pulse',
  },
  acars: {
    protocol: '2400 baud MSK, ~6 kHz VHF AM data',
    timing: 'Intermittent aircraft bursts',
    waterfall: 'Short, narrow data bursts on a VHF voice channel, often only a fraction of a second long.',
    tips: VHF_BURST_TIPS,
    frequencies: [
      { label: 'Worldwide', hz: 131_550_000 },
      { label: 'Europe', hz: 131_725_000 },
      { label: 'USA', hz: 131_125_000 },
      { label: 'USA 2', hz: 130_025_000 },
      { label: 'USA 3', hz: 129_125_000 },
      { label: 'Delta/JetBlue', hz: 136_675_000 },
    ],
    preview: 'burst',
  },
  ais: {
    protocol: 'GMSK, 9600 baud, 25 kHz channels',
    timing: 'Continuous time-division bursts from ships',
    waterfall: 'Bursty 25 kHz-wide data blocks centred on one of two marine channels; busy harbours show almost continuous activity.',
    tips: [
      'AIS uses two channels: 161.975 and 162.025 MHz.',
      'Use a 25 kHz filter and a vertical marine antenna if possible.',
      'Ship reports are sparse; leave the decoder running.',
    ],
    frequencies: [
      { label: 'AIS 1 (87B)', hz: 161_975_000 },
      { label: 'AIS 2 (88B)', hz: 162_025_000 },
    ],
    preview: 'burst',
  },
  vdl2: {
    protocol: 'D8PSK, 31.5 kbaud, 25 kHz channels',
    timing: 'Intermittent aircraft/ground bursts',
    waterfall: 'Wide 25 kHz data bursts in the 136.6–136.975 MHz aeronautical block. Often stronger and more frequent than ACARS in Europe.',
    tips: VHF_BURST_TIPS,
    frequencies: [
      { label: 'Europe common', hz: 136_975_000 },
      { label: 'Europe 2', hz: 136_825_000 },
      { label: 'USA common', hz: 136_650_000 },
      { label: 'USA 2', hz: 136_800_000 },
    ],
    preview: 'burst',
  },
  hfdl: {
    protocol: '3 kHz USB HF data link, MFSK/PSK bursts',
    timing: 'Intermittent aircraft/ground bursts',
    waterfall: 'Short 3 kHz-wide bursts in the aeronautical HF bands. Long-range propagation makes them fade and flutter.',
    tips: [
      'HFDL uses several spot frequencies between ~2.9 and 22 MHz.',
      'A wideband HF antenna and good propagation are essential.',
      'Bursts may be weak; leave the decoder running for long periods.',
    ],
    frequencies: [
      { label: '2.9 MHz', hz: 2_944_000 },
      { label: '4.6 MHz', hz: 4_654_000 },
      { label: '6.5 MHz', hz: 6_532_000 },
      { label: '8.9 MHz', hz: 8_939_000 },
      { label: '10.0 MHz', hz: 10_081_000 },
      { label: '11.3 MHz', hz: 11_318_000 },
      { label: '13.2 MHz', hz: 13_276_000 },
      { label: '17.9 MHz', hz: 17_919_000 },
      { label: '21.9 MHz', hz: 21_931_000 },
    ],
    preview: 'burst',
  },
  aprs: {
    protocol: 'AX.25 AFSK 1200 baud (Bell 202) / 9600 baud G3RUH',
    timing: 'Intermittent packet bursts, typically every few minutes',
    waterfall: 'Short 12.5 kHz FM packet bursts with two audio tones. Dense areas show frequent, brief vertical blobs.',
    tips: [
      'APRS is usually FM, not SSB — use NFM and the regional frequency.',
      '1200 baud AFSK is the common mode; 9600 baud needs a wider filter.',
      'Digipeaters and trackers transmit sporadically.',
    ],
    frequencies: [
      { label: 'North America', hz: 144_390_000 },
      { label: 'Europe/Africa', hz: 144_800_000 },
      { label: 'ISS', hz: 145_825_000 },
      { label: 'Australia', hz: 145_175_000 },
    ],
    preview: 'burst',
  },
  navtex: {
    protocol: 'SITOR-B, 100 baud FSK, ±85 Hz shift',
    timing: 'Scheduled broadcasts, often every few hours',
    waterfall: 'A narrow, continuous two-tone FSK trace about 500 Hz wide. Stations share the frequency in time slots.',
    tips: [
      'International NAVTEX is 518 kHz; 490 kHz is national, 4209.5 kHz long-range.',
      'Use USB/CW or a 500 Hz filter and let the decoder sync.',
      'Messages begin with a phasing sequence; the decoder needs a few seconds.',
    ],
    frequencies: [
      { label: 'International', hz: 518_000 },
      { label: 'National', hz: 490_000 },
      { label: 'Long range', hz: 4_209_500 },
    ],
    preview: 'narrow',
  },
  packet: {
    protocol: 'AX.25 packet radio, 1200/9600 baud',
    timing: 'Intermittent packet bursts',
    waterfall: 'Short FM data bursts, similar to APRS but often on packet calling frequencies and with different baud rates.',
    tips: [
      'Use NFM; 1200 baud uses AFSK, 9600 baud uses direct G3RUH modulation.',
      'Packet activity is sparse in many areas — monitor for several minutes.',
      'The decoder reports frames, not just carrier presence.',
    ],
    frequencies: [
      { label: 'Packet calling', hz: 145_010_000 },
      { label: 'Europe packet', hz: 144_800_000 },
      { label: 'ISS', hz: 145_825_000 },
      { label: 'APRS', hz: 144_390_000 },
    ],
    preview: 'burst',
  },
  ism: {
    protocol: 'OOK/FSK sensor bursts, 315/433/868/915 MHz',
    timing: 'Sporadic sensor transmissions',
    waterfall: 'Very short, narrow bursts from remotes, weather sensors and meters. They can be much weaker than the noise floor.',
    tips: [
      'Use a 2.4 MSPS profile around 433.92 or 868.95 MHz.',
      'Signals are brief; the device table fills over time.',
      'A dedicated ISM antenna improves range significantly.',
    ],
    frequencies: [
      { label: '433.92 MHz', hz: 433_920_000 },
      { label: '868.95 MHz', hz: 868_950_000 },
      { label: '915 MHz', hz: 915_000_000 },
      { label: '315 MHz', hz: 315_000_000 },
    ],
    preview: 'pulse',
  },
  wefax: {
    protocol: 'HF radiofax, FSK/AM, 120/576 lines per minute',
    timing: 'Scheduled weather chart broadcasts',
    waterfall: 'A continuous ~3 kHz wide band of sweeping tones. The start tone and phasing signal look like bright horizontal bars.',
    tips: [
      'Tune the assigned carrier and use USB; the decoder handles the subcarrier.',
      'Charts start with a start tone and phasing pulse — wait for the image to lock.',
      'Propagation changes chart quality hour to hour.',
    ],
    frequencies: [
      { label: 'DWD 3.8 MHz', hz: 3_855_000 },
      { label: 'DWD 7.9 MHz', hz: 7_880_000 },
      { label: 'DWD 13.9 MHz', hz: 13_882_500 },
      { label: 'NOAA 8.7 MHz', hz: 8_682_000 },
      { label: 'NOAA 12.8 MHz', hz: 12_786_000 },
      { label: 'NOAA 17.1 MHz', hz: 17_146_000 },
    ],
    preview: 'fax',
  },
  sstv: {
    protocol: 'Analog SSTV, VCO audio, 3 kHz bandwidth',
    timing: 'Intermittent image transmissions, often 30–120 s',
    waterfall: 'Continuous sweeping tones that look like diagonal or wavy lines. The sync pulses create regular vertical breaks.',
    tips: [
      'Use USB/NFM depending on the band; centre the signal audio around 1500 Hz.',
      'Images are slow — the decoder needs a clean, continuous signal.',
      'Most HF activity is around 14.230 MHz and 21.340 MHz.',
    ],
    frequencies: [
      { label: '80 m', hz: 3_735_000 },
      { label: '20 m', hz: 14_230_000 },
      { label: '15 m', hz: 21_340_000 },
      { label: '10 m', hz: 28_680_000 },
      { label: '6 m', hz: 50_510_000 },
    ],
    preview: 'fax',
  },
  hell: {
    protocol: 'Hellschreiber, on/off keyed pixel columns, ~1 kHz',
    timing: 'Continuous or manual text transmissions',
    waterfall: 'A narrow, ragged vertical pattern of on/off tones — text columns look like a picket fence or dotted vertical stripes.',
    tips: HF_TEXT_TIPS,
    frequencies: [
      { label: '80 m', hz: 3_575_000 },
      { label: '40 m', hz: 7_040_000 },
      { label: '30 m', hz: 10_140_000 },
      { label: '20 m', hz: 14_065_000 },
    ],
    preview: 'narrow',
  },
  olivia: {
    protocol: 'MFSK, 2–32 tones, 250/500/1000 Hz bandwidth',
    timing: 'Continuous text',
    waterfall: 'Multiple parallel tone traces; wider Olivia modes look like a dense band of several lines.',
    tips: HF_TEXT_TIPS,
    frequencies: [
      { label: '160 m', hz: 1_837_500 },
      { label: '80 m', hz: 3_581_500 },
      { label: '40 m', hz: 7_038_500 },
      { label: '30 m', hz: 10_141_500 },
      { label: '20 m (8/250)', hz: 14_071_000 },
      { label: '20 m (32/1000)', hz: 14_107_000 },
      { label: '15 m', hz: 21_071_000 },
      { label: '10 m', hz: 28_121_000 },
    ],
    preview: 'wide',
  },
  thor: {
    protocol: '18-tone IFK+ MFSK, ~2 kHz',
    timing: 'Continuous text',
    waterfall: 'A band of stepping tones with a characteristic "dancing" multi-line appearance.',
    tips: HF_TEXT_TIPS,
    frequencies: [
      { label: '80 m', hz: 3_580_000 },
      { label: '40 m', hz: 7_040_000 },
      { label: '20 m', hz: 14_070_000 },
      { label: '15 m', hz: 21_070_000 },
      { label: '10 m', hz: 28_120_000 },
    ],
    preview: 'wide',
  },
  fsq: {
    protocol: 'IFK+ MFSK, ~2 kHz, Fast Simple QSO',
    timing: 'Continuous chat/text',
    waterfall: 'A continuous, moderately wide multi-tone band. Stations are usually found in small groups on the HF text frequencies.',
    tips: HF_TEXT_TIPS,
    frequencies: [
      { label: '80 m', hz: 3_580_000 },
      { label: '40 m', hz: 7_040_000 },
      { label: '20 m', hz: 14_070_000 },
      { label: '15 m', hz: 21_070_000 },
      { label: '10 m', hz: 28_120_000 },
    ],
    preview: 'wide',
  },
  psk31: {
    protocol: 'BPSK, 31.25 baud, ~31 Hz bandwidth',
    timing: 'Continuous text',
    waterfall: 'An extremely narrow single line, often with visible phase-transition streaks. Easy to miss in a wide waterfall.',
    tips: HF_TEXT_TIPS,
    frequencies: [
      { label: '160 m', hz: 1_838_000 },
      { label: '80 m', hz: 3_580_000 },
      { label: '40 m', hz: 7_040_000 },
      { label: '30 m', hz: 10_141_000 },
      { label: '20 m', hz: 14_070_000 },
      { label: '17 m', hz: 18_103_000 },
      { label: '15 m', hz: 21_070_000 },
      { label: '10 m', hz: 28_070_000 },
      { label: '6 m', hz: 50_305_000 },
    ],
    preview: 'narrow',
  },
  rtty: {
    protocol: '2-FSK, 170/450 Hz shift, 45.45/50 baud',
    timing: 'Continuous text',
    waterfall: 'Two crisp parallel tone traces. During idle, the mark/standby tone shows as a single line.',
    tips: HF_TEXT_TIPS,
    frequencies: [
      { label: '80 m', hz: 3_590_000 },
      { label: '40 m', hz: 7_043_000 },
      { label: '30 m', hz: 10_143_000 },
      { label: '20 m', hz: 14_083_000 },
      { label: '17 m', hz: 18_106_000 },
      { label: '15 m', hz: 21_080_000 },
      { label: '10 m', hz: 28_080_000 },
      { label: '6 m', hz: 50_600_000 },
    ],
    preview: 'rtty',
  },
  dcf77: {
    protocol: 'AM time code, 1 bit/s, 77.5 kHz longwave',
    timing: 'Continuous, one bit per second',
    waterfall: 'A steady carrier with a brief amplitude dip at the start of every second. The minute marker has a longer gap.',
    tips: TIME_TIPS,
    frequencies: [
      { label: 'DCF77', hz: 77_500 },
    ],
    preview: 'time',
  },
  als162: {
    protocol: 'Phase-modulated time code, 1 bit/s, 162 kHz',
    timing: 'Continuous, one bit per second',
    waterfall: 'A steady longwave carrier with phase-modulation sidebands; less visibly pulsed than DCF77 in a simple waterfall.',
    tips: TIME_TIPS,
    frequencies: [
      { label: 'ALS162', hz: 162_000 },
    ],
    preview: 'time',
  },
  pocsag: {
    protocol: 'POCSAG pager, 512/1200/2400 baud',
    timing: 'Intermittent pager bursts',
    waterfall: 'Short, narrow FSK bursts on pager channels. This build has no POCSAG decoder.',
    tips: ['POCSAG is listed for compatibility but is not decoded by this server.'],
    frequencies: [
      { label: 'Pager channel', hz: 153_350_000 },
    ],
    preview: 'burst',
  },
};

export function decoderInfoFor(mode: string): DecoderInfo | null {
  return (DECODER_INFO as Record<string, DecoderInfo>)[mode] ?? null;
}
