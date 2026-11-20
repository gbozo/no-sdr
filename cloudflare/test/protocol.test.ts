import { describe, expect, it } from "vitest";
import { MSG_FFT_DEFLATE, parseFftDeflate } from "../src/protocol";

function frame(type: number, bins: number, body = 0): ArrayBuffer {
  const out = new Uint8Array(9 + body);
  const view = new DataView(out.buffer);
  out[0] = type;
  view.setInt16(1, -130, true);
  view.setInt16(3, 0, true);
  view.setUint32(5, bins, true);
  return out.buffer;
}

describe("0x0B parser", () => {
  it("rejects a short frame", () => {
    expect(() => parseFftDeflate(new ArrayBuffer(8))).toThrow(/too short/);
  });

  it("rejects the wrong type", () => {
    expect(() => parseFftDeflate(frame(0x10, 1024))).toThrow(/unexpected/);
  });

  it("rejects an out-of-range bin count", () => {
    expect(() => parseFftDeflate(frame(MSG_FFT_DEFLATE, 4))).toThrow(/out of range/);
    expect(() => parseFftDeflate(frame(MSG_FFT_DEFLATE, 2_000_000))).toThrow(/out of range/);
  });

  it("accepts a normal frame", () => {
    const parsed = parseFftDeflate(frame(MSG_FFT_DEFLATE, 2048, 4));
    expect(parsed.bins).toBe(2048);
    expect(parsed.minDb).toBe(-130);
    expect(parsed.maxDb).toBe(0);
    expect(parsed.deflate.length).toBe(4);
  });
});
