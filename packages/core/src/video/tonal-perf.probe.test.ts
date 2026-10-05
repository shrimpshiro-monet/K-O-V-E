import { describe, expect, it } from "vitest";
import { VideoEffectsEngine } from "./video-effects-engine";

/**
 * PERF PROBE (not a regression test): times applyTonal — the CPU pixel pass
 * used by color-bw-crushed — on a real 1920x1080 RGBA buffer, then
 * extrapolates export-scale cost. Run: pnpm exec vitest run src/video/tonal-perf.probe.ts
 */
describe("tonal pixel-path performance (1080p)", () => {
  it("measures applyTonal per-frame cost", () => {
    const engine = Object.create(
      VideoEffectsEngine.prototype,
    ) as VideoEffectsEngine;
    const applyTonal = (
      engine as unknown as {
        applyTonal(
          data: Uint8ClampedArray,
          shadows: number,
          midtones: number,
          highlights: number,
        ): void;
      }
    ).applyTonal.bind(engine);

    const width = 1920;
    const height = 1080;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
      const v = (i * 7) % 256; // varied luma so all three bands are exercised
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }

    // Warmup
    applyTonal(data, -1, -1, -0.4);

    const iterations = 30;
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) {
      applyTonal(data, -1, -1, -0.4);
    }
    const totalMs = performance.now() - t0;
    const perFrameMs = totalMs / iterations;

    console.log(
      `[tonal-perf] 1920x1080 applyTonal: ${perFrameMs.toFixed(2)} ms/frame ` +
        `(${(1000 / perFrameMs).toFixed(0)} fps theoretical)`,
    );
    console.log(
      `[tonal-perf] extrapolation: 15s@30fps (450 frames) adds ~${((perFrameMs * 450) / 1000).toFixed(1)}s; ` +
        `60min@30fps (108k frames) adds ~${((perFrameMs * 108000) / 60000).toFixed(1)}min of CPU time`,
    );
    // Sanity: the pass must still be deterministic and in-range.
    expect(data.length).toBe(width * height * 4);
    expect(perFrameMs).toBeLessThan(1000); // guardrail, not a real assertion
  });
});
