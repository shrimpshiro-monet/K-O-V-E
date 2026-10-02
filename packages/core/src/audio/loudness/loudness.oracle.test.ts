import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { measureLoudness } from "./meter";

const golden = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "oracle.golden.json"), "utf8"),
) as { seconds: number; cases: Record<string, unknown> };

/**
 * Cross-check against two INDEPENDENT implementations on a deterministic, modulated, multi-tone
 * signal (not a pure tone), at several sample rates and layouts:
 *   - ffmpeg 7.0.2 `ebur128` filter (libebur128 port)  → integrated, LRA, true peak
 *   - pyloudnorm                                        → integrated
 * Goldens were produced by scripts/loudness-oracle.py (no Python/ffmpeg needed to run this test).
 * The signal formula MUST match oracleSignal() in that script.
 */
function oracleSignal(fs: number, channels: number, seconds = golden.seconds): Float32Array[] {
  const n = Math.round(seconds * fs);
  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / fs;
      const tone =
        0.25 * Math.sin(2 * Math.PI * 220 * t + 0.3 * c) +
        0.15 * Math.sin(2 * Math.PI * 1375 * t + 1.1) +
        0.1 * Math.sin(2 * Math.PI * 5200 * t + 0.7 * c) +
        0.05 * Math.sin(2 * Math.PI * 13000 * t);
      const env = Math.pow(10, (-18 * (0.5 + 0.5 * Math.sin((2 * Math.PI * t) / 17))) / 20);
      x[i] = tone * env;
    }
    const k = Math.round(10 * fs);
    x[k] = x[k]! + 0.9;
    x[k + 1] = x[k + 1]! + 0.9;
    out.push(x);
  }
  return out;
}

type Case = { fs: number; channels: number; ffmpeg: { integratedLufs: number; loudnessRangeLu: number; truePeakDbtp: number }; pyloudnorm?: { integratedLufs: number } };
const cases = golden.cases as Record<string, Case>;

// Tolerances are set by how far the two oracles disagree with EACH OTHER on this signal
// (≈0.04 LU integrated), not tuned to our result.
const TOL = { integrated: 0.06, lra: 0.15, truePeak: 0.15 };

describe("loudness meter vs independent implementations", () => {
  for (const [name, c] of Object.entries(cases)) {
    it(`${name}: integrated / LRA / true peak agree with ffmpeg ebur128` + (c.pyloudnorm ? " and pyloudnorm" : ""), () => {
      const r = measureLoudness(oracleSignal(c.fs, c.channels), c.fs);
      expect(Math.abs((r.integratedLufs as number) - c.ffmpeg.integratedLufs), `I ${r.integratedLufs} vs ffmpeg ${c.ffmpeg.integratedLufs}`).toBeLessThanOrEqual(TOL.integrated);
      expect(Math.abs((r.loudnessRangeLu as number) - c.ffmpeg.loudnessRangeLu), `LRA ${r.loudnessRangeLu} vs ffmpeg ${c.ffmpeg.loudnessRangeLu}`).toBeLessThanOrEqual(TOL.lra);
      expect(Math.abs((r.truePeakDbtp as number) - c.ffmpeg.truePeakDbtp), `TP ${r.truePeakDbtp} vs ffmpeg ${c.ffmpeg.truePeakDbtp}`).toBeLessThanOrEqual(TOL.truePeak);
      if (c.pyloudnorm) {
        expect(Math.abs((r.integratedLufs as number) - c.pyloudnorm.integratedLufs), `I ${r.integratedLufs} vs pyloudnorm ${c.pyloudnorm.integratedLufs}`).toBeLessThanOrEqual(TOL.integrated);
      }
    });
  }

  it("the inter-sample overshoot is real: true peak is above the sample peak for this signal", () => {
    const r = measureLoudness(oracleSignal(48_000, 2), 48_000);
    expect(r.truePeakDbtp as number).toBeGreaterThan((r.samplePeakDbfs as number) + 0.1);
  });
});
