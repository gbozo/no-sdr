// Round-trip tests for the V1 segmented multi-tier waterfall wire protocol.
//
// Run with Node's built-in test runner + TypeScript type-stripping:
//   node --test --experimental-strip-types src/shared/protocol.tiled.test.ts
// (from the client/ directory). protocol.ts has no runtime imports beyond the
// global TextEncoder, so type-stripping is sufficient — no bundler required.
//
// These assert the TS pack/unpack helpers agree with the frozen byte layout
// shared with serverrs/src/ws/protocol.rs (pack hand-built bytes in the Rust
// layout, then unpack in TS).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MSG_FFT,
  MSG_FFT_COMPRESSED,
  MSG_FFT_ADPCM,
  MSG_FFT_DEFLATE,
  MSG_FFT_HISTORY,
  WF_VERFLAGS_TILED,
  FFT_HISTORY_CODEC_DEFLATE,
  decodeFftFrame,
  decodeFftHistoryFrame,
  packFftRawTiled,
  packFftCompressedTiled,
  packFftAdpcmTiled,
  packFftDeflateTiled,
  packFftHistoryTiled,
  packWaterfallView,
} from './protocol.ts';

function u8(...bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

test('0x0B deflate: hand-built Rust-layout bytes decode in TS', () => {
  // [0x0B][0x11][tier=4][0][tileIndex=2 LE][tileCount=3 LE]
  // [i16 minDb=-130][i16 maxDb=0][u32 binCount=5][deflate bytes 0x78 0x9C 0x01]
  const bytes = u8(
    MSG_FFT_DEFLATE, WF_VERFLAGS_TILED, 4, 0, 2, 0, 3, 0,
    0x7e, 0xff, // -130 LE
    0x00, 0x00, // 0 LE
    0x05, 0x00, 0x00, 0x00, // binCount 5 LE
    0x78, 0x9c, 0x01, // deflate body
  );
  const info = decodeFftFrame(bytes, true);
  assert.equal(info.type, MSG_FFT_DEFLATE);
  assert.equal(info.tiled, true);
  assert.equal(info.tier, 4);
  assert.equal(info.tileIndex, 2);
  assert.equal(info.tileCount, 3);
  assert.equal(info.minDb, -130);
  assert.equal(info.maxDb, 0);
  assert.equal(info.binCount, 5);
  assert.equal(info.payloadOffset, 16);
  assert.deepEqual(
    [...new Uint8Array(bytes, info.payloadOffset)],
    [0x78, 0x9c, 0x01],
  );
});

test('0x0D history: hand-built Rust-layout bytes decode in TS', () => {
  // [0x0D][0x11][tier=1][0][tileIndex=1 LE][tileCount=2 LE]
  // [u16 frameCount=2][u32 binCount=3][i16 minDb=-130][i16 maxDb=0][u8 codec=1][payload...]
  const bytes = u8(
    MSG_FFT_HISTORY, WF_VERFLAGS_TILED, 1, 0, 1, 0, 2, 0,
    0x02, 0x00, // frameCount 2
    0x03, 0x00, 0x00, 0x00, // binCount 3
    0x7e, 0xff, // -130
    0x00, 0x00, // 0
    FFT_HISTORY_CODEC_DEFLATE, // codec 1
    0xaa, 0xbb, 0xcc, // payload
  );
  const info = decodeFftHistoryFrame(bytes, true);
  assert.equal(info.type, MSG_FFT_HISTORY);
  assert.equal(info.tiled, true);
  assert.equal(info.tier, 1);
  assert.equal(info.tileIndex, 1);
  assert.equal(info.tileCount, 2);
  assert.equal(info.frameCount, 2);
  assert.equal(info.binCount, 3);
  assert.equal(info.minDb, -130);
  assert.equal(info.maxDb, 0);
  assert.equal(info.codec, FFT_HISTORY_CODEC_DEFLATE);
  assert.equal(info.payloadOffset, 19);
  assert.deepEqual(
    [...new Uint8Array(bytes, info.payloadOffset)],
    [0xaa, 0xbb, 0xcc],
  );
});

test('pack -> decode round-trip: raw 0x01 tiled', () => {
  const bins = new Float32Array([1.0, -2.5, 300.0]);
  const buf = packFftRawTiled(bins, 2, 5, 9);
  // Byte layout assertions.
  const dv = new DataView(buf);
  assert.equal(dv.getUint8(0), MSG_FFT);
  assert.equal(dv.getUint8(1), 0x11);
  assert.equal(dv.getUint8(2), 2);
  assert.equal(dv.getUint8(3), 0);
  assert.equal(dv.getUint16(4, true), 5);
  assert.equal(dv.getUint16(6, true), 9);
  const info = decodeFftFrame(buf, true);
  assert.equal(info.tier, 2);
  assert.equal(info.tileIndex, 5);
  assert.equal(info.tileCount, 9);
  assert.equal(info.payloadOffset, 8);
  assert.deepEqual([...new Float32Array(buf, info.payloadOffset)], [1.0, -2.5, 300.0]);
});

test('pack -> decode round-trip: compressed 0x04 tiled', () => {
  const data = new Uint8Array([0, 128, 255]);
  const buf = packFftCompressedTiled(data, -130, 0, 1, 0, 4);
  const info = decodeFftFrame(buf, true);
  assert.equal(info.type, MSG_FFT_COMPRESSED);
  assert.equal(info.tier, 1);
  assert.equal(info.tileIndex, 0);
  assert.equal(info.tileCount, 4);
  assert.equal(info.minDb, -130);
  assert.equal(info.maxDb, 0);
  assert.equal(info.payloadOffset, 12);
  assert.deepEqual([...new Uint8Array(buf, info.payloadOffset)], [0, 128, 255]);
});

test('pack -> decode round-trip: adpcm 0x08 tiled (inner header untouched)', () => {
  // Payload keeps its own [i16 min][i16 max] header; wrapper must not touch it.
  const payload = new Uint8Array([0x7e, 0xff, 0x00, 0x00, 0x11, 0x22]);
  const buf = packFftAdpcmTiled(payload, 3, 7, 7);
  const info = decodeFftFrame(buf, true);
  assert.equal(info.type, MSG_FFT_ADPCM);
  assert.equal(info.tier, 3);
  assert.equal(info.payloadOffset, 8);
  // minDb/maxDb are NOT read for ADPCM at the wrapper level.
  assert.equal(info.minDb, undefined);
  assert.deepEqual([...new Uint8Array(buf, info.payloadOffset)], [...payload]);
});

test('pack -> decode round-trip: deflate 0x0B tiled', () => {
  const deflate = new Uint8Array([0x78, 0x9c, 1, 2, 3]);
  const buf = packFftDeflateTiled(deflate, -130, 0, 4096, 4, 2, 3);
  const info = decodeFftFrame(buf, true);
  assert.equal(info.minDb, -130);
  assert.equal(info.maxDb, 0);
  assert.equal(info.binCount, 4096);
  assert.equal(info.payloadOffset, 16);
  assert.deepEqual([...new Uint8Array(buf, info.payloadOffset)], [...deflate]);
});

test('pack -> decode round-trip: history 0x0D tiled', () => {
  const payload = new Uint8Array([9, 8, 7, 6]);
  const buf = packFftHistoryTiled(payload, 2, 3, -130, 0, FFT_HISTORY_CODEC_DEFLATE, 1, 1, 2);
  const info = decodeFftHistoryFrame(buf, true);
  assert.equal(info.frameCount, 2);
  assert.equal(info.binCount, 3);
  assert.equal(info.codec, FFT_HISTORY_CODEC_DEFLATE);
  assert.equal(info.payloadOffset, 19);
  assert.deepEqual([...new Uint8Array(buf, info.payloadOffset)], [...payload]);
});

test('legacy (non-v1) decode unchanged: byte 1 is first payload byte', () => {
  // Legacy 0x04: [0x04][i16 minDb][i16 maxDb][u8...]
  const bytes = u8(MSG_FFT_COMPRESSED, 0x7e, 0xff, 0x00, 0x00, 10, 20, 30);
  const info = decodeFftFrame(bytes, false);
  assert.equal(info.tiled, false);
  assert.equal(info.tier, undefined);
  assert.equal(info.minDb, -130);
  assert.equal(info.maxDb, 0);
  assert.equal(info.payloadOffset, 5);
  assert.deepEqual([...new Uint8Array(bytes, info.payloadOffset)], [10, 20, 30]);
});

test('v1 non-tiled decode: verFlags present without TILED bit', () => {
  // [0x04][0x01 ver=1,no tiled][i16 minDb][i16 maxDb][u8...]
  const bytes = u8(MSG_FFT_COMPRESSED, 0x01, 0x7e, 0xff, 0x00, 0x00, 10, 20);
  const info = decodeFftFrame(bytes, true);
  assert.equal(info.tiled, false);
  assert.equal(info.minDb, -130);
  assert.equal(info.maxDb, 0);
  assert.equal(info.payloadOffset, 6);
  assert.deepEqual([...new Uint8Array(bytes, info.payloadOffset)], [10, 20]);
});

test('packWaterfallView builds the JSON command', () => {
  assert.deepEqual(packWaterfallView(1920, 0.25, 0.75, 15), {
    cmd: 'waterfall_view',
    viewportPx: 1920,
    startFrac: 0.25,
    endFrac: 0.75,
    fps: 15,
  });
  assert.deepEqual(packWaterfallView(800, 0, 1), {
    cmd: 'waterfall_view',
    viewportPx: 800,
    startFrac: 0,
    endFrac: 1,
  });
});
