import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { PLAN_DUMP_DIR, dumpPlanJson } from "./baseline";

describe("dumpPlanJson — plan dumps persist for audit", () => {
  it("writes the produced plan under evaluation-files/plans/<entry>/<prompt>-run<n>.json", () => {
    // The audit's cheapest check is reading emitted effect params straight
    // out of these files (e.g. contrast sent as 50 vs 1.2).
    const plan = {
      segments: [
        { targetPosition: 0, effects: [{ type: "contrast", params: { value: 1.2 } }] },
      ],
    };
    const file = dumpPlanJson("entry-1", "prompt-1", 2, plan);
    expect(file).toBe(resolve(PLAN_DUMP_DIR, "entry-1", "prompt-1-run2.json"));
    expect(existsSync(file!)).toBe(true);
    const roundTrip = JSON.parse(readFileSync(file!, "utf8"));
    expect(roundTrip.segments[0].effects[0].params.value).toBe(1.2);
    rmSync(resolve(PLAN_DUMP_DIR, "entry-1"), { recursive: true, force: true });
  });
});
