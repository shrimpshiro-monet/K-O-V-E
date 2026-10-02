import { describe, expect, it } from "vitest";
import { kWeightingCoefficients, kWeightingResponseDb } from "./k-weighting";

/** ITU-R BS.1770-4 Tables 1 and 2 (48 kHz). */
describe("K-weighting", () => {
  it("reproduces the tabulated BS.1770-4 coefficients at 48 kHz", () => {
    const { shelf, highpass } = kWeightingCoefficients(48_000);
    const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(2e-7);
    close(shelf.b0, 1.53512485958697);
    close(shelf.b1, -2.69169618940638);
    close(shelf.b2, 1.19839281085285);
    close(shelf.a1, -1.69065929318241);
    close(shelf.a2, 0.73248077421585);
    close(highpass.a1, -1.99004745483398);
    close(highpass.a2, 0.99007225036621);
    expect([highpass.b0, highpass.b1, highpass.b2]).toEqual([1, -2, 1]);
  });

  it("has ~unity-ish gain around 1 kHz and rolls off below 38 Hz / lifts above 2 kHz", () => {
    const at = (f: number) => kWeightingResponseDb(48_000, f);
    expect(at(1000)).toBeGreaterThan(0.5);
    expect(at(1000)).toBeLessThan(0.8); // +0.691 dB, the origin of the -0.691 LUFS offset
    expect(at(10)).toBeLessThan(-20);
    expect(at(10_000)).toBeGreaterThan(3.5);
    expect(at(10_000)).toBeLessThan(4.5);
  });

  it("is sample-rate independent in the audio band (derived, not resampled)", () => {
    for (const f of [100, 1000, 4000, 8000]) {
      const ref = kWeightingResponseDb(48_000, f);
      for (const fs of [44_100, 88_200, 96_000, 192_000]) {
        expect(Math.abs(kWeightingResponseDb(fs, f) - ref)).toBeLessThan(0.06);
      }
    }
  });

  it("rejects nonsense sample rates", () => {
    expect(() => kWeightingCoefficients(0)).toThrow();
    expect(() => kWeightingCoefficients(NaN)).toThrow();
  });
});
