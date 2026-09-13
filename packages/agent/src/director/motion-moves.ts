import { DEFAULT_SHAPE_STYLE } from "@kove-advanced/core/graphics/types";
import { addMotionLayerEffect, createMotionEffect } from "@kove-advanced/core/motion/motion-effects";
import { applyMotionAnimationPreset } from "@kove-advanced/core/motion/motion-animation-presets";
import { createMotionParticleLayer } from "@kove-advanced/core/motion/motion-particles";
import { createMotionScene3DLayer } from "@kove-advanced/core/motion/motion-scene3d";
import {
  DEFAULT_MOTION_TRANSFORM,
  type MotionComposition,
  type MotionLayer,
  type MotionShapeLayer,
  type MotionTextLayer,
} from "@kove-advanced/core/motion/types";
import type { MotionMoveId } from "@kove-advanced/creation-schema";

export interface MotionMoveContext {
  readonly composition: MotionComposition;
  readonly duration: number;
  readonly title?: string;
}

export interface MotionMoveResult {
  readonly composition: MotionComposition;
  readonly move: MotionMoveId;
  readonly layerIds: readonly string[];
  readonly sequence: readonly string[];
}

export const MOTION_MOVE_LIBRARY: Readonly<Record<MotionMoveId, readonly string[]>> = {
  "particle-burst-on-cut": [
    "create_motion_composition",
    "add_motion_layer:particle",
    "configure_particle_emitter",
  ],
  "glitch-transition": [
    "create_motion_composition",
    "add_motion_layer:shape",
    "add_motion_effect:chromatic-aberration",
    "animate_layer:scale-pop",
  ],
  "3d-title-card": [
    "create_motion_composition",
    "add_motion_layer:scene3d(text3d)",
    "add_motion_layer:text",
    "animate_layer:slide-up-in",
  ],
};

export function buildMotionMove(
  move: MotionMoveId,
  context: MotionMoveContext,
  idFactory: () => string,
): MotionMoveResult {
  switch (move) {
    case "particle-burst-on-cut":
      return buildParticleBurst(context, idFactory);
    case "glitch-transition":
      return buildGlitchTransition(context, idFactory);
    case "3d-title-card":
      return build3dTitleCard(context, idFactory);
  }
}

function buildParticleBurst(
  context: MotionMoveContext,
  idFactory: () => string,
): MotionMoveResult {
  const particle = createMotionParticleLayer(context.composition, {
    id: idFactory(),
    name: "Particle Burst",
    duration: context.duration,
    position: {
      x: context.composition.width / 2,
      y: context.composition.height / 2,
    },
    emitter: {
      emissionRate: 180,
      maxParticles: 420,
      lifetime: Math.min(1.4, context.duration),
      speed: 520,
      spread: 360,
      gravity: 40,
      size: 14,
      sizeRandomness: 0.7,
      colorStart: "#ffffff",
      colorEnd: "#14b8a6",
      seed: 2401,
    },
  });
  const nextComposition = appendLayers(context.composition, [particle]);
  return {
    composition: nextComposition,
    move: "particle-burst-on-cut",
    layerIds: [particle.id],
    sequence: MOTION_MOVE_LIBRARY["particle-burst-on-cut"],
  };
}

function buildGlitchTransition(
  context: MotionMoveContext,
  idFactory: () => string,
): MotionMoveResult {
  const base: MotionShapeLayer = {
    id: idFactory(),
    type: "shape",
    name: "Glitch Transition Plate",
    startTime: 0,
    duration: context.duration,
    visible: true,
    locked: false,
    transform: {
      ...DEFAULT_MOTION_TRANSFORM,
      position: { x: context.composition.width / 2, y: context.composition.height / 2 },
      scale: { x: 1.08, y: 1.08 },
    },
    keyframes: [],
    shapeType: "rectangle",
    width: context.composition.width,
    height: context.composition.height,
    style: {
      ...DEFAULT_SHAPE_STYLE,
      fill: { type: "solid", color: "#ffffff", opacity: 0.92 },
    },
  };
  const withEffect = addMotionLayerEffect(base, createMotionEffect("chromatic-aberration", idFactory()));
  const animated = applyMotionAnimationPreset(withEffect, "scale-pop", {
    startTime: 0,
    duration: Math.min(0.32, context.duration),
    intensity: 1.35,
    idFactory: () => idFactory(),
  });
  const nextComposition = appendLayers(context.composition, [animated]);
  return {
    composition: nextComposition,
    move: "glitch-transition",
    layerIds: [animated.id],
    sequence: MOTION_MOVE_LIBRARY["glitch-transition"],
  };
}

function build3dTitleCard(
  context: MotionMoveContext,
  idFactory: () => string,
): MotionMoveResult {
  const title = context.title?.trim() || "KOVE";
  const scene = createMotionScene3DLayer({
    id: idFactory(),
    name: "3D Title Object",
    duration: context.duration,
    compositionWidth: context.composition.width,
    compositionHeight: context.composition.height,
    object: { kind: "text3d", text: title, extrude: 0.24, size: 0.72 },
    material: {
      kind: "physical",
      color: "#14b8a6",
      metalness: 0.35,
      roughness: 0.24,
      emissive: "#0f766e",
      emissiveIntensity: 0.3,
    },
    camera: {
      position: { x: 0, y: 0.2, z: 4.5 },
      target: { x: 0, y: 0, z: 0 },
      fov: 34,
    },
    lighting: { environment: "studio", groundShadow: true, keyIntensity: 1.2, rimIntensity: 0.8 },
  });
  const typography: MotionTextLayer = {
    id: idFactory(),
    type: "text",
    name: "3D Title Label",
    startTime: 0,
    duration: context.duration,
    visible: true,
    locked: false,
    transform: {
      ...DEFAULT_MOTION_TRANSFORM,
      position: { x: context.composition.width / 2, y: context.composition.height * 0.82 },
    },
    keyframes: [],
    text: title,
    style: {
      fontFamily: "Inter",
      fontSize: Math.max(28, context.composition.width * 0.045),
      fontWeight: 700,
      color: "#ffffff",
      align: "center",
      lineHeight: 1,
      letterSpacing: 4,
    },
  };
  const animatedTypography = applyMotionAnimationPreset(typography, "slide-up-in", {
    startTime: 0.08,
    duration: Math.min(0.55, context.duration),
    distance: 80,
    idFactory: () => idFactory(),
  });
  const nextComposition = appendLayers(context.composition, [scene, animatedTypography]);
  return {
    composition: nextComposition,
    move: "3d-title-card",
    layerIds: [scene.id, animatedTypography.id],
    sequence: MOTION_MOVE_LIBRARY["3d-title-card"],
  };
}

function appendLayers(
  composition: MotionComposition,
  layers: readonly MotionLayer[],
): MotionComposition {
  return {
    ...composition,
    layers: [...composition.layers, ...layers],
    modifiedAt: Date.now(),
  };
}
