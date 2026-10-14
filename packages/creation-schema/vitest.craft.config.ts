import { defineConfig } from "vitest/config";

/**
 * Test config for the craft-eval bridge (`tools/kove-eval/bridge`).
 *
 * The bridge exists so the evaluation harness can call *this package's* real
 * planner code — `snapPlanToBeatGrid`, `measureTimelineBeatAlignment` — instead of
 * reimplementing beat snapping in Python, which would measure a different
 * algorithm than the one that ships.
 *
 * It needs its own config because the default one roots at this package and
 * excludes everything outside it, and the bridge lives outside it. The config
 * sits here rather than in `tools/kove-eval` so `vitest/config` resolves.
 */
export default defineConfig({
  root: new URL("../..", import.meta.url).pathname,
  test: {
    include: ["tools/kove-eval/bridge/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
