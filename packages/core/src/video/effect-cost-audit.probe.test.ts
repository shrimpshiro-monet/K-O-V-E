import { describe, it } from "vitest";
import { VideoEffectsEngine } from "./video-effects-engine";

/**
 * PERF AUDIT (probe, not a regression test): cost of every CPU pixel-path
 * clip effect at 1920x1080, using representative parameter values. Effects
 * routed through buildCSSFilter (brightness, contrast, saturation, grayscale,
 * sepia, invert, hue, blur, shadow, glow) are composited by the browser's
 * ctx.filter and are NOT measured here; shader looks run on WebGL when
 * available. Everything measured below is a per-pixel JS loop on an 8.3 MB
 * buffer, plus the getImageData/putImageData round-trip the real pipeline
 * adds on top.
 *
 * Run: pnpm exec vitest run src/video/effect-cost-audit.probe.test.ts
 */

type PixelFn = (data: Uint8ClampedArray, ...rest: number[]) => void;

interface Case {
  readonly name: string;
  readonly method: string;
  readonly args: number[]; // after (data, width, height) or (data), per signature
  readonly passWidthHeight: boolean;
}

const W = 1920;
const H = 1080;

const CASES: Case[] = [
  { name: "sharpen (amount 100)", method: "applySharpenKernel", args: [100], passWidthHeight: true },
  { name: "vignette (0.5/0.5/0.5)", method: "applyVignette", args: [0.5, 0.5, 0.5], passWidthHeight: true },
  { name: "grain (amount 25)", method: "applyGrain", args: [25], passWidthHeight: false },
  { name: "temperature (30)", method: "applyTemperature", args: [30], passWidthHeight: false },
  { name: "tint (20)", method: "applyTint", args: [20], passWidthHeight: false },
  { name: "tonal (-1/-1/-0.4, crushed recipe)", method: "applyTonal", args: [-1, -1, -0.4], passWidthHeight: false },
  { name: "motion-blur (distance 20)", method: "applyMotionBlur", args: [W, H, 20, 0], passWidthHeight: false },
  { name: "radial-blur (amount 0.5)", method: "applyRadialBlur", args: [W, H, 0.5, 50, 50], passWidthHeight: false },
  { name: "chromatic-aberration (amount 8)", method: "applyChromaticAberration", args: [W, H, 8], passWidthHeight: false },
];

describe("clip-effect CPU cost audit (1920x1080)", () => {
  it("measures every pixel-path effect", () => {
    const engine = Object.create(VideoEffectsEngine.prototype) as unknown as Record<
      string,
      PixelFn
    >;

    const frame = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < frame.length; i += 4) {
      const v = (i * 7) % 256;
      frame[i] = v;
      frame[i + 1] = (v * 3) % 256;
      frame[i + 2] = (v * 5) % 256;
      frame[i + 3] = 255;
    }

    console.log(
      `[effect-cost-audit] ${W}x${H} — CPU pixel-path effects (JS loops; excludes getImageData/putImageData)`,
    );
    console.log(
      `${"effect".padEnd(40)} ${"ms/frame".padStart(9)} ${"60min (108k frames)".padStart(20)}`,
    );

    for (const c of CASES) {
      const fn = engine[c.method];
      if (typeof fn !== "function") {
        console.log(`${c.name.padEnd(40)} MISSING METHOD ${c.method}`);
        continue;
      }
      const call = (): void => {
        fn.apply(engine, c.passWidthHeight ? [frame, W, H, ...c.args] : [frame, ...c.args]);
      };
      call(); // warmup
      let iterations = 0;
      const t0 = performance.now();
      let elapsed = 0;
      do {
        call();
        iterations += 1;
        elapsed = performance.now() - t0;
      } while (iterations < 3 || (elapsed < 150 && iterations < 50));
      const perFrameMs = elapsed / iterations;
      const hourCost = (perFrameMs * 108000) / 60000; // minutes of CPU
      console.log(
        `${c.name.padEnd(40)} ${perFrameMs.toFixed(2).padStart(9)} ${`${hourCost.toFixed(1)} min`.padStart(20)}`,
      );
    }
  });
});
