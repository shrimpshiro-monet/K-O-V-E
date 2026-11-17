import { describe, expect, it } from "vitest";
import {
  PAGE_TEMPLATES,
  applyMographPageContract,
  createPageScene,
  pageSceneTimelineLayers,
  validateMographPageScene,
} from "./page-templates";

describe("mograph page templates", () => {
  it("ships two vertical page templates with three-up photo slots and moving layers", () => {
    expect(PAGE_TEMPLATES).toHaveLength(2);
    for (const template of PAGE_TEMPLATES) {
      expect(template.aspect).toBe("vertical");
      expect(template.layers).toHaveLength(6);
      expect(template.photoSlots.length).toBeGreaterThanOrEqual(3);
      expect(template.layers.every((layer) => layer.motion.length > 0)).toBe(true);
      expect(
        template.layers
          .filter((layer) => layer.role === "photo")
          .every((layer) => layer.slotId),
      ).toBe(true);
    }
  });

  it("applies idle motion to every non-hold page layer", () => {
    const scene = applyMographPageContract(
      createPageScene("headline-column-3up", {
        id: "hook",
        startTime: 0,
        durationSeconds: 7,
      }),
    );

    expect(scene.layers).toHaveLength(6);
    expect(scene.layers.every((layer) => layer.motion.length > 0)).toBe(true);
    expect(validateMographPageScene(scene)).toEqual([]);

    const timeline = pageSceneTimelineLayers(scene, 28);
    expect(timeline.every((layer) => layer.keyframes > 0)).toBe(true);
  });

  it("keeps hold layers still and excludes their keyframes from the manifest", () => {
    const scene = applyMographPageContract(
      createPageScene("avatar-body-3up", {
        id: "hold",
        startTime: 21,
        durationSeconds: 2.5,
        hold: true,
      }),
    );

    expect(scene.layers.every((layer) => layer.motion.length === 0)).toBe(true);
    expect(validateMographPageScene(scene)).toEqual([]);
    expect(
      pageSceneTimelineLayers(scene, 28).every((layer) => layer.keyframes === 0),
    ).toBe(true);
  });

  it("rejects raw photo layers without a slot and text without a preset", () => {
    const scene = createPageScene("headline-column-3up", {
      id: "broken",
      startTime: 0,
      durationSeconds: 4,
    });
    const broken = {
      ...scene,
      layers: scene.layers.map((layer) => {
        if (layer.id === "photo-1") return { ...layer, slotId: undefined };
        if (layer.id === "headline") return { ...layer, textPreset: undefined };
        return layer;
      }),
    };

    const issues = validateMographPageScene(broken);

    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["page_raw_footage", "page_text_preset_missing"]),
    );
  });
});
