import { describe, expect, it } from "vitest";
import { computeRenderSampleTimes, sampleRenderedDraft } from "./render-observation";
import { HeadlessHost } from "../headless-host";
import { makeEmptyProject } from "../test-fixtures";
import type { EditPlan } from "@kove-advanced/creation-schema";

function basePlan(segments: number): EditPlan {
  return {
    segments: Array.from({ length: segments }, (_, index) => ({
      sourceVideoId: "video-1",
      sourceStartTime: index * 2,
      sourceEndTime: index * 2 + 2,
      trackIndex: 0,
      targetPosition: index * 2,
      speed: 1,
      effects: [],
      effectSpecs: [],
      rationale: `shot ${index}`,
    })),
    textElements: [],
    effects: [],
    transitions: [],
    audioDecisions: [],
    metadata: { targetDuration: segments * 2, targetPlatform: "social", genre: "highlight-reel", pacing: "fast", rationale: "test" },
  } as unknown as EditPlan;
}

describe("computeRenderSampleTimes", () => {
  it("covers the opening and every segment midpoint", () => {
    const plan = basePlan(3);
    const placement = [0, 2, 4];
    const times = computeRenderSampleTimes(plan, placement);
    expect(times[0]).toBeCloseTo(0.15);
    for (let index = 0; index < 3; index += 1) {
      expect(times).toContain(index * 2 + 1);
    }
  });

  it("includes text overlay windows and transition junction posts", () => {
    const plan = {
      ...basePlan(2),
      textElements: [{ content: "hello", style: "title" as const, startTime: 1, duration: 2, rationale: "x" }],
      transitions: [{ afterSegmentIndex: 0, type: "crossfade", duration: 0.5, rationale: "x" }],
    } as EditPlan;
    const placement = [0, 2];
    const times = computeRenderSampleTimes(plan, placement);
    expect(times).toContain(2); // text middle at startTime + duration/2
    expect(times).toContain(2 + Math.min(0.25, 1 / 4)); // junction post
  });

  it("respects the sample cap and stays sorted without duplicates", () => {
    const plan = basePlan(40);
    const placement = Array.from({ length: 40 }, (_, index) => index * 2);
    const times = computeRenderSampleTimes(plan, placement);
    expect(times.length).toBeLessThanOrEqual(8);
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]).toBeGreaterThan(times[i - 1]);
    }
  });
});

describe("sampleRenderedDraft honesty", () => {
  it("returns undefined when the host cannot render timeline frames", async () => {
    const host = new HeadlessHost(makeEmptyProject());
    const sampling = await sampleRenderedDraft(host, basePlan(2));
    expect(sampling).toBeUndefined();
  });
});
