import { describe, expect, it } from "vitest";
import { deflateSync } from "fflate";
import {
  decodeDeflateSmooth,
  decimateMaxHold,
  HistoryRing,
} from "../src/history";
import { MSG_FFT_DEFLATE, MSG_FFT_HISTORY, packHistory, parseFftDeflate } from "../src/protocol";

function encodeFrame(values: number[], minDb = -130, maxDb = 0): ArrayBuffer {
  const delta = new Uint8Array(values.length);
  delta[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    delta[i] = (values[i] - values[i - 1]) & 0xff;
  }
  const body = deflateSync(delta);

  const out = new Uint8Array(9 + body.length);
  const view = new DataView(out.buffer);
  out[0] = MSG_FFT_DEFLATE;
  view.setInt16(1, minDb, true);
  view.setInt16(3, maxDb, true);
  view.setUint32(5, values.length, true);
  out.set(body, 9);
  return out.buffer;
}

describe("deflate-smooth decode", () => {
  it("round-trips a delta-encoded frame", () => {
    const bins = Array.from({ length: 256 }, (_, i) => (i * 7) % 256);
    const frame = parseFftDeflate(encodeFrame(bins));
    const decoded = decodeDeflateSmooth(frame.deflate, frame.bins);
    expect(Array.from(decoded)).toEqual(bins);
  });

  it("rejects a mismatched bin count", () => {
    const frame = parseFftDeflate(encodeFrame(new Array(256).fill(7)));
    expect(() => decodeDeflateSmooth(frame.deflate, 128)).toThrow();
  });
});

describe("max-hold decimation", () => {
  it("keeps the peak in each bucket", () => {
    const out = decimateMaxHold(new Uint8Array([0, 10, 20, 30, 40, 50, 60, 70]), 2);
    expect(Array.from(out)).toEqual([30, 70]);
  });

  it("preserves a narrow carrier", () => {
    const src = new Uint8Array(1024).fill(10);
    src[513] = 200;
    const out = decimateMaxHold(src, 128);
    expect(Math.max(...out)).toBe(200);
  });
});

describe("history ring", () => {
  it("returns oldest-first after wrapping", () => {
    const ring = new HistoryRing(2, 3);
    for (let i = 0; i < 5; i++) ring.push(new Uint8Array([i, i + 1]));
    expect(ring.size).toBe(3);
    expect(ring.snapshot().map((f) => f[0])).toEqual([2, 3, 4]);
  });

  it("caps the snapshot", () => {
    const ring = new HistoryRing(1, 4);
    for (let i = 0; i < 4; i++) ring.push(new Uint8Array([i]));
    expect(ring.snapshot(2).map((f) => f[0])).toEqual([2, 3]);
  });
});

describe("history packing", () => {
  it("writes the existing 0x0D header and frame order", () => {
    const buf = packHistory(
      [new Uint8Array([1, 2]), new Uint8Array([3, 4])],
      2,
      -130,
      0,
    );
    const view = new DataView(buf);
    expect(view.getUint8(0)).toBe(MSG_FFT_HISTORY);
    expect(view.getUint16(1, true)).toBe(2);
    expect(view.getUint32(3, true)).toBe(2);
    expect(view.getInt16(7, true)).toBe(-130);
    expect(view.getInt16(9, true)).toBe(0);
    expect(view.getUint8(11)).toBe(0);
    expect(Array.from(new Uint8Array(buf, 12))).toEqual([1, 2, 3, 4]);
  });
});
