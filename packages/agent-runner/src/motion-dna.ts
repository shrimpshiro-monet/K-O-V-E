/**
 * Motion DNA — a measured motion curve, played back by the renderer.
 *
 * The analyzer (`evaluation-files/test-b/motion/analyze_reference.py`) writes a
 * JSON file with the raw per-frame samples and the best parametric fit. This
 * module is deliberately small: it validates that file and turns samples into
 * engine keyframes. No timing is invented here — every keyframe time comes from
 * the measured sample.
 *
 * Playback adapters:
 * - `fittedCardKeyframes`: the fitted easing, quantized back onto the native
 *   frame grid with `hold` easing. This is the shipped playback: the shape is
 *   parametric, the cadence is the source's.
 * - `steppedCardKeyframes`: the raw measured samples, one keyframe each. Used
 *   to verify the fit against the source, or when a DNA is marked `stepped`.
 *
 * Neither adapter invents timing. Every keyframe lands on a measured source
 * frame; the 30fps renderer repeats the held values between them.
 */
import { readFile } from "node:fs/promises";
import {
  EASING_FUNCTIONS,
  cubicBezier,
  type EasingName,
} from "@kove-advanced/core/animation/easing-functions";
import type { EasingType, Keyframe } from "@kove-advanced/core/types/timeline";

export interface MotionDnaSample {
  /** Normalized time in 0..1 across the measured entrance. */
  readonly t: number;
  /** Normalized value in 0..1. */
  readonly value: number;
}

export interface MotionDnaFit {
  readonly family: string;
  readonly params: Readonly<Record<string, number>>;
  readonly rmse: number;
  readonly bic: number;
  readonly samples: number;
}

export interface MotionDna {
  readonly role: string;
  readonly channel: string;
  readonly from: number;
  readonly to: number;
  readonly durationFrames: number;
  readonly durationSeconds: number;
  /** Native source frame rate the samples were taken at. */
  readonly fps: number;
  readonly profile: "stepped" | "smooth";
  readonly fit: MotionDnaFit;
  readonly samples: readonly MotionDnaSample[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(source: Record<string, unknown>, key: string, where: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`motion dna: ${where}.${key} must be a finite number`);
  }
  return value;
}

function stringField(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`motion dna: ${where}.${key} must be a non-empty string`);
  }
  return value;
}

/** Validate the analyzer's JSON. Throws rather than guessing defaults. */
export function parseMotionDna(raw: unknown): MotionDna {
  if (!isRecord(raw)) throw new Error("motion dna: root must be an object");
  const samplesRaw = raw.samples;
  if (!Array.isArray(samplesRaw) || samplesRaw.length < 2) {
    throw new Error("motion dna: samples must contain at least two points");
  }
  const samples = samplesRaw.map((item, index): MotionDnaSample => {
    if (!isRecord(item)) throw new Error(`motion dna: samples[${index}] must be an object`);
    const t = numberField(item, "t", `samples[${index}]`);
    const value = numberField(item, "value", `samples[${index}]`);
    if (t < 0 || t > 1) throw new Error(`motion dna: samples[${index}].t outside 0..1`);
    return { t, value };
  });
  for (let i = 1; i < samples.length; i++) {
    if (samples[i]!.t < samples[i - 1]!.t) {
      throw new Error("motion dna: samples must be in time order");
    }
  }
  // The adapters rebuild times from the uniform native-frame grid (index over
  // sample count) so rounded JSON times cannot push a step past a render frame.
  // Reject a file that is not actually uniform instead of mis-timing it.
  for (let i = 0; i < samples.length; i++) {
    const expected = i / (samples.length - 1);
    if (Math.abs(samples[i]!.t - expected) > 1e-3) {
      throw new Error("motion dna: samples must be uniformly spaced on the native frame grid");
    }
  }

  const fitRaw = raw.fit;
  if (!isRecord(fitRaw)) throw new Error("motion dna: fit must be an object");
  const paramsRaw = fitRaw.params;
  if (!isRecord(paramsRaw)) throw new Error("motion dna: fit.params must be an object");
  const params: Record<string, number> = {};
  for (const [key, value] of Object.entries(paramsRaw)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`motion dna: fit.params.${key} must be a finite number`);
    }
    params[key] = value;
  }

  const profile = stringField(raw, "profile", "root");
  if (profile !== "stepped" && profile !== "smooth") {
    throw new Error(`motion dna: unknown profile "${profile}"`);
  }
  const durationFrames = numberField(raw, "durationFrames", "root");
  if (durationFrames <= 0) throw new Error("motion dna: durationFrames must be positive");
  const fps = numberField(raw, "fps", "root");
  if (fps <= 0) throw new Error("motion dna: fps must be positive");

  return {
    role: stringField(raw, "role", "root"),
    channel: stringField(raw, "channel", "root"),
    from: numberField(raw, "from", "root"),
    to: numberField(raw, "to", "root"),
    durationFrames,
    durationSeconds: numberField(raw, "durationSeconds", "root"),
    fps,
    profile,
    fit: {
      family: stringField(fitRaw, "family", "fit"),
      params,
      rmse: numberField(fitRaw, "rmse", "fit"),
      bic: numberField(fitRaw, "bic", "fit"),
      samples: numberField(fitRaw, "samples", "fit"),
    },
    samples,
  };
}

export async function loadMotionDna(path: string): Promise<MotionDna> {
  return parseMotionDna(JSON.parse(await readFile(path, "utf8")) as unknown);
}

export interface ScalePlaybackSpec {
  readonly idPrefix: string;
  /** Timeline time (seconds) of the first sample. */
  readonly startTime?: number;
  /** Final base scale the card must land on. */
  readonly baseScale: number;
  /** Optional override of the sample span, for a new duration. */
  readonly durationSeconds?: number;
  /** Keep the card on screen after the entrance. */
  readonly holdUntil?: number;
}

function keyframe(
  id: string,
  time: number,
  property: string,
  value: number,
  easing: EasingType,
): Keyframe {
  return { id, time, property, value, easing };
}

/**
 * Step through the measured samples with `hold` easing. At 30fps this looks
 * like the reference's 18fps stop-motion: it holds, then jumps, rather than
 * smoothing the cadence away.
 *
 * The reference reveals a full-size print through a moving slit. The timeline
 * clip model has no keyframable crop, so the measured visible-height curve
 * drives a uniform scale on both axes instead of squashing one axis. Timing is
 * preserved exactly; the shape reveal is the next renderer primitive to add.
 */
export function steppedCardKeyframes(dna: MotionDna, spec: ScalePlaybackSpec): Keyframe[] {
  if (dna.channel !== "visibleHeight") {
    throw new Error(`motion dna: ${dna.channel} cannot drive a card reveal`);
  }
  const start = spec.startTime ?? 0;
  // Frames over the native fps, not the rounded display duration: the exact
  // frame grid is what keeps every step on a 30fps output boundary.
  const span = spec.durationSeconds ?? dna.durationFrames / dna.fps;
  const scale = spec.baseScale;
  const frames: Keyframe[] = [];
  const last = dna.samples.length - 1;
  dna.samples.forEach((sample, index) => {
    const value = dna.from + (dna.to - dna.from) * sample.value;
    // The analyzer samples every native frame; index/(n-1) is the exact frame
    // grid. Using the rounded JSON `t` puts keyframes a few microseconds after
    // the 30fps frame boundary, which delays every step by one render frame.
    const time = start + (index / last) * span;
    for (const axis of ["x", "y"] as const) {
      frames.push(
        keyframe(
          `${spec.idPrefix}-scale-${axis}-${index}`,
          time,
          `scale.${axis}`,
          scale * value,
          "hold",
        ),
      );
    }
  });
  // `hold` jumps at the end of a segment, so the last sample is already final.
  // Add an explicit tail only when the caller keeps the card alive afterwards.
  if (spec.holdUntil !== undefined && spec.holdUntil > start + span) {
    for (const axis of ["x", "y"] as const) {
      frames.push(
        keyframe(
          `${spec.idPrefix}-scale-${axis}-tail`,
          spec.holdUntil,
          `scale.${axis}`,
          scale * dna.to,
          "linear",
        ),
      );
    }
  }
  return frames;
}

const NAMED_FIT: Readonly<Record<string, EasingName>> = {
  linear: "linear",
  easeInQuad: "easeInQuad",
  easeOutQuad: "easeOutQuad",
  easeInCubic: "easeInCubic",
  easeOutCubic: "easeOutCubic",
  easeInOutCubic: "easeInOutCubic",
  easeOutQuart: "easeOutQuart",
  easeOutQuint: "easeOutQuint",
  easeOutExpo: "easeOutExpo",
  outBack: "easeOutBack",
};

/** The fitted easing as a pure function, matching the analyzer's families. */
export function fittedEasing(dna: MotionDna): (t: number) => number {
  const family = dna.fit.family;
  if (family === "bezier") {
    const x1 = dna.fit.params.x1 ?? 0.25;
    const y1 = dna.fit.params.y1 ?? 0.1;
    const x2 = dna.fit.params.x2 ?? 0.25;
    const y2 = dna.fit.params.y2 ?? 1;
    return cubicBezier(x1, y1, x2, y2);
  }
  if (family === "spring") {
    const zeta = dna.fit.params.zeta ?? 0.55;
    const omega = dna.fit.params.omega ?? 9;
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    return (t) =>
      1 -
      Math.exp(-zeta * omega * t) *
        (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t));
  }
  const name = NAMED_FIT[family];
  return name ? EASING_FUNCTIONS[name] : (t) => t;
}

/**
 * Play the fitted curve, quantized to the reference's native frame grid.
 * This is the deliverable's "clean curve": the shape comes from the fit, the
 * cadence comes from the source frames (18fps holds), not from smoothing.
 */
export function fittedCardKeyframes(dna: MotionDna, spec: ScalePlaybackSpec): Keyframe[] {
  if (dna.channel !== "visibleHeight") {
    throw new Error(`motion dna: ${dna.channel} cannot drive a card reveal`);
  }
  const start = spec.startTime ?? 0;
  const span = spec.durationSeconds ?? dna.durationFrames / dna.fps;
  const ease = fittedEasing(dna);
  const last = dna.samples.length - 1;
  const frames: Keyframe[] = [];
  for (let index = 0; index <= last; index++) {
    const eased = ease(index / last);
    const value = dna.from + (dna.to - dna.from) * eased;
    const time = start + (index / last) * span;
    for (const axis of ["x", "y"] as const) {
      frames.push(
        keyframe(
          `${spec.idPrefix}-scale-${axis}-${index}`,
          time,
          `scale.${axis}`,
          spec.baseScale * value,
          "hold",
        ),
      );
    }
  }
  if (spec.holdUntil !== undefined && spec.holdUntil > start + span) {
    for (const axis of ["x", "y"] as const) {
      frames.push(
        keyframe(
          `${spec.idPrefix}-scale-${axis}-tail`,
          spec.holdUntil,
          `scale.${axis}`,
          spec.baseScale * dna.to,
          "linear",
        ),
      );
    }
  }
  return frames;
}
