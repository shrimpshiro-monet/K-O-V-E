import { describe, expect, it } from "vitest";
import {
  REFRAME_KEYFRAME_PROPERTIES,
  reframeBaseSize,
  reframePlanToTransformKeyframes,
  reframeTransformForCrop,
  staticReframeKeyframes,
  type ReframeCropKeyframe,
} from "./auto-reframe-apply";

/** 16:9 source into a 9:16 canvas — the classic "make it vertical" case. */
const VERTICAL_GEOMETRY = {
  mediaWidth: 1920,
  mediaHeight: 1080,
  canvasWidth: 1080,
  canvasHeight: 1920,
} as const;

const crop = (overrides: Partial<ReframeCropKeyframe> = {}): ReframeCropKeyframe => ({
  time: 0,
  cropX: 0.25,
  cropY: 0,
  cropWidth: 0.5,
  cropHeight: 1,
  ...overrides,
});

describe("reframeBaseSize", () => {
  it("letterboxes a wide source into a tall canvas (contain)", () => {
    const base = reframeBaseSize(VERTICAL_GEOMETRY);
    // Width-limited: the media fills the canvas width and is short in height.
    expect(base.width).toBeCloseTo(1, 6);
    expect(base.height).toBeCloseTo(1080 / 1920 / (1920 / 1080), 6);
  });

  it("treats an unset fit mode as contain and stretch as full-canvas", () => {
    expect(reframeBaseSize({ ...VERTICAL_GEOMETRY, fitMode: "none" })).toEqual(
      reframeBaseSize({ ...VERTICAL_GEOMETRY, fitMode: "contain" }),
    );
    expect(reframeBaseSize({ ...VERTICAL_GEOMETRY, fitMode: "stretch" })).toEqual({
      width: 1,
      height: 1,
    });
  });
});

describe("reframeTransformForCrop", () => {
  it("scales a centred crop so it fills the canvas without moving the clip", () => {
    const transform = reframeTransformForCrop(
      crop({ cropX: 0.25, cropWidth: 0.5, cropHeight: 1 }),
      VERTICAL_GEOMETRY,
    );
    // Crop is centred horizontally, so no shift; it must grow to fill the frame.
    expect(transform.positionX).toBeCloseTo(0, 6);
    expect(transform.scale).toBeGreaterThan(1.5);
  });

  it("shifts the clip the other way when the subject sits off-centre", () => {
    const left = reframeTransformForCrop(crop({ cropX: 0 }), VERTICAL_GEOMETRY);
    const right = reframeTransformForCrop(crop({ cropX: 0.5 }), VERTICAL_GEOMETRY);

    // Crop on the left third: the clip must move right so that region lands
    // centre-frame (and vice versa).
    expect(left.positionX).toBeGreaterThan(0);
    expect(right.positionX).toBeLessThan(0);
    expect(left.positionX).toBeGreaterThan(right.positionX);
  });

  it("keeps the crop inside the frame axis it does not scale", () => {
    // A full-height centre crop is already the frame height: no vertical shift.
    const transform = reframeTransformForCrop(crop({ cropY: 0, cropHeight: 1 }), VERTICAL_GEOMETRY);
    expect(transform.positionY).toBeCloseTo(0, 6);
  });
});

describe("reframePlanToTransformKeyframes", () => {
  const plan: ReframeCropKeyframe[] = [
    crop({ time: 0, cropX: 0 }),
    crop({ time: 1, cropX: 0.25 }),
    crop({ time: 2, cropX: 0.5 }),
  ];

  it("emits all four animated properties per kept sample", () => {
    const keyframes = reframePlanToTransformKeyframes(plan, VERTICAL_GEOMETRY, {
      createId: idGenerator(),
    });

    expect(keyframes).toHaveLength(plan.length * REFRAME_KEYFRAME_PROPERTIES.length);
    for (const property of REFRAME_KEYFRAME_PROPERTIES) {
      const forProperty = keyframes.filter((keyframe) => keyframe.property === property);
      expect(forProperty).toHaveLength(plan.length);
      expect(forProperty.map((keyframe) => keyframe.time)).toEqual([0, 1, 2]);
      expect(forProperty.every((keyframe) => keyframe.easing === "linear")).toBe(true);
      expect(forProperty.every((keyframe) => typeof keyframe.value === "number")).toBe(true);
    }
  });

  it("follows the subject: position.x sweeps as the crop moves right", () => {
    const keyframes = reframePlanToTransformKeyframes(plan, VERTICAL_GEOMETRY, {
      createId: idGenerator(),
    });
    const x = keyframes
      .filter((keyframe) => keyframe.property === "position.x")
      .map((keyframe) => keyframe.value as number);

    expect(x[0]).toBeGreaterThan(x[1]);
    expect(x[1]).toBeGreaterThan(x[2]);
  });

  it("drops samples that do not move the camera", () => {
    const still = [crop({ time: 0 }), crop({ time: 1 }), crop({ time: 2 })];
    const keyframes = reframePlanToTransformKeyframes(still, VERTICAL_GEOMETRY, {
      createId: idGenerator(),
    });

    // One static sample: the clip is just scaled/positioned once.
    expect(keyframes).toHaveLength(REFRAME_KEYFRAME_PROPERTIES.length);
    expect(keyframes[0].time).toBe(0);
  });

  it("maps source times onto the clip-local clock", () => {
    // Source seconds inside the clip's window (inPoint 2 .. ), played at 2x.
    const windowed = [crop({ time: 2, cropX: 0 }), crop({ time: 3 }), crop({ time: 4, cropX: 0.5 })];
    const keyframes = reframePlanToTransformKeyframes(windowed, VERTICAL_GEOMETRY, {
      createId: idGenerator(),
      timeMapping: { startTime: 10, inPoint: 2, speed: 2 },
    });
    const times = keyframes
      .filter((keyframe) => keyframe.property === "scale.x")
      .map((keyframe) => keyframe.time);

    // start 10 + (source - inPoint 2) / speed 2, and never before the clip.
    expect(times).toEqual([10, 10.5, 11]);
  });

  it("clamps samples that fall before the clip's in-point", () => {
    const keyframes = reframePlanToTransformKeyframes(
      [crop({ time: 0, cropX: 0 }), crop({ time: 2 // at the in-point
        , cropX: 0.5 })],
      VERTICAL_GEOMETRY,
      {
        createId: idGenerator(),
        timeMapping: { startTime: 10, inPoint: 2, speed: 1 },
      },
    );
    const times = keyframes
      .filter((keyframe) => keyframe.property === "position.x")
      .map((keyframe) => keyframe.time);

    expect(times).toEqual([10, 10]);
  });

  it("caps the keyframe count while keeping the plan's start", () => {
    const long = Array.from({ length: 400 }, (_, index) =>
      crop({ time: index / 10, cropX: (index % 20) / 40 }),
    );
    const keyframes = reframePlanToTransformKeyframes(long, VERTICAL_GEOMETRY, {
      createId: idGenerator(),
      maxKeyframes: 10,
    });
    const forProperty = keyframes.filter((keyframe) => keyframe.property === "position.x");

    expect(forProperty.length).toBeLessThanOrEqual(10);
    expect(forProperty[0].time).toBe(0);
  });

  it("returns nothing for an empty plan", () => {
    expect(reframePlanToTransformKeyframes([], VERTICAL_GEOMETRY)).toEqual([]);
  });
});

describe("staticReframeKeyframes", () => {
  it("writes an identity transform the renderer can interpolate", () => {
    const keyframes = staticReframeKeyframes(1.5, idGenerator());
    expect(keyframes.map((keyframe) => keyframe.property)).toEqual([
      ...REFRAME_KEYFRAME_PROPERTIES,
    ]);
    expect(keyframes.every((keyframe) => keyframe.time === 1.5)).toBe(true);
    expect(
      keyframes
        .filter((keyframe) => keyframe.property.startsWith("position"))
        .every((keyframe) => keyframe.value === 0),
    ).toBe(true);
    expect(
      keyframes
        .filter((keyframe) => keyframe.property.startsWith("scale"))
        .every((keyframe) => keyframe.value === 1),
    ).toBe(true);
  });
});

function idGenerator(): () => string {
  let next = 0;
  return () => `kf-${(next += 1)}`;
}
