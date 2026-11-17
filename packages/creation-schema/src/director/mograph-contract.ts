import type { CameraMoveId, EditPlan, PlannedSegment } from "./edit-plan";
import { computePlanPlacement } from "./validate";
import type { DirectorValidationIssue } from "./validate";

export type MographPhaseId = "hook" | "build" | "peak" | "hold" | "exit";

export interface MographPhase {
  readonly id: MographPhaseId;
  readonly startFraction: number;
  readonly endFraction: number;
  readonly shotSeconds: readonly [number, number];
  readonly hardCutsAllowed: boolean;
  readonly motion: "continuous" | "idle" | "cut" | "still";
}

export interface MographHoldContract {
  readonly count: 1;
  readonly minSeconds: number;
  readonly maxSeconds: number;
  readonly startFraction: number;
}

export interface MographContract {
  readonly style: "mograph";
  readonly hookNoHardCutSeconds: number;
  readonly idleMotion: "default";
  readonly idleMoves: readonly CameraMoveId[];
  readonly hold: MographHoldContract;
  readonly phases: readonly MographPhase[];
}

const MOGRAPH_TEXT_PATTERN =
  /\b(magazine|editorial|collage|scrapbook|motion[- ]graphics|mograph|object[- ]wall|photo[- ]wall|kinetic[- ]type|paper[- ]cut)\b/i;

const DEFAULT_IDLE_MOVES: readonly CameraMoveId[] = [
  "slow-push",
  "drift-left",
  "breathe",
  "drift-right",
];

const EPSILON = 1e-6;

export function isMographRequest(
  prompt: string,
  genre?: { readonly id?: string; readonly name?: string } | string,
  reference?: unknown,
): boolean {
  const genreText =
    typeof genre === "string"
      ? genre
      : [genre?.id, genre?.name].filter((value): value is string => Boolean(value)).join(" ");
  if (MOGRAPH_TEXT_PATTERN.test(`${prompt}\n${genreText}`)) return true;
  if (!reference || typeof reference !== "object") return false;
  const record = reference as Record<string, unknown>;
  if (typeof record.version === "string" && /^kove\.mograph/i.test(record.version)) return true;
  if (record.mograph && typeof record.mograph === "object") return true;
  if (!Array.isArray(record.scenes)) return false;
  return record.scenes.some((value) => {
    if (!value || typeof value !== "object") return false;
    const scene = value as Record<string, unknown>;
    return (
      typeof scene.kind === "string" ||
      typeof scene.layoutTemplateId === "string" ||
      scene.entry !== undefined ||
      scene.exit !== undefined
    );
  });
}

export function buildMographContract(targetDuration: number): MographContract {
  const duration = Number.isFinite(targetDuration) && targetDuration > 0 ? targetDuration : 28;
  const hookSeconds = duration >= 8 ? 4 : Math.max(1, duration * 0.35);
  const hookFraction = Math.min(1, hookSeconds / duration);
  const buildEnd = Math.max(hookFraction, 0.55);
  const peakEnd = Math.max(buildEnd, 0.75);
  const holdEnd = Math.max(peakEnd, 0.85);
  return {
    style: "mograph",
    hookNoHardCutSeconds: hookSeconds,
    idleMotion: "default",
    idleMoves: DEFAULT_IDLE_MOVES,
    hold: {
      count: 1,
      minSeconds: 1.5,
      maxSeconds: 2.5,
      startFraction: 0.75,
    },
    phases: [
      {
        id: "hook",
        startFraction: 0,
        endFraction: hookFraction,
        shotSeconds: [hookSeconds, hookSeconds],
        hardCutsAllowed: false,
        motion: "continuous",
      },
      {
        id: "build",
        startFraction: hookFraction,
        endFraction: buildEnd,
        shotSeconds: [0.8, 2],
        hardCutsAllowed: true,
        motion: "idle",
      },
      {
        id: "peak",
        startFraction: buildEnd,
        endFraction: peakEnd,
        shotSeconds: [0.35, 0.8],
        hardCutsAllowed: true,
        motion: "cut",
      },
      {
        id: "hold",
        startFraction: peakEnd,
        endFraction: holdEnd,
        shotSeconds: [1.5, 2.5],
        hardCutsAllowed: true,
        motion: "still",
      },
      {
        id: "exit",
        startFraction: holdEnd,
        endFraction: 1,
        shotSeconds: [1.2, 2.5],
        hardCutsAllowed: true,
        motion: "idle",
      },
    ],
  };
}

function segmentDuration(segment: PlannedSegment): number {
  return Math.max(0, segment.sourceEndTime - segment.sourceStartTime);
}

function planDuration(plan: EditPlan): number {
  if (Number.isFinite(plan.metadata.targetDuration) && plan.metadata.targetDuration > 0) {
    return plan.metadata.targetDuration;
  }
  const placement = computePlanPlacement(plan);
  return plan.segments.reduce(
    (longest, segment, index) => Math.max(longest, (placement[index] ?? 0) + segmentDuration(segment)),
    0,
  );
}

function chooseHoldIndex(
  plan: EditPlan,
  placement: readonly number[],
  targetDuration: number,
  contract: MographContract,
): number | undefined {
  if (plan.segments.length === 0) return undefined;
  const flagged = plan.segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => segment.hold === true);
  if (flagged.length > 0) {
    return [...flagged]
      .sort((left, right) => segmentDuration(right.segment) - segmentDuration(left.segment))
      .at(0)?.index;
  }

  const inHoldWindow = plan.segments
    .map((segment, index) => ({
      segment,
      index,
      duration: segmentDuration(segment),
      start: placement[index] ?? 0,
    }))
    .filter(
      ({ duration, start }) =>
        duration >= contract.hold.minSeconds - EPSILON &&
        duration <= contract.hold.maxSeconds + EPSILON &&
        start >= targetDuration * contract.hold.startFraction - EPSILON,
    )
    .sort(
      (left, right) =>
        Math.abs(left.duration - 2) - Math.abs(right.duration - 2) ||
        right.start - left.start,
    );
  if (inHoldWindow.length > 0) return inHoldWindow[0]?.index;

  const lateSegments = plan.segments
    .map((segment, index) => ({
      segment,
      index,
      duration: segmentDuration(segment),
      start: placement[index] ?? 0,
    }))
    .filter(({ start, duration }) => start >= targetDuration * 0.6 && duration >= 1)
    .sort((left, right) => right.duration - left.duration || right.start - left.start);
  if (lateSegments.length > 0) return lateSegments[0]?.index;

  return plan.segments
    .map((segment, index) => ({ segment, index }))
    .sort((left, right) => segmentDuration(right.segment) - segmentDuration(left.segment))
    .at(0)?.index;
}

function idleIntensity(move: CameraMoveId): number {
  if (move === "breathe") return 0.25;
  if (move === "slow-push") return 0.32;
  return 0.28;
}

export function applyMographContract(plan: EditPlan): EditPlan {
  if (plan.segments.length === 0) return plan;
  const targetDuration = planDuration(plan);
  const contract = buildMographContract(targetDuration);
  const placement = computePlanPlacement(plan);
  const holdIndex = chooseHoldIndex(plan, placement, targetDuration, contract);
  const segments = plan.segments.map((segment, index) => {
    if (index === holdIndex) {
      return { ...segment, hold: true, cameraMoves: [] };
    }
    const move = contract.idleMoves[index % contract.idleMoves.length]!;
    return {
      ...segment,
      hold: undefined,
      cameraMoves:
        segment.cameraMoves && segment.cameraMoves.length > 0
          ? segment.cameraMoves
          : [{ move, intensity: idleIntensity(move) }],
    };
  });
  return { ...plan, segments };
}

export function validateMographPlan(
  plan: EditPlan,
  contract: MographContract = buildMographContract(planDuration(plan)),
): readonly DirectorValidationIssue[] {
  const issues: DirectorValidationIssue[] = [];
  if (plan.segments.length === 0) return issues;
  const targetDuration = planDuration(plan);
  const placement = computePlanPlacement(plan);
  const hookSeconds = contract.hookNoHardCutSeconds;
  const primaryTrack = plan.segments[0]?.trackIndex ?? 0;

  for (let index = 1; index < plan.segments.length; index += 1) {
    const segment = plan.segments[index]!;
    if ((segment.trackIndex ?? 0) !== primaryTrack) continue;
    const start = placement[index] ?? 0;
    if (start < hookSeconds - EPSILON) {
      issues.push({
        severity: "error",
        code: "mograph_hook_cut",
        message: `Mograph hook must be one continuous shot for the first ${hookSeconds.toFixed(1)}s; segment ${index} cuts at ${start.toFixed(2)}s.`,
        path: `segments.${index}.targetPosition`,
      });
      break;
    }
  }

  const holds = plan.segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => segment.hold === true);
  if (holds.length !== 1) {
    issues.push({
      severity: "error",
      code: "mograph_hold_count",
      message: `Mograph plan needs exactly one flagged hold; found ${holds.length}.`,
      path: "segments",
    });
  } else {
    const hold = holds[0]!;
    const duration = segmentDuration(hold.segment);
    const start = placement[hold.index] ?? 0;
    if (duration < contract.hold.minSeconds - EPSILON || duration > contract.hold.maxSeconds + EPSILON) {
      issues.push({
        severity: "error",
        code: "mograph_hold_duration",
        message: `Hold segment ${hold.index} is ${duration.toFixed(2)}s; it must be ${contract.hold.minSeconds}-${contract.hold.maxSeconds}s.`,
        path: `segments.${hold.index}`,
      });
    }
    if (start < targetDuration * contract.hold.startFraction - EPSILON) {
      issues.push({
        severity: "error",
        code: "mograph_hold_timing",
        message: `Hold segment ${hold.index} starts at ${start.toFixed(2)}s; it must start after ${(targetDuration * contract.hold.startFraction).toFixed(2)}s.`,
        path: `segments.${hold.index}.targetPosition`,
      });
    }
    if ((hold.segment.cameraMoves?.length ?? 0) > 0) {
      issues.push({
        severity: "error",
        code: "mograph_hold_motion",
        message: `Hold segment ${hold.index} must stay still; remove its camera moves.`,
        path: `segments.${hold.index}.cameraMoves`,
      });
    }
  }

  const holdIndex = holds.length === 1 ? holds[0]?.index : undefined;
  plan.segments.forEach((segment, index) => {
    if (index === holdIndex) return;
    if ((segment.cameraMoves?.length ?? 0) === 0) {
      issues.push({
        severity: "error",
        code: "mograph_idle_motion_missing",
        message: `Segment ${index} has no idle motion. Every non-hold segment defaults to a subtle camera move.`,
        path: `segments.${index}.cameraMoves`,
      });
    }
  });

  return issues;
}
