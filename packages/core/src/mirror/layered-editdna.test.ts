import { describe, expect, it } from "vitest";
import { migrateReferenceProfileToLayered, rebaseScene, validateLayeredEditDNA, type LayeredEditDNA } from "./layered-editdna";
import { createReferenceProfile, type ReferenceProfile } from "./reference-profile";
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

function v3Profile(): ReferenceProfile {
  return createReferenceProfile({
    fps: { num: 30, den: 1 },
    fpsSource: "ffprobe",
    durationFrames: 90,
    aspectRatio: { width: 1920, height: 1080 },
    shots: [
      { startFrame: 0, endFrame: 30, captionWindows: [] },
      { startFrame: 30, endFrame: 90, captionWindows: [] },
    ],
    beatGridMs: [1000, 2000],
    structure: {
      editRange: { startFrame: 0, endFrame: 90 },
      events: [
        {
          frame: 30,
          type: "hard-cut",
          durationFrames: 1,
          intensity: 1,
          confidence: 0.9,
          source: "local-pixel-analysis",
        },
      ],
      energyCurve: [0.2, 0.4, 0.8],
      density: { cutsPerSec: 1, eventsPerSec: 1, byType: { "hard-cut": 1 } },
      shotLengths: { median: 45, p25: 30, p75: 60, min: 30, max: 60 },
    },
    styleEvidence: {
      transitions: [{ startFrame: 29, endFrame: 31, type: "hard-cut", source: "local-pixel-analysis", confidence: 0.9 }],
      textOverlays: [
        {
          startFrame: 10,
          endFrame: 25,
          bounds: { x: 0.1, y: 0.7, width: 0.8, height: 0.2 },
          text: "HELLO",
          source: "local-ocr",
          confidence: 0.8,
        },
      ],
      effects: [],
    },
  });
}

describe("layered EditDNA migration", () => {
  it("migrates a v3 profile into one scene per shot without losing retained fields", () => {
    const profile = v3Profile();
    const layered = migrateReferenceProfileToLayered(profile);
    expect(layered.version).toBe("kove.mirror.v4");
    expect(layered.scenes).toHaveLength(profile.shots.length);
    layered.scenes.forEach((scene, index) => {
      const shot = profile.shots[index]!;
      expect([scene.startFrame, scene.endFrame]).toEqual([shot.startFrame, shot.endFrame]);
      expect(scene.layers).toHaveLength(1);
      expect(scene.layers[0]!.kind).toBe("footage");
      expect([scene.layers[0]!.startFrame, scene.layers[0]!.endFrame]).toEqual([shot.startFrame, shot.endFrame]);
      expect(scene.slots[0]!.layerId).toBe(scene.layers[0]!.id);
    });
    expect(layered.shots).toEqual(profile.shots);
    expect(layered.rhythmCurve).toEqual(profile.rhythmCurve);
    expect(layered.beatGridMs).toEqual(profile.beatGridMs);
    expect(layered.styleEvidence).toEqual(profile.styleEvidence);
    expect(layered.structure).toEqual(profile.structure);
    expect(layered.structure?.events).toHaveLength(1);
    expect(layered.warnings?.some((warning) => warning.includes("Layered graph migrated"))).toBe(true);
    expect(layered.coverage.layers?.status).toBe("not-attempted");
    expect(() => validateLayeredEditDNA(layered)).not.toThrow();
  });

  it("carries over coverage for the five features v3 measured", () => {
    const layered = migrateReferenceProfileToLayered(v3Profile());
    expect(layered.coverage.cuts).toMatchObject({ status: "measured", source: "local-pixel-analysis" });
    expect(layered.coverage.transitions).toMatchObject({ status: "measured", source: "local-pixel-analysis", confidence: 0.9 });
    expect(layered.coverage.text).toMatchObject({ status: "measured", source: "local-ocr", confidence: 0.8 });
    expect(layered.coverage.camera?.status).toBe("not-attempted");
    expect(layered.coverage.color?.status).toBe("not-attempted");
  });

  it("carries camera and color coverage when v3 retained per-shot measurements", () => {
    const profile = v3Profile();
    profile.shots[0]!.cameraMotion = {
      dominantMove: "pan",
      samples: [
        { frame: 0, translateX: 0, translateY: 0, rotationRad: 0, scale: 1 },
        { frame: 15, translateX: 1, translateY: 0, rotationRad: 0, scale: 1.02 },
      ],
    };
    profile.shots[0]!.colorStats = { lMean: 0.5, lStd: 0.1, aMean: 0, aStd: 0.05, bMean: 0, bStd: 0.05 };
    const layered = migrateReferenceProfileToLayered(profile);
    expect(layered.coverage.camera).toMatchObject({ status: "measured", source: "local-pixel-analysis", confidence: 0.7 });
    expect(layered.coverage.color).toMatchObject({ status: "measured", source: "local-pixel-analysis", confidence: 0.6 });
  });

  it("rejects a profile that is not v3", () => {
    expect(() => migrateReferenceProfileToLayered(textOverFootageFixture as unknown as ReferenceProfile)).toThrow(/v3 profile/);
  });
});
