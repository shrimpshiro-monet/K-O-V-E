import type {
  CameraMoveId,
  PlannedCameraMove,
  PlannedKeyframeEasing,
  PlannedSegment,
  PlannedTransformKeyframe,
} from "./edit-plan";

/**
 * Camera-move vocabulary and compiler.
 *
 * Why this exists: a plan that only splices clips produces a slideshow. What
 * separates a hand-edited short-form edit from a machine one is that *every*
 * shot is moving — a push-in that reveals, a punch that lands with the beat, a
 * handheld drift that keeps the frame alive. The renderer already animates
 * clip transform keyframes (`scale.x`, `scale.y`, `position.x`, `position.y`,
 * `rotation`, `opacity`), so the gap was never rendering: it was that the
 * director had no way to *ask* for motion. This module is that vocabulary plus
 * the deterministic recipe that turns a name + intensity into keyframes.
 *
 * Rules the compiler guarantees:
 * - Deltas are relative to the clip's own static transform, so layout regions
 *   (split/pip) still work — motion is added on top, never replaces it.
 * - Every animated property starts from its base value at t=0, so a shot never
 *   begins mid-move because keyframes were authored later in the shot.
 * - Shots settle back to base for the "ambient" moves (breathe/wobble/sway/
 *   handheld), so cutting out of them does not jump.
 */

export const CAMERA_MOVE_IDS = [
  "punch-in",
  "punch-out",
  "slow-push",
  "pull-back",
  "drift-left",
  "drift-right",
  "tilt-up",
  "tilt-down",
  "handheld",
  "whip-shake",
  "snap-zoom",
  "breathe",
  "wobble",
  "sway",
] as const satisfies readonly CameraMoveId[];

export interface CameraMoveAtlasEntry {
  /** One-line direction for the director prompt. */
  readonly direction: string;
  /** Intended emotional use, also surfaced to the director prompt. */
  readonly useWhen: string;
  readonly properties: readonly string[];
  /** True when the move returns to base and can be stacked or cut out of safely. */
  readonly settles: boolean;
}

export const CAMERA_MOVE_ATLAS: Readonly<Record<CameraMoveId, CameraMoveAtlasEntry>> = {
  "punch-in": {
    direction: "Snap closer at the start of the shot (~0.3s) and hold the tighter frame.",
    useWhen: "Emphasis: a reaction, a line landing, a hit on the beat.",
    properties: ["scale.x", "scale.y"],
    settles: false,
  },
  "punch-out": {
    direction: "Start tight, snap back to the wide frame (~0.3s).",
    useWhen: "Reveals — the payoff of a setup shot.",
    properties: ["scale.x", "scale.y"],
    settles: false,
  },
  "slow-push": {
    direction: "Creep in across the whole shot (≈8% zoom).",
    useWhen: "The default for talking heads and any shot you want to feel intentional.",
    properties: ["scale.x", "scale.y"],
    settles: false,
  },
  "pull-back": {
    direction: "Start slightly tight and ease out to the wide frame across the shot.",
    useWhen: "Ending a sequence, final beat, end of a chapter.",
    properties: ["scale.x", "scale.y"],
    settles: false,
  },
  "drift-left": {
    direction: "Lateral drift to the left across the shot.",
    useWhen: "B-roll, establishing shots, anything already stable.",
    properties: ["position.x"],
    settles: false,
  },
  "drift-right": {
    direction: "Lateral drift to the right across the shot.",
    useWhen: "B-roll, establishing shots, mirrors drift-left for variety.",
    properties: ["position.x"],
    settles: false,
  },
  "tilt-up": {
    direction: "Slight upward drift across the shot.",
    useWhen: "Reveals that build upward, entrances.",
    properties: ["position.y"],
    settles: false,
  },
  "tilt-down": {
    direction: "Slight downward drift across the shot.",
    useWhen: "Falls, drops, deflating beats.",
    properties: ["position.y"],
    settles: false,
  },
  handheld: {
    direction: "Low-amplitude handheld jitter held under the whole shot.",
    useWhen: "Energy without a zoom — interviews, walk-and-talk, raw footage.",
    properties: ["position.x", "position.y", "rotation"],
    settles: true,
  },
  "whip-shake": {
    direction: "Sharp rotational snap at the shot head, settling in ~0.25s.",
    useWhen: "Impact frames, big hits, transitions into a new beat.",
    properties: ["rotation"],
    settles: true,
  },
  "snap-zoom": {
    direction: "Start heavily zoomed and snap out to normal in ~0.2s.",
    useWhen: "Cold opens, drop hits, the moment the music breaks.",
    properties: ["scale.x", "scale.y"],
    settles: false,
  },
  breathe: {
    direction: "Slow sinusoidal zoom in and back out across the shot.",
    useWhen: "Holding on a face or a product without letting the frame die.",
    properties: ["scale.x", "scale.y"],
    settles: true,
  },
  wobble: {
    direction: "Gentle rotational sway, returning to level.",
    useWhen: "Playful beats, comedic timing, meme cutaways.",
    properties: ["rotation"],
    settles: true,
  },
  sway: {
    direction: "Slow tilt of a couple of degrees across the shot.",
    useWhen: "Stylised b-roll, dreamy or disoriented moments.",
    properties: ["rotation"],
    settles: false,
  },
};

/** Base (static) value of every animatable transform property. */
const BASE_VALUES: Readonly<Record<PlannedTransformKeyframe["property"], number>> = {
  "scale.x": 1,
  "scale.y": 1,
  "position.x": 0,
  "position.y": 0,
  rotation: 0,
  opacity: 1,
};

/** Hard amplitude caps — the difference between "handheld" and "earthquake". */
const MAX_DELTA: Readonly<Record<PlannedTransformKeyframe["property"], number>> = {
  "scale.x": 0.6,
  "scale.y": 0.6,
  "position.x": 0.1,
  "position.y": 0.1,
  rotation: 8,
  opacity: 1,
};

const DEFAULT_INTENSITY = 0.6;
const TIME_EPSILON = 1e-3;

export function isCameraMoveId(value: unknown): value is CameraMoveId {
  return typeof value === "string" && (CAMERA_MOVE_IDS as readonly string[]).includes(value);
}

/** Coerce a raw LLM value into a valid move spec, or undefined when unusable. */
export function normalizeCameraMove(value: unknown): PlannedCameraMove | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (!isCameraMoveId(record.move)) return undefined;
  const intensity = typeof record.intensity === "number" && Number.isFinite(record.intensity)
    ? Math.max(0, Math.min(1, record.intensity))
    : undefined;
  const startTime = typeof record.startTime === "number" && Number.isFinite(record.startTime) && record.startTime >= 0
    ? record.startTime
    : undefined;
  const duration = typeof record.duration === "number" && Number.isFinite(record.duration) && record.duration > 0
    ? record.duration
    : undefined;
  return {
    move: record.move,
    ...(intensity !== undefined ? { intensity } : {}),
    ...(startTime !== undefined ? { startTime } : {}),
    ...(duration !== undefined ? { duration } : {}),
  };
}

export function normalizeCameraMoves(value: unknown): PlannedCameraMove[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const moves = value
    .map(normalizeCameraMove)
    .filter((move): move is PlannedCameraMove => move !== undefined);
  return moves.length > 0 ? moves : undefined;
}

interface MoveKeyframe {
  readonly time: number;
  readonly deltas: Partial<Record<PlannedTransformKeyframe["property"], number>>;
  readonly easing: PlannedKeyframeEasing;
}

/**
 * Deterministic pseudo-random jitter for the handheld recipe. Seeded so the
 * same plan always compiles to the same keyframes (fingerprints and replays
 * depend on that).
 */
function jitter(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return (value - Math.floor(value)) * 2 - 1;
}

function clampTime(time: number, max: number): number {
  return Math.max(0, Math.min(max, Math.round(time * 1000) / 1000));
}

function moveKeyframes(
  move: PlannedCameraMove,
  shotDuration: number,
): readonly MoveKeyframe[] {
  const intensity = Math.max(0.05, Math.min(1, move.intensity ?? DEFAULT_INTENSITY));
  const start = clampTime(move.startTime ?? 0, shotDuration);
  const available = Math.max(0.02, shotDuration - start);
  const length = clampTime(move.duration ?? available, available);
  const end = clampTime(start + length, shotDuration);
  const mid = clampTime(start + length / 2, shotDuration);
  const quarter = clampTime(start + length * 0.25, shotDuration);
  const threeQuarters = clampTime(start + length * 0.75, shotDuration);

  switch (move.move) {
    case "punch-in": {
      const window = clampTime(start + Math.min(length, 0.35), shotDuration);
      return [
        { time: start, deltas: { "scale.x": 0, "scale.y": 0 }, easing: "easeOutQuad" },
        { time: window, deltas: { "scale.x": 0.12 * intensity, "scale.y": 0.12 * intensity }, easing: "linear" },
      ];
    }
    case "punch-out": {
      const window = clampTime(start + Math.min(length, 0.35), shotDuration);
      return [
        { time: start, deltas: { "scale.x": 0.12 * intensity, "scale.y": 0.12 * intensity }, easing: "easeOutQuad" },
        { time: window, deltas: { "scale.x": 0, "scale.y": 0 }, easing: "linear" },
      ];
    }
    case "slow-push":
      return [
        { time: start, deltas: { "scale.x": 0, "scale.y": 0 }, easing: "easeInOutSine" },
        { time: end, deltas: { "scale.x": 0.08 * intensity, "scale.y": 0.08 * intensity }, easing: "linear" },
      ];
    case "pull-back":
      return [
        { time: start, deltas: { "scale.x": 0.08 * intensity, "scale.y": 0.08 * intensity }, easing: "easeInOutSine" },
        { time: end, deltas: { "scale.x": 0, "scale.y": 0 }, easing: "linear" },
      ];
    case "drift-left":
      return [
        { time: start, deltas: { "position.x": 0 }, easing: "linear" },
        { time: end, deltas: { "position.x": -0.025 * intensity }, easing: "linear" },
      ];
    case "drift-right":
      return [
        { time: start, deltas: { "position.x": 0 }, easing: "linear" },
        { time: end, deltas: { "position.x": 0.025 * intensity }, easing: "linear" },
      ];
    case "tilt-up":
      return [
        { time: start, deltas: { "position.y": 0 }, easing: "linear" },
        { time: end, deltas: { "position.y": -0.025 * intensity }, easing: "linear" },
      ];
    case "tilt-down":
      return [
        { time: start, deltas: { "position.y": 0 }, easing: "linear" },
        { time: end, deltas: { "position.y": 0.025 * intensity }, easing: "linear" },
      ];
    case "handheld": {
      const steps = 6;
      const frames: MoveKeyframe[] = [];
      for (let step = 0; step <= steps; step += 1) {
        const t = clampTime(start + (length * step) / steps, shotDuration);
        // Taper to zero at both ends so cut points stay level.
        const taper = step === 0 || step === steps ? 0 : 1;
        frames.push({
          time: t,
          deltas: {
            "position.x": 0.0045 * intensity * taper * jitter(step + 1.7),
            "position.y": 0.0035 * intensity * taper * jitter(step + 11.3),
            rotation: 0.35 * intensity * taper * jitter(step + 23.1),
          },
          easing: "easeInOutSine",
        });
      }
      return frames;
    }
    case "whip-shake":
      return [
        { time: start, deltas: { rotation: 0 }, easing: "easeOutQuad" },
        { time: clampTime(start + Math.min(length, 0.06), shotDuration), deltas: { rotation: 1.8 * intensity }, easing: "easeOutQuad" },
        { time: clampTime(start + Math.min(length, 0.14), shotDuration), deltas: { rotation: -1.4 * intensity }, easing: "easeOutQuad" },
        { time: clampTime(start + Math.min(length, 0.28), shotDuration), deltas: { rotation: 0 }, easing: "linear" },
      ];
    case "snap-zoom": {
      const window = clampTime(start + Math.min(length, 0.22), shotDuration);
      return [
        { time: start, deltas: { "scale.x": 0.4 * intensity, "scale.y": 0.4 * intensity }, easing: "easeOutQuart" },
        { time: window, deltas: { "scale.x": 0, "scale.y": 0 }, easing: "linear" },
      ];
    }
    case "breathe":
      return [
        { time: start, deltas: { "scale.x": 0, "scale.y": 0 }, easing: "easeInOutSine" },
        { time: mid, deltas: { "scale.x": 0.035 * intensity, "scale.y": 0.035 * intensity }, easing: "easeInOutSine" },
        { time: end, deltas: { "scale.x": 0, "scale.y": 0 }, easing: "linear" },
      ];
    case "wobble":
      return [
        { time: start, deltas: { rotation: 0 }, easing: "easeInOutSine" },
        { time: quarter, deltas: { rotation: 1.6 * intensity }, easing: "easeInOutSine" },
        { time: threeQuarters, deltas: { rotation: -1.4 * intensity }, easing: "easeInOutSine" },
        { time: end, deltas: { rotation: 0 }, easing: "linear" },
      ];
    case "sway":
      return [
        { time: start, deltas: { rotation: 0 }, easing: "easeInOutSine" },
        { time: end, deltas: { rotation: 2.2 * intensity }, easing: "linear" },
      ];
  }
}

/**
 * Compile a segment's camera moves into clip transform keyframes.
 *
 * Moves that touch the same property are composed additively (a punch-in on
 * top of a handheld keeps both), and every animated property is anchored at its
 * base value on frame zero.
 *
 * @param moves raw planned moves (already normalized)
 * @param shotDuration the segment's timeline duration in seconds
 */
export function compileCameraMoves(
  moves: readonly PlannedCameraMove[] | undefined,
  shotDuration: number,
): PlannedTransformKeyframe[] {
  if (!moves || moves.length === 0 || !(shotDuration > 0)) return [];

  const byProperty = new Map<
    PlannedTransformKeyframe["property"],
    Map<number, { delta: number; easing: PlannedKeyframeEasing }>
  >();

  const record = (
    time: number,
    property: PlannedTransformKeyframe["property"],
    delta: number,
    easing: PlannedKeyframeEasing,
  ): void => {
    const bucket = byProperty.get(property) ?? new Map();
    const key = Math.round(time * 1000) / 1000;
    const existing = bucket.get(key);
    const clamped = Math.max(-MAX_DELTA[property], Math.min(MAX_DELTA[property], delta));
    bucket.set(
      key,
      existing
        ? { delta: existing.delta + clamped, easing: existing.easing }
        : { delta: clamped, easing },
    );
    byProperty.set(property, bucket);
  };

  for (const move of moves) {
    if (!isCameraMoveId(move.move)) continue;
    for (const frame of moveKeyframes(move, shotDuration)) {
      for (const [property, delta] of Object.entries(frame.deltas) as [PlannedTransformKeyframe["property"], number][]) {
        record(frame.time, property, delta, frame.easing);
      }
    }
  }

  const out: PlannedTransformKeyframe[] = [];
  for (const [property, bucket] of byProperty) {
    const times = [...bucket.keys()].sort((left, right) => left - right);
    if (times.length === 0) continue;
    // Anchor on frame zero so a move that starts mid-shot does not pop in
    // from the clip's static transform without a defined starting point.
    if (times[0]! > TIME_EPSILON) {
      out.push({ property, time: 0, value: BASE_VALUES[property], easing: "linear" });
    }
    for (const time of times) {
      const entry = bucket.get(time)!;
      out.push({
        property,
        time,
        value: BASE_VALUES[property] + entry.delta,
        easing: entry.easing,
      });
    }
  }

  // Stable order: property grouping first (the engine groups by property),
  // then time.
  return out.sort((left, right) =>
    left.property === right.property
      ? left.time - right.time
      : left.property < right.property
        ? -1
        : 1,
  );
}

/** True when a segment carries any authored motion (camera move or transform keyframes). */
export function segmentHasCameraMotion(segment: Pick<PlannedSegment, "cameraMoves">): boolean {
  return (segment.cameraMoves?.length ?? 0) > 0;
}

/** Distinct move ids used by a plan, in first-use order. */
export function collectCameraMoveIds(moves: readonly PlannedCameraMove[] | undefined): CameraMoveId[] {
  const seen = new Set<CameraMoveId>();
  const out: CameraMoveId[] = [];
  for (const move of moves ?? []) {
    if (!isCameraMoveId(move.move) || seen.has(move.move)) continue;
    seen.add(move.move);
    out.push(move.move);
  }
  return out;
}
