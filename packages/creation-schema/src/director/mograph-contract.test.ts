import { describe, expect, it } from "vitest";
import type { EditPlan, PlannedSegment } from "./edit-plan";
import {
  applyMographContract,
  buildMographContract,
  isMographRequest,
  validateMographPlan,
} from "./mograph-contract";

function segment(
  targetPosition: number,
  duration: number,
  overrides: Partial<PlannedSegment> = {},
): PlannedSegment {
  return {
    sourceVideoId: "source",
    sourceStartTime: targetPosition,
    sourceEndTime: targetPosition + duration,
    targetPosition,
    trackIndex: 0,
    effects: [],
    rationale: "test",
    ...overrides,
  };
}

function plan(segments: readonly PlannedSegment[]): EditPlan {
  return {
    segments,
    textElements: [],
    effects: [],
    transitions: [],
    audioDecisions: [],
    metadata: {
      targetDuration: 28,
      targetPlatform: "tiktok",
      genre: "magazine",
      pacing: "fast",
      rationale: "test",
    },
  };
}

function magazinePlan(): EditPlan {
  return plan([
    segment(0, 4),
    segment(4, 4),
    segment(8, 4),
    segment(12, 4),
    segment(16, 4),
    segment(20, 1),
    segment(21, 2, { hold: true }),
    segment(23, 5),
  ]);
}

describe("mograph contract", () => {
  it("detects mograph requests from prompts, genres and references", () => {
    expect(isMographRequest("make a magazine edit")).toBe(true);
    expect(isMographRequest("make a tiktok edit")).toBe(false);
    expect(isMographRequest("anything", { name: "Editorial Collage" })).toBe(true);
    expect(isMographRequest("anything", undefined, { version: "kove.mograph.v1" })).toBe(true);
    expect(isMographRequest("anything", undefined, { scenes: [{ kind: "object-wall" }] })).toBe(true);
  });

  it("builds a five-phase arc with one late hold", () => {
    const contract = buildMographContract(28);
    expect(contract.hookNoHardCutSeconds).toBe(4);
    expect(contract.phases.map((phase) => phase.id)).toEqual([
      "hook",
      "build",
      "peak",
      "hold",
      "exit",
    ]);
    expect(contract.phases[0]?.hardCutsAllowed).toBe(false);
    expect(contract.phases[3]?.shotSeconds).toEqual([1.5, 2.5]);
  });

  it("adds default idle motion to every non-hold segment and leaves the hold still", () => {
    const enforced = applyMographContract(magazinePlan());
    expect(enforced.segments[6]?.hold).toBe(true);
    expect(enforced.segments[6]?.cameraMoves).toEqual([]);
    enforced.segments.forEach((segment, index) => {
      if (index === 6) return;
      expect(segment.cameraMoves?.length).toBe(1);
    });
    expect(validateMographPlan(enforced).filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("rejects a hook cut before four seconds", () => {
    const cutPlan = plan([
      segment(0, 3),
      segment(3, 2),
      segment(5, 23, { hold: true }),
    ]);
    const issues = validateMographPlan(cutPlan);
    expect(issues).toContainEqual(expect.objectContaining({ code: "mograph_hook_cut" }));
  });

  it("rejects a missing hold and a moving hold", () => {
    const noHold = plan([
      segment(0, 4, { cameraMoves: [{ move: "slow-push", intensity: 0.3 }] }),
      segment(4, 24, { cameraMoves: [{ move: "breathe", intensity: 0.25 }] }),
    ]);
    const missing = validateMographPlan(noHold);
    expect(missing).toContainEqual(expect.objectContaining({ code: "mograph_hold_count" }));

    const configured = applyMographContract(magazinePlan());
    const moving = {
      ...configured,
      segments: configured.segments.map((segment, index) =>
        index === 6
          ? { ...segment, cameraMoves: [{ move: "slow-push" as const, intensity: 0.4 }] }
          : segment,
      ),
    };
    const issues = validateMographPlan(moving);
    expect(issues).toContainEqual(expect.objectContaining({ code: "mograph_hold_motion" }));
  });
});
