import { describe, expect, it } from "vitest";
import { validateLayeredEditDNA, type LayeredEditDNA } from "./layered-editdna";
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
