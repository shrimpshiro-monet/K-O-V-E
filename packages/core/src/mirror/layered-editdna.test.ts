import { describe, expect, it } from "vitest";
import { rebaseScene, validateLayeredEditDNA, type LayeredEditDNA } from "./layered-editdna";
import { overlappingCollageFixture, singleLayerMigrationFixture, textOverFootageFixture } from "./layered-editdna.fixtures";

const scene = textOverFootageFixture.scenes[0]!;
const footage = scene.layers[0]!;
const title = scene.layers[1]!;
const hero = scene.slots[0]!;

describe("layered EditDNA", () => {
  it("accepts text layered over footage", () => {
    expect(() => validateLayeredEditDNA(textOverFootageFixture)).not.toThrow();
  });

  it("accepts scenes that overlap in time", () => {
    const [first, second] = overlappingCollageFixture.scenes;
    expect(first!.endFrame).toBeGreaterThan(second!.startFrame);
    expect(() => validateLayeredEditDNA(overlappingCollageFixture)).not.toThrow();
  });

  it("accepts the single-layer v3 migration target", () => {
    expect(() => validateLayeredEditDNA(singleLayerMigrationFixture)).not.toThrow();
  });

  it("still requires retained v3 shots to tile the reference", () => {
    const invalid = {
      ...textOverFootageFixture,
      shots: [
        { startFrame: 0, endFrame: 30, captionWindows: [] },
        { startFrame: 40, endFrame: 60, captionWindows: [] },
      ],
    };
    expect(() => validateLayeredEditDNA(invalid)).toThrow(/tile/);
  });

  it("rejects a dangling evidence reference", () => {
    const invalid: LayeredEditDNA = {
      ...textOverFootageFixture,
      scenes: [{ ...scene, layers: [footage, { ...title, evidenceRef: "textOverlays[3]" }] }],
    };
    expect(() => validateLayeredEditDNA(invalid)).toThrow(/evidenceRef does not resolve/);
  });

  it("rejects a malformed evidence reference", () => {
    const invalid: LayeredEditDNA = {
      ...textOverFootageFixture,
      scenes: [{ ...scene, layers: [footage, { ...title, evidenceRef: "text overlay 0" }] }],
    };
    expect(() => validateLayeredEditDNA(invalid)).toThrow(/must look like/);
  });

  it("rebases a template scene and keeps internal references valid", () => {
    const sceneA = overlappingCollageFixture.scenes[0]!;
    const sceneB = overlappingCollageFixture.scenes[1]!;
    const shiftedA = rebaseScene(sceneA, 200, "-copy");
    const shiftedB = rebaseScene(sceneB, 200, "-copy");
    const profile: LayeredEditDNA = {
      ...overlappingCollageFixture,
      durationFrames: 290,
      shots: [{ startFrame: 0, endFrame: 290, captionWindows: [] }],
      rhythmCurve: [290],
      scenes: [shiftedA, shiftedB],
    };
    expect(() => validateLayeredEditDNA(profile)).not.toThrow();
    expect(shiftedA.startFrame).toBe(200);
    expect(shiftedA.layers[2]!.parentId).toBe("a-cutout-copy");
    expect(shiftedB.layers[1]!.mask!.sourceLayerId).toBe("b-bg-copy");
    expect(shiftedA.slots[1]!.layerId).toBe("a-cutout-copy");
  });

  it("round-trips timing when a rebased scene returns to its start", () => {
    const original = textOverFootageFixture.scenes[0]!;
    const shifted = rebaseScene(original, 60, "-copy");
    const profile: LayeredEditDNA = {
      ...textOverFootageFixture,
      durationFrames: 120,
      shots: [{ startFrame: 0, endFrame: 120, captionWindows: [] }],
      rhythmCurve: [120],
      scenes: [shifted],
    };
    expect(() => validateLayeredEditDNA(profile)).not.toThrow();
    expect(shifted.layers[0]!.transform.keyframes.map((keyframe) => keyframe.frame)).toEqual([60, 119]);
    expect(shifted.layers[1]!.evidenceRef).toBe("textOverlays[0]");
    expect(shifted.slots[0]!.layerId).toBe("footage-copy");
    const restored = rebaseScene(shifted, original.startFrame, "");
    expect(restored.layers.map((layer) => [layer.startFrame, layer.endFrame])).toEqual(
      original.layers.map((layer) => [layer.startFrame, layer.endFrame]),
    );
    expect(restored.layers[0]!.transform.keyframes.map((keyframe) => keyframe.frame)).toEqual(
      original.layers[0]!.transform.keyframes.map((keyframe) => keyframe.frame),
    );
    expect(restored.slots.map((slot) => [slot.startFrame, slot.endFrame])).toEqual(
      original.slots.map((slot) => [slot.startFrame, slot.endFrame]),
    );
  });

  it("rejects a layer that escapes its scene window", () => {
    const invalid = { ...textOverFootageFixture, scenes: [{ ...scene, layers: [{ ...footage, endFrame: 90 }, title] }] };
    expect(() => validateLayeredEditDNA(invalid)).toThrow(/inside its scene/);
  });

  it("rejects duplicate z-order within a scene", () => {
    const invalid = { ...textOverFootageFixture, scenes: [{ ...scene, layers: [footage, { ...title, zIndex: 0 }] }] };
    expect(() => validateLayeredEditDNA(invalid)).toThrow(/reuses zIndex/);
  });

  it("rejects parent cycles", () => {
    const invalid = {
      ...textOverFootageFixture,
      scenes: [{ ...scene, layers: [{ ...footage, parentId: "title" }, { ...title, parentId: "footage" }] }],
    };
    expect(() => validateLayeredEditDNA(invalid)).toThrow(/parent cycle/);
  });

  it("rejects a matte without a source layer", () => {
    const invalid: LayeredEditDNA = {
      ...textOverFootageFixture,
      scenes: [{ ...scene, layers: [{ ...footage, mask: { kind: "alpha-matte" } }, title] }],
    };
    expect(() => validateLayeredEditDNA(invalid)).toThrow(/must reference a source layer/);
  });

  it("rejects a slot that escapes its layer window", () => {
    const invalid = { ...textOverFootageFixture, scenes: [{ ...scene, slots: [{ ...hero, endFrame: 90 }] }] };
    expect(() => validateLayeredEditDNA(invalid)).toThrow(/inside its layer/);
  });

  it("requires a source for measured coverage", () => {
    const invalid: LayeredEditDNA = { ...textOverFootageFixture, coverage: { ...textOverFootageFixture.coverage, text: { status: "measured" } } };
    expect(() => validateLayeredEditDNA(invalid)).toThrow(/must name an evidence source/);
  });
});
