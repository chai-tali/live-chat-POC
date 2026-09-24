import { describe, expect, it } from "vitest";
import { floatTo16BitPCM, pcm16ToFloat32 } from "./audio";

describe("floatTo16BitPCM", () => {
  it("converts a full-scale positive sample to max int16", () => {
    const input = new Float32Array([1, 0, -1]);
    const buffer = floatTo16BitPCM(input);
    const view = new DataView(buffer);
    expect(view.getInt16(0, true)).toBe(32767);
    expect(view.getInt16(2, true)).toBe(0);
    expect(view.getInt16(4, true)).toBe(-32768);
  });
});

describe("pcm16ToFloat32", () => {
  it("round-trips through floatTo16BitPCM within rounding error", () => {
    const original = new Float32Array([0.5, -0.5, 0]);
    const buffer = floatTo16BitPCM(original);
    const restored = pcm16ToFloat32(buffer);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 3);
    }
  });
});
