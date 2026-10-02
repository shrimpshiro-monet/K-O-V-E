import { describe, expect, it } from "vitest";
import {
  CAMERA_MOVE_IDS,
  collectCameraMoveIds,
  compileCameraMoves,
  isCameraMoveId,
  normalizeCameraMove,
  segmentHasCameraMotion,
} from "./camera-moves";
import type { PlannedCameraMove } from "./edit-plan";

describe("camera move vocabulary", () => {
  it("exposes a closed, non-empty vocabulary", () => {
    expect(CAMERA_MOVE_IDS.length).toBeGreaterThan(8);
    expect(isCameraMoveId("slow-push")).toBe(true);
    expect(isCameraMoveId("slow-push-in-fancy")).toBe(false);
    expect(isCameraMoveId(undefined)).toBe(false);
  });

  it("coerces raw LLM input and drops junk instead of throwing", () => {
    expect(normalizeCameraMove({ move: "punch-in", intensity: 4, startTime: -2 })).toEqual({
      move: "punch-in",
      intensity: 1,
    });
    expect(normalizeCameraMove({ move: "not-a-move" })).toBeUndefined();
    expect(normalizeCameraMove("punch-in")).toBeUndefined();
  });

  it("compiles a slow push into scale keyframes anchored on frame zero", () => {
    const keyframes = compileCameraMoves([{ move: "slow-push", intensity: 1 }], 3);
    const x = keyframes.filter((keyframe) => keyframe.property === "scale.x");
    expect(x).toHaveLength(2);
    expect(x[0]).toMatchObject({ time: 0, value: 1 });
    expect(x[1]!.time).toBe(3);
    expect(x[1]!.value).toBeCloseTo(1.08, 5);
    // scale.y moves with scale.x so the push stays unletterboxed
    expect(keyframes.filter((keyframe) => keyframe.property === "scale.y")).toHaveLength(2);
  });

  it("composes overlapping moves additively and stays time-sorted per property", () => {
    const moves: PlannedCameraMove[] = [
      { move: "punch-in", intensity: 1 },
      { move: "breathe", intensity: 1 },
      { move: "handheld", intensity: 0.8 },
    ];
    const keyframes = compileCameraMoves(moves, 4);
    const properties = new Set(keyframes.map((keyframe) => keyframe.property));
    expect(properties).toEqual(new Set(["scale.x", "scale.y", "position.x", "position.y", "rotation"]));
    for (const property of properties) {
      const times = keyframes
        .filter((keyframe) => keyframe.property === property)
        .map((keyframe) => keyframe.time);
      expect([...times].sort((left, right) => left - right)).toEqual(times);
      expect(times[0]).toBe(0);
    }
    // The punch adds a scale delta on top of the breathe at t=0.
    const scaleStart = keyframes.find((keyframe) => keyframe.property === "scale.x" && keyframe.time === 0);
    expect(scaleStart!.value).toBeGreaterThanOrEqual(1);
  });

  it("clamps timing to the shot and honours intensity", () => {
    const keyframes = compileCameraMoves(
      [{ move: "slow-push", intensity: 0.5, startTime: 1, duration: 99 }],
      2,
    );
    expect(keyframes.every((keyframe) => keyframe.time >= 0 && keyframe.time <= 2)).toBe(true);
    const end = keyframes.find((keyframe) => keyframe.property === "scale.x" && keyframe.time === 2);
    expect(end!.value).toBeCloseTo(1.04, 5);
  });

  it("reports which moves a plan used, and whether a segment moves at all", () => {
    const moves: PlannedCameraMove[] = [
      { move: "slow-push" },
      { move: "handheld" },
      { move: "slow-push" },
    ];
    expect(collectCameraMoveIds(moves)).toEqual(["slow-push", "handheld"]);
    expect(segmentHasCameraMotion({ cameraMoves: moves })).toBe(true);
    expect(segmentHasCameraMotion({})).toBe(false);
  });

  it("produces nothing for an empty or zero-length shot", () => {
    expect(compileCameraMoves(undefined, 3)).toEqual([]);
    expect(compileCameraMoves([{ move: "punch-in" }], 0)).toEqual([]);
  });
});
