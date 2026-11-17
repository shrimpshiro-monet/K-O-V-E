import type { CameraMoveId } from "./edit-plan";
import { buildMographContract } from "./mograph-contract";

export type PageTemplateId = "headline-column-3up" | "avatar-body-3up";

export type PageTextPresetId =
  | "stacked-slam"
  | "vertical-headline"
  | "scatter-settle";

export type PageLayerRole = "background" | "headline" | "body" | "photo" | "avatar" | "footage";

export interface PageRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PageLayerMotion {
  readonly move: CameraMoveId;
  readonly intensity: number;
}

export interface PageLayerSpec {
  readonly id: string;
  readonly role: PageLayerRole;
  readonly rect: PageRect;
  readonly zIndex: number;
  readonly motion: readonly PageLayerMotion[];
  readonly slotId?: string;
  readonly textPreset?: PageTextPresetId;
  readonly text?: string;
  readonly borderRadius?: number;
}

export interface PagePhotoSlot {
  readonly id: string;
  readonly layerId: string;
  readonly rect: PageRect;
}

export interface PageTemplate {
  readonly id: PageTemplateId;
  readonly name: string;
  readonly description: string;
  readonly aspect: "vertical";
  readonly background: string;
  readonly layers: readonly PageLayerSpec[];
  readonly photoSlots: readonly PagePhotoSlot[];
}

export interface PageScene {
  readonly id: string;
  readonly templateId: PageTemplateId;
  readonly startTime: number;
  readonly durationSeconds: number;
  readonly hold: boolean;
  readonly layers: readonly PageLayerSpec[];
}

export interface PageSceneOptions {
  readonly id: string;
  readonly startTime: number;
  readonly durationSeconds: number;
  readonly hold?: boolean;
  readonly text?: Readonly<Record<string, string>>;
  readonly motionScale?: number;
}

export interface PageTemplateIssue {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export interface PageTimelineLayer {
  readonly id: string;
  readonly role: PageLayerRole;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly keyframes: number;
  readonly moves: readonly CameraMoveId[];
}

const PHOTO_RECTS: readonly PageRect[] = [
  { x: 0, y: 0, width: 1, height: 0.328 },
  { x: 0, y: 0.336, width: 1, height: 0.328 },
  { x: 0, y: 0.672, width: 1, height: 0.328 },
];

const PHOTO_MOTIONS: readonly (readonly PageLayerMotion[])[] = [
  [{ move: "punch-in", intensity: 0.55 }],
  [{ move: "drift-right", intensity: 0.45 }],
  [{ move: "breathe", intensity: 0.4 }],
];

const PHOTO_IDS = ["photo-1", "photo-2", "photo-3"] as const;

function photoLayers(): PageLayerSpec[] {
  return PHOTO_IDS.map((id, index) => ({
    id,
    role: "photo",
    rect: PHOTO_RECTS[index]!,
    zIndex: 2 + index,
    motion: PHOTO_MOTIONS[index]!,
    slotId: `slot-${id}`,
  }));
}

function photoSlots(): PagePhotoSlot[] {
  return PHOTO_IDS.map((id, index) => ({
    id: `slot-${id}`,
    layerId: id,
    rect: PHOTO_RECTS[index]!,
  }));
}

const HEADLINE_COLUMN_3UP: PageTemplate = {
  id: "headline-column-3up",
  name: "Headline Column + Body + 3-Up",
  description: "Editorial vertical page with a stacked headline, body column, and three photo slots.",
  aspect: "vertical",
  background: "#f3ead9",
  layers: [
    {
      id: "background",
      role: "background",
      rect: { x: 0, y: 0, width: 1, height: 1 },
      zIndex: 0,
      motion: [{ move: "slow-push", intensity: 0.22 }],
    },
    {
      id: "headline",
      role: "headline",
      rect: { x: 0.05, y: 0.05, width: 0.9, height: 0.15 },
      zIndex: 8,
      motion: [{ move: "drift-right", intensity: 0.3 }],
      textPreset: "stacked-slam",
      text: "STEPH CURRY",
    },
    {
      id: "body",
      role: "body",
      rect: { x: 0.05, y: 0.21, width: 0.9, height: 0.07 },
      zIndex: 7,
      motion: [{ move: "drift-left", intensity: 0.24 }],
      textPreset: "scatter-settle",
      text: "56 POINTS / ORLANDO",
    },
    ...photoLayers(),
  ],
  photoSlots: photoSlots(),
};

const AVATAR_BODY_3UP: PageTemplate = {
  id: "avatar-body-3up",
  name: "Avatar + Body + 3-Up",
  description: "Vertical profile page with a circular avatar, body column, and three photo slots.",
  aspect: "vertical",
  background: "#efe4d0",
  layers: [
    {
      id: "background",
      role: "background",
      rect: { x: 0, y: 0, width: 1, height: 1 },
      zIndex: 0,
      motion: [{ move: "drift-left", intensity: 0.2 }],
    },
    {
      id: "avatar",
      role: "avatar",
      rect: { x: 0.06, y: 0.05, width: 0.24, height: 0.135 },
      zIndex: 8,
      motion: [{ move: "breathe", intensity: 0.2 }],
      slotId: "slot-avatar",
      borderRadius: 50,
    },
    {
      id: "body",
      role: "body",
      rect: { x: 0.32, y: 0.05, width: 0.62, height: 0.16 },
      zIndex: 7,
      motion: [{ move: "slow-push", intensity: 0.2 }],
      textPreset: "vertical-headline",
      text: "NIGHT 56 / ORLANDO",
    },
    ...photoLayers(),
  ],
  photoSlots: [
    {
      id: "slot-avatar",
      layerId: "avatar",
      rect: { x: 0.06, y: 0.05, width: 0.24, height: 0.135 },
    },
    ...photoSlots(),
  ],
};

export const PAGE_TEMPLATES: readonly PageTemplate[] = [
  HEADLINE_COLUMN_3UP,
  AVATAR_BODY_3UP,
];

export function getPageTemplate(id: PageTemplateId): PageTemplate | undefined {
  return PAGE_TEMPLATES.find((template) => template.id === id);
}

export function createPageScene(
  templateId: PageTemplateId,
  options: PageSceneOptions,
): PageScene {
  const template = getPageTemplate(templateId);
  if (!template) throw new Error(`Unknown page template: ${templateId}`);
  if (!Number.isFinite(options.durationSeconds) || options.durationSeconds <= 0) {
    throw new Error("Page scene duration must be a positive number");
  }
  const motionScale = options.motionScale ?? 1;
  const layers = template.layers.map((layer) => ({
    ...layer,
    text: options.text?.[layer.id] ?? layer.text,
    motion: options.hold
      ? []
      : layer.motion.map((motion) => ({
          ...motion,
          intensity: Math.max(0.05, motion.intensity * motionScale),
        })),
  }));
  return {
    id: options.id,
    templateId,
    startTime: options.startTime,
    durationSeconds: options.durationSeconds,
    hold: options.hold ?? false,
    layers,
  };
}

export function applyMographPageContract(scene: PageScene): PageScene {
  if (scene.hold) {
    return {
      ...scene,
      layers: scene.layers.map((layer) => ({ ...layer, motion: [] })),
    };
  }
  const contract = buildMographContract(scene.durationSeconds);
  const layers = scene.layers.map((layer, index) => {
    if (layer.motion.length > 0) return layer;
    const move = contract.idleMoves[index % contract.idleMoves.length]!;
    return {
      ...layer,
      motion: [{ move, intensity: 0.28 }],
    };
  });
  return { ...scene, layers };
}

export function validateMographPageScene(scene: PageScene): readonly PageTemplateIssue[] {
  const issues: PageTemplateIssue[] = [];
  const template = getPageTemplate(scene.templateId);
  const slots = new Set(template?.photoSlots.map((slot) => slot.id) ?? []);
  for (const layer of scene.layers) {
    const path = `layers.${layer.id}`;
    if (scene.hold) {
      if (layer.motion.length > 0) {
        issues.push({
          severity: "error",
          code: "page_hold_motion",
          message: `Hold layer ${layer.id} must stay still.`,
          path: `${path}.motion`,
        });
      }
      continue;
    }
    if (layer.motion.length === 0) {
      issues.push({
        severity: "error",
        code: "page_layer_motion_missing",
        message: `Layer ${layer.id} has no idle motion. Every page layer moves.`,
        path: `${path}.motion`,
      });
    }
    if ((layer.role === "headline" || layer.role === "body") && !layer.textPreset) {
      issues.push({
        severity: "error",
        code: "page_text_preset_missing",
        message: `Text layer ${layer.id} needs a text preset.`,
        path: `${path}.textPreset`,
      });
    }
    if ((layer.role === "footage" || layer.role === "photo" || layer.role === "avatar") && !layer.slotId) {
      issues.push({
        severity: "error",
        code: "page_raw_footage",
        message: `Layer ${layer.id} must live inside a photo slot.`,
        path,
      });
    }
    if (layer.slotId && !slots.has(layer.slotId)) {
      issues.push({
        severity: "error",
        code: "page_slot_missing",
        message: `Layer ${layer.id} points at missing slot ${layer.slotId}.`,
        path: `${path}.slotId`,
      });
    }
  }
  return issues;
}

export function pageSceneTimelineLayers(
  scene: PageScene,
  videoDurationSeconds: number,
): readonly PageTimelineLayer[] {
  return scene.layers.map((layer) => {
    const keyframes = scene.hold ? 0 : Math.max(0, layer.motion.length) * 2;
    return {
      id: layer.id,
      role: layer.role,
      startSeconds: scene.startTime,
      endSeconds: Math.min(
        videoDurationSeconds,
        scene.startTime + scene.durationSeconds,
      ),
      keyframes,
      moves: scene.hold ? [] : layer.motion.map((motion) => motion.move),
    };
  });
}
