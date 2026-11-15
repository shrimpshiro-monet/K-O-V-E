import { describe, it, expect } from "vitest";
import { HeadlessHost } from "./headless-host";
import { executeTool } from "./executor";
import { makeEmptyProject } from "./test-fixtures";
import { getMotionLayerLayoutBounds } from "@kove-advanced/core/motion/motion-layout";
import { DEFAULT_MOTION_TRANSFORM } from "@kove-advanced/core/motion/types";
import type {
  MotionComposition,
  MotionEffect,
  MotionLayer,
  MotionScene3DLayer,
  MotionShapeLayer,
} from "@kove-advanced/core/motion/types";
import type { Project } from "@kove-advanced/core/types/project";

const COMP_ID = "comp-compiler-tools";

function baseLayer(id: string): Omit<MotionLayer, "type"> {
  return {
    id,
    name: id,
    startTime: 0,
    duration: 4,
    visible: true,
    locked: false,
    transform: DEFAULT_MOTION_TRANSFORM,
    keyframes: [],
  } as Omit<MotionLayer, "type">;
}

function shapeLayer(id: string, overrides: Partial<MotionShapeLayer> = {}): MotionShapeLayer {
  return {
    ...baseLayer(id),
    type: "shape",
    shapeType: "rectangle",
    width: 200,
    height: 120,
    style: {
      fill: { type: "solid", color: "#14b8a6", opacity: 1 },
      stroke: { color: "#ffffff", width: 0, opacity: 1 },
    },
    ...overrides,
  } as MotionShapeLayer;
}

function positionedShape(id: string, x: number, y: number): MotionShapeLayer {
  return shapeLayer(id, {
    transform: { ...DEFAULT_MOTION_TRANSFORM, position: { x, y, z: 0 } },
  });
}

function projectWith(layers: MotionLayer[]): Project {
  const composition: MotionComposition = {
    id: COMP_ID,
    name: "Comp",
    width: 1280,
    height: 720,
    frameRate: 30,
    duration: 10,
    backgroundColor: "#101820",
    layers,
    assets: [],
    variables: [],
    markers: [],
    createdAt: 1,
    modifiedAt: 1,
  };
  return {
    ...makeEmptyProject(),
    motionCompositions: [composition],
  } as unknown as Project;
}

function comp(host: HeadlessHost): MotionComposition {
  return host
    .getProject()
    .motionCompositions!.find((candidate) => candidate.id === COMP_ID)!;
}

function layerById<T extends MotionLayer = MotionLayer>(host: HeadlessHost, id: string): T {
  return comp(host).layers.find((layer) => layer.id === id) as T;
}

function data(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("Expected data record");
  return value as Record<string, unknown>;
}

const blurEffect: MotionEffect = {
  id: "fx-blur",
  type: "blur",
  name: "Blur",
  enabled: true,
  radius: 8,
};

const glowEffect: MotionEffect = {
  id: "fx-glow",
  type: "glow",
  name: "Glow",
  enabled: true,
  color: "#ffcc00",
  intensity: 0.8,
  radius: 12,
};

describe("apply_motion_template", () => {
  it("creates a usable composition from the ad-card template", async () => {
    const host = new HeadlessHost(projectWith([]));
    const res = await executeTool("apply_motion_template", { templateId: "motion-ad-card" }, host);
    expect(res.ok).toBe(true);
    const compositionId = String(data(res.data).compositionId);
    const created = host
      .getProject()
      .motionCompositions!.find((candidate) => candidate.id === compositionId)!;
    expect(created.name).toBe("Ad Card");
    expect(created.duration).toBe(6);
    expect(created.layers.length).toBeGreaterThanOrEqual(2);
    expect(created.layers.some((layer) => layer.name === "Brand Wash")).toBe(true);
  });

  it("honors a custom composition name", async () => {
    const host = new HeadlessHost(projectWith([]));
    const res = await executeTool(
      "apply_motion_template",
      { templateId: "motion-ad-card", name: "Launch Spot" },
      host,
    );
    expect(res.ok).toBe(true);
    const compositionId = String(data(res.data).compositionId);
    const created = host
      .getProject()
      .motionCompositions!.find((candidate) => candidate.id === compositionId)!;
    expect(created.name).toBe("Launch Spot");
  });

  it("rejects an unknown template id", async () => {
    const host = new HeadlessHost(projectWith([]));
    const res = await executeTool("apply_motion_template", { templateId: "nope" }, host);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("NOT_FOUND");
  });
});

describe("add_motion_3d_object", () => {
  it("adds a real 3D sphere with material, lighting, and placement", async () => {
    const host = new HeadlessHost(projectWith([]));
    const res = await executeTool(
      "add_motion_3d_object",
      {
        compositionId: COMP_ID,
        object: "sphere",
        name: "Hero Sphere",
        x: 320,
        y: 240,
        size: 180,
        color: "#ff5533",
        metalness: 0.8,
        roughness: 0.2,
        rotationY: 45,
        environment: "studio",
        groundShadow: true,
      },
      host,
    );
    expect(res.ok).toBe(true);
    const layer = layerById<MotionScene3DLayer>(host, String(data(res.data).layerId));
    expect(layer.type).toBe("scene3d");
    expect(layer.name).toBe("Hero Sphere");
    expect(layer.object.kind).toBe("sphere");
    expect(layer.object.size).toBe(180);
    expect(layer.material?.color).toBe("#ff5533");
    expect(layer.material?.metalness).toBe(0.8);
    expect(layer.material?.roughness).toBe(0.2);
    expect(layer.lighting).toEqual({ environment: "studio", groundShadow: true });
    expect(layer.transform.position.x).toBe(320);
    expect(layer.transform.position.y).toBe(240);
    expect(layer.transform.rotation3d?.y).toBe(45);
    expect(comp(host).layers.length).toBe(1);
  });

  it("rejects unknown object kinds and unbuilt models", async () => {
    const host = new HeadlessHost(projectWith([]));
    const unknownKind = await executeTool(
      "add_motion_3d_object",
      { compositionId: COMP_ID, object: "dodecahedron" },
      host,
    );
    expect(unknownKind.ok).toBe(false);
    expect(unknownKind.error?.code).toBe("INVALID_PARAMS");

    const missingModel = await executeTool(
      "add_motion_3d_object",
      { compositionId: COMP_ID, object: "model" },
      host,
    );
    expect(missingModel.ok).toBe(false);
    expect(missingModel.error?.code).toBe("INVALID_PARAMS");
  });
});

describe("align_motion_layers", () => {
  it("aligns three cards to the left edge of their shared selection", async () => {
    const host = new HeadlessHost(
      projectWith([
        positionedShape("a", 100, 100),
        positionedShape("b", 400, 300),
        positionedShape("c", 700, 500),
      ] as MotionLayer[]),
    );
    const res = await executeTool(
      "align_motion_layers",
      { compositionId: COMP_ID, layerIds: ["a", "b", "c"], alignment: "left" },
      host,
    );
    expect(res.ok).toBe(true);
    const bounds = ["a", "b", "c"].map((id) =>
      getMotionLayerLayoutBounds(layerById(host, id)),
    );
    expect(bounds.map((entry) => entry.left)).toEqual([0, 0, 0]);
    expect(layerById(host, "a").transform.position.x).toBe(100);
    expect(layerById(host, "b").transform.position.x).toBe(100);
    expect(layerById(host, "c").transform.position.x).toBe(100);
    expect(layerById(host, "b").transform.position.y).toBe(300);
  });

  it("rejects an unknown alignment", async () => {
    const host = new HeadlessHost(projectWith([positionedShape("a", 100, 100)] as MotionLayer[]));
    const res = await executeTool(
      "align_motion_layers",
      { compositionId: COMP_ID, layerIds: ["a"], alignment: "diagonal" },
      host,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INVALID_PARAMS");
  });
});

describe("distribute_motion_layers", () => {
  it("evenly spaces the middle card between the outer two", async () => {
    const host = new HeadlessHost(
      projectWith([
        positionedShape("a", 100, 200),
        positionedShape("b", 250, 200),
        positionedShape("c", 800, 200),
      ] as MotionLayer[]),
    );
    const res = await executeTool(
      "distribute_motion_layers",
      { compositionId: COMP_ID, layerIds: ["a", "b", "c"], axis: "horizontal" },
      host,
    );
    expect(res.ok).toBe(true);
    const centers = ["a", "b", "c"].map(
      (id) => getMotionLayerLayoutBounds(layerById(host, id)).centerX,
    );
    expect(centers).toEqual([100, 450, 800]);
    expect(layerById(host, "b").transform.position.y).toBe(200);
  });

  it("requires at least three layers", async () => {
    const host = new HeadlessHost(
      projectWith([positionedShape("a", 100, 200), positionedShape("b", 400, 200)] as MotionLayer[]),
    );
    const res = await executeTool(
      "distribute_motion_layers",
      { compositionId: COMP_ID, layerIds: ["a", "b"], axis: "horizontal" },
      host,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INVALID_PARAMS");
  });
});

describe("set_motion_layer_visibility", () => {
  it("hides and shows the layer", async () => {
    const host = new HeadlessHost(projectWith([shapeLayer("a") as MotionLayer]));
    const hidden = await executeTool(
      "set_motion_layer_visibility",
      { compositionId: COMP_ID, layerId: "a", visible: false },
      host,
    );
    expect(hidden.ok).toBe(true);
    expect(layerById(host, "a").visible).toBe(false);

    const shown = await executeTool(
      "set_motion_layer_visibility",
      { compositionId: COMP_ID, layerId: "a", visible: true },
      host,
    );
    expect(shown.ok).toBe(true);
    expect(layerById(host, "a").visible).toBe(true);
  });

  it("fails for a missing layer and a non-boolean value", async () => {
    const host = new HeadlessHost(projectWith([shapeLayer("a") as MotionLayer]));
    const missing = await executeTool(
      "set_motion_layer_visibility",
      { compositionId: COMP_ID, layerId: "ghost", visible: false },
      host,
    );
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe("NOT_FOUND");

    const invalid = await executeTool(
      "set_motion_layer_visibility",
      { compositionId: COMP_ID, layerId: "a", visible: "yes" },
      host,
    );
    expect(invalid.ok).toBe(false);
    expect(invalid.error?.code).toBe("INVALID_PARAMS");
  });
});

describe("set_motion_layer_blend_mode", () => {
  it("sets a supported blend mode", async () => {
    const host = new HeadlessHost(projectWith([shapeLayer("a") as MotionLayer]));
    const res = await executeTool(
      "set_motion_layer_blend_mode",
      { compositionId: COMP_ID, layerId: "a", blendMode: "multiply" },
      host,
    );
    expect(res.ok).toBe(true);
    expect(layerById(host, "a").blendMode).toBe("multiply");
  });

  it("rejects an unsupported blend mode", async () => {
    const host = new HeadlessHost(projectWith([shapeLayer("a") as MotionLayer]));
    const res = await executeTool(
      "set_motion_layer_blend_mode",
      { compositionId: COMP_ID, layerId: "a", blendMode: "warp" },
      host,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INVALID_PARAMS");
  });
});

describe("toggle_motion_effect", () => {
  it("disables only the named effect and re-enables it", async () => {
    const host = new HeadlessHost(
      projectWith([shapeLayer("a", { effects: [blurEffect, glowEffect] }) as MotionLayer]),
    );
    const disabled = await executeTool(
      "toggle_motion_effect",
      { compositionId: COMP_ID, layerId: "a", effectId: "fx-blur", enabled: false },
      host,
    );
    expect(disabled.ok).toBe(true);
    const effects = layerById(host, "a").effects!;
    expect(effects.find((effect) => effect.id === "fx-blur")?.enabled).toBe(false);
    expect(effects.find((effect) => effect.id === "fx-glow")?.enabled).toBe(true);

    const enabled = await executeTool(
      "toggle_motion_effect",
      { compositionId: COMP_ID, layerId: "a", effectId: "fx-blur", enabled: true },
      host,
    );
    expect(enabled.ok).toBe(true);
    expect(layerById(host, "a").effects!.find((effect) => effect.id === "fx-blur")?.enabled).toBe(true);
  });

  it("reports a missing effect instead of pretending success", async () => {
    const host = new HeadlessHost(
      projectWith([shapeLayer("a", { effects: [blurEffect] }) as MotionLayer]),
    );
    const res = await executeTool(
      "toggle_motion_effect",
      { compositionId: COMP_ID, layerId: "a", effectId: "fx-ghost", enabled: false },
      host,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("NOT_FOUND");
  });
});

describe("remove_motion_effect", () => {
  it("removes only the named effect", async () => {
    const host = new HeadlessHost(
      projectWith([shapeLayer("a", { effects: [blurEffect, glowEffect] }) as MotionLayer]),
    );
    const res = await executeTool(
      "remove_motion_effect",
      { compositionId: COMP_ID, layerId: "a", effectId: "fx-blur" },
      host,
    );
    expect(res.ok).toBe(true);
    const effects = layerById(host, "a").effects!;
    expect(effects).toHaveLength(1);
    expect(effects[0]!.id).toBe("fx-glow");
  });

  it("reports a missing effect instead of pretending success", async () => {
    const host = new HeadlessHost(
      projectWith([shapeLayer("a", { effects: [blurEffect] }) as MotionLayer]),
    );
    const res = await executeTool(
      "remove_motion_effect",
      { compositionId: COMP_ID, layerId: "a", effectId: "fx-ghost" },
      host,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("NOT_FOUND");
  });
});
