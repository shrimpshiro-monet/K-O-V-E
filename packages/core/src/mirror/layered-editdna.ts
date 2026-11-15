import { validateReferenceProfile, type NormalizedFrameRect, type ReferenceEvidenceSource, type ReferenceProfile } from "./reference-profile";

export const LAYERED_EDIT_DNA_VERSION = "kove.mirror.v4" as const;
export type LayeredEditDNAVersion = typeof LAYERED_EDIT_DNA_VERSION;

export type StyleEvidenceStatus = "measured" | "inferred" | "not-attempted";

export const STYLE_FEATURES = [
  "cuts",
  "camera",
  "color",
  "text",
  "transitions",
  "layers",
  "masks",
  "parents",
  "fonts",
  "semantic-effects",
  "slots",
] as const;
export type StyleFeature = (typeof STYLE_FEATURES)[number];

export interface StyleProvenance {
  readonly status: StyleEvidenceStatus;
  readonly source?: ReferenceEvidenceSource;
  readonly confidence?: number;
  readonly note?: string;
}

export type StyleCoverage = Partial<Record<StyleFeature, StyleProvenance>>;

export interface LayerTransform {
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly rotationDegrees: number;
  readonly opacity: number;
  readonly anchorX: number;
  readonly anchorY: number;
}

export type LayerEasing = "linear" | "ease-in" | "ease-out" | "ease-in-out" | "hold";

export interface LayerKeyframe {
  readonly frame: number;
  readonly easing: LayerEasing;
  readonly transform: Partial<LayerTransform>;
}

export interface TransformTrack {
  readonly base: LayerTransform;
  readonly keyframes: readonly LayerKeyframe[];
  readonly provenance?: StyleProvenance;
}

/**
 * Structural layer only. Content payloads — text string, font choice, animation
 * preset, effect id/parameters, and shape geometry — are deliberately out of
 * the v4.0 graph. They arrive as a discriminated layer-content union before
 * issue 5 fills text and effect layers.
 */
export type LayerKind = "footage" | "still" | "text" | "shape" | "effect" | "adjustment" | "unknown";

export type MaskKind =
  | "none"
  | "rectangle"
  | "ellipse"
  | "rounded-rectangle"
  | "alpha-matte"
  | "luma-matte"
  | "unknown";

export interface LayerMask {
  readonly kind: MaskKind;
  readonly bounds?: NormalizedFrameRect;
  readonly feather?: number;
  readonly inverted?: boolean;
  readonly sourceLayerId?: string;
  readonly provenance?: StyleProvenance;
}

export interface StyleLayer {
  readonly id: string;
  readonly kind: LayerKind;
  readonly zIndex: number;
  readonly parentId?: string;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly transform: TransformTrack;
  readonly mask?: LayerMask;
  /**
   * Path to the retained v3 evidence item this layer was derived from, e.g.
   * "textOverlays[0]", "effects[2]", or "transitions[1]". The item must exist
   * in the retained profile. `rebaseScene` leaves this reference unchanged.
   */
  readonly evidenceRef?: string;
  readonly provenance?: StyleProvenance;
}

export type SlotRole = "hero" | "b-roll" | "cutout" | "background" | "logo" | "text" | "unknown";

export interface SlotConstraints {
  readonly minDurationFrames?: number;
  readonly preferredAspectRatio?: number;
  readonly faceSafe?: boolean;
  readonly containsText?: boolean;
}

export interface ContentSlot {
  readonly id: string;
  readonly layerId: string;
  readonly role: SlotRole;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly constraints?: SlotConstraints;
  readonly provenance?: StyleProvenance;
}

export interface LayeredScene {
  readonly id: string;
  readonly revision: number;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly layers: readonly StyleLayer[];
  readonly slots: readonly ContentSlot[];
  readonly coverage?: StyleCoverage;
}

export interface LayeredEditDNA extends Omit<ReferenceProfile, "version"> {
  readonly version: LayeredEditDNAVersion;
  readonly scenes: readonly LayeredScene[];
  readonly coverage: StyleCoverage;
}

const STATUSES: readonly StyleEvidenceStatus[] = ["measured", "inferred", "not-attempted"];
const LAYER_KINDS: readonly LayerKind[] = ["footage", "still", "text", "shape", "effect", "adjustment", "unknown"];
const MASK_KINDS: readonly MaskKind[] = ["none", "rectangle", "ellipse", "rounded-rectangle", "alpha-matte", "luma-matte", "unknown"];
const SLOT_ROLES: readonly SlotRole[] = ["hero", "b-roll", "cutout", "background", "logo", "text", "unknown"];
const EASINGS: readonly LayerEasing[] = ["linear", "ease-in", "ease-out", "ease-in-out", "hold"];
const MATTE_KINDS: readonly MaskKind[] = ["alpha-matte", "luma-matte"];

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function validateProvenance(value: StyleProvenance | undefined, label: string): void {
  if (!value) return;
  check(STATUSES.includes(value.status), `${label} has an invalid evidence status`);
  if (value.status === "not-attempted") return;
  check(value.source !== undefined, `${label} must name an evidence source`);
  check(
    value.confidence !== undefined && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1,
    `${label} confidence must be 0..1`,
  );
}

function validateCoverage(coverage: StyleCoverage | undefined, label: string): void {
  if (!coverage) return;
  for (const [feature, entry] of Object.entries(coverage)) {
    check((STYLE_FEATURES as readonly string[]).includes(feature), `${label} has an unknown coverage feature: ${feature}`);
    validateProvenance(entry, `${label}.${feature}`);
  }
}

function validateTransform(track: TransformTrack, startFrame: number, endFrame: number, label: string): void {
  const base = track.base;
  check(
    [base.x, base.y, base.scaleX, base.scaleY, base.rotationDegrees, base.opacity, base.anchorX, base.anchorY]
      .every(Number.isFinite),
    `${label} transform must be finite`,
  );
  check(base.scaleX > 0 && base.scaleY > 0, `${label} scale must be positive`);
  check(base.opacity >= 0 && base.opacity <= 1, `${label} opacity must be 0..1`);
  validateProvenance(track.provenance, `${label}.provenance`);
  let previousFrame = startFrame - 1;
  for (const keyframe of track.keyframes) {
    check(Number.isSafeInteger(keyframe.frame) && keyframe.frame >= startFrame && keyframe.frame < endFrame, `${label} keyframe is outside the layer window`);
    check(keyframe.frame > previousFrame, `${label} keyframes must be strictly increasing`);
    previousFrame = keyframe.frame;
    check(EASINGS.includes(keyframe.easing), `${label} has an invalid easing`);
    for (const [key, value] of Object.entries(keyframe.transform)) {
      check(Object.hasOwn(base, key), `${label} keyframe has an unknown transform property: ${key}`);
      check(typeof value === "number" && Number.isFinite(value), `${label} keyframe ${key} must be finite`);
      if (key === "opacity") check(value >= 0 && value <= 1, `${label} keyframe opacity must be 0..1`);
      if (key === "scaleX" || key === "scaleY") check(value > 0, `${label} keyframe scale must be positive`);
    }
  }
}

function validateEvidenceRef(layer: StyleLayer, evidence: ReferenceProfile["styleEvidence"]): void {
  if (layer.evidenceRef === undefined) return;
  const match = /^(textOverlays|effects|transitions)\[(\d+)\]$/.exec(layer.evidenceRef);
  check(match !== null, `Layer ${layer.id} evidenceRef must look like textOverlays[0]`);
  check(evidence !== undefined, `Layer ${layer.id} references evidence but the profile has none`);
  const [, collection, rawIndex] = match;
  const items = collection === "textOverlays" ? evidence.textOverlays : collection === "effects" ? evidence.effects : evidence.transitions;
  const index = Number(rawIndex);
  check(Number.isSafeInteger(index) && index < items.length, `Layer ${layer.id} evidenceRef does not resolve`);
}

function validateMask(mask: LayerMask | undefined, layer: StyleLayer, scene: LayeredScene, label: string): void {
  if (!mask) return;
  check(MASK_KINDS.includes(mask.kind), `${label} has an invalid mask kind`);
  if (mask.bounds) {
    const rect = mask.bounds;
    check(
      [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
        rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 &&
        rect.x + rect.width <= 1 && rect.y + rect.height <= 1,
      `${label} mask bounds must be normalized to the frame`,
    );
  }
  if (mask.feather !== undefined) check(Number.isFinite(mask.feather) && mask.feather >= 0, `${label} feather must be finite and non-negative`);
  check(mask.inverted === undefined || typeof mask.inverted === "boolean", `${label} inverted must be a boolean`);
  if (MATTE_KINDS.includes(mask.kind)) {
    check(mask.sourceLayerId !== undefined, `${label} matte must reference a source layer`);
    check(mask.sourceLayerId !== layer.id, `${label} matte cannot reference its own layer`);
    check(scene.layers.some((candidate) => candidate.id === mask.sourceLayerId), `${label} matte source layer is missing`);
  }
  validateProvenance(mask.provenance, `${label}.provenance`);
}

function validateScene(
  scene: LayeredScene,
  durationFrames: number,
  layerIds: Set<string>,
  slotIds: Set<string>,
  evidence: ReferenceProfile["styleEvidence"],
): void {
  check(typeof scene.id === "string" && scene.id.length > 0, "Scene id is required");
  check(Number.isSafeInteger(scene.revision) && scene.revision >= 1, `Scene ${scene.id} revision must be a positive integer`);
  check(
    Number.isSafeInteger(scene.startFrame) && Number.isSafeInteger(scene.endFrame) &&
      scene.startFrame >= 0 && scene.endFrame > scene.startFrame && scene.endFrame <= durationFrames,
    `Scene ${scene.id} has an invalid frame window`,
  );
  check(scene.layers.length > 0, `Scene ${scene.id} needs at least one layer`);
  const zIndexes = new Set<number>();
  const byId = new Map<string, StyleLayer>();
  for (const layer of scene.layers) {
    check(typeof layer.id === "string" && layer.id.length > 0, `Scene ${scene.id} has a layer without an id`);
    check(!layerIds.has(layer.id), `Layer id ${layer.id} is duplicated`);
    layerIds.add(layer.id);
    byId.set(layer.id, layer);
    check(LAYER_KINDS.includes(layer.kind), `Layer ${layer.id} has an invalid kind`);
    check(Number.isSafeInteger(layer.zIndex), `Layer ${layer.id} zIndex must be an integer`);
    check(!zIndexes.has(layer.zIndex), `Layer ${layer.id} reuses zIndex ${layer.zIndex}`);
    zIndexes.add(layer.zIndex);
    check(
      Number.isSafeInteger(layer.startFrame) && Number.isSafeInteger(layer.endFrame) &&
        layer.startFrame >= scene.startFrame && layer.endFrame > layer.startFrame && layer.endFrame <= scene.endFrame,
      `Layer ${layer.id} must sit inside its scene`,
    );
    validateTransform(layer.transform, layer.startFrame, layer.endFrame, `Layer ${layer.id}`);
    validateMask(layer.mask, layer, scene, `Layer ${layer.id}`);
    validateEvidenceRef(layer, evidence);
    validateProvenance(layer.provenance, `Layer ${layer.id}.provenance`);
  }
  for (const layer of scene.layers) {
    let current: StyleLayer | undefined = layer;
    const seen = new Set<string>();
    while (current?.parentId !== undefined) {
      check(!seen.has(current.id), `Layer parent cycle at ${layer.id}`);
      seen.add(current.id);
      const parent = byId.get(current.parentId);
      check(parent !== undefined, `Layer ${layer.id} references a missing parent ${current.parentId}`);
      current = parent;
    }
  }
  for (const slot of scene.slots) {
    check(typeof slot.id === "string" && slot.id.length > 0, `Scene ${scene.id} has a slot without an id`);
    check(!slotIds.has(slot.id), `Slot id ${slot.id} is duplicated`);
    slotIds.add(slot.id);
    const layer = byId.get(slot.layerId);
    check(layer !== undefined, `Slot ${slot.id} references a missing layer ${slot.layerId}`);
    check(SLOT_ROLES.includes(slot.role), `Slot ${slot.id} has an invalid role`);
    if (layer) {
      check(
        Number.isSafeInteger(slot.startFrame) && Number.isSafeInteger(slot.endFrame) &&
          slot.startFrame >= layer.startFrame && slot.endFrame > slot.startFrame && slot.endFrame <= layer.endFrame,
        `Slot ${slot.id} must sit inside its layer`,
      );
    }
    if (slot.constraints) {
      const constraints = slot.constraints;
      if (constraints.minDurationFrames !== undefined) {
        check(Number.isSafeInteger(constraints.minDurationFrames) && constraints.minDurationFrames > 0, `Slot ${slot.id} minDurationFrames must be positive`);
      }
      if (constraints.preferredAspectRatio !== undefined) {
        check(Number.isFinite(constraints.preferredAspectRatio) && constraints.preferredAspectRatio > 0, `Slot ${slot.id} preferredAspectRatio must be positive`);
      }
      check(constraints.faceSafe === undefined || typeof constraints.faceSafe === "boolean", `Slot ${slot.id} faceSafe must be a boolean`);
      check(constraints.containsText === undefined || typeof constraints.containsText === "boolean", `Slot ${slot.id} containsText must be a boolean`);
    }
    validateProvenance(slot.provenance, `Slot ${slot.id}.provenance`);
  }
  validateCoverage(scene.coverage, `Scene ${scene.id}`);
}

export function validateLayeredEditDNA(dna: LayeredEditDNA): void {
  check(dna.version === LAYERED_EDIT_DNA_VERSION, "Unsupported layered EditDNA version");
  check(dna.scenes.length > 0, "Layered EditDNA needs at least one scene");
  validateReferenceProfile({ ...dna, version: "kove.mirror.v3" } as ReferenceProfile);
  const layerIds = new Set<string>();
  const slotIds = new Set<string>();
  const sceneIds = new Set<string>();
  for (const scene of dna.scenes) {
    check(!sceneIds.has(scene.id), `Scene id ${scene.id} is duplicated`);
    sceneIds.add(scene.id);
    validateScene(scene, dna.durationFrames, layerIds, slotIds, dna.styleEvidence);
  }
  validateCoverage(dna.coverage, "profile");
}

/**
 * Pure template helper: shifts the scene, its layers, keyframes, and slots by
 * the delta to `newStartFrame`, and appends `idSuffix` to scene/layer/slot IDs
 * plus internal parent, matte-source, and slot-layer references. The
 * `evidenceRef` always keeps pointing at the retained profile evidence.
 */
export function rebaseScene(scene: LayeredScene, newStartFrame: number, idSuffix: string): LayeredScene {
  check(Number.isSafeInteger(newStartFrame) && newStartFrame >= 0, "Scene rebase start must be a non-negative integer");
  check(typeof idSuffix === "string", "Scene rebase suffix must be a string");
  const delta = newStartFrame - scene.startFrame;
  const rename = (id: string) => `${id}${idSuffix}`;
  return {
    ...scene,
    id: rename(scene.id),
    startFrame: scene.startFrame + delta,
    endFrame: scene.endFrame + delta,
    layers: scene.layers.map((layer) => ({
      ...layer,
      id: rename(layer.id),
      parentId: layer.parentId === undefined ? undefined : rename(layer.parentId),
      startFrame: layer.startFrame + delta,
      endFrame: layer.endFrame + delta,
      transform: {
        ...layer.transform,
        keyframes: layer.transform.keyframes.map((keyframe) => ({
          ...keyframe,
          frame: keyframe.frame + delta,
        })),
      },
      mask:
        layer.mask === undefined
          ? undefined
          : {
              ...layer.mask,
              sourceLayerId: layer.mask.sourceLayerId === undefined ? undefined : rename(layer.mask.sourceLayerId),
            },
    })),
    slots: scene.slots.map((slot) => ({
      ...slot,
      id: rename(slot.id),
      layerId: rename(slot.layerId),
      startFrame: slot.startFrame + delta,
      endFrame: slot.endFrame + delta,
    })),
  };
}
