/**
 * Craft-eval bridge: lets the Python harness call production planner code.
 *
 * The harness could reimplement beat snapping in Python in twenty lines. It
 * deliberately does not: `snapPlanToBeatGrid` is the algorithm that ships, and a
 * scorecard that measures a different algorithm is measuring nothing. So the
 * harness writes a job to disk, runs this file through the repo's own vitest, and
 * reads the answer back.
 *
 *   KOVE_CRAFT_JOB=/path/to/job.json   (in)
 *   KOVE_CRAFT_OUT=/path/to/out.json   (out)
 *
 * Operations:
 *   snap    — snapPlanToBeatGrid(plan, segmentMap, options) → {plan, report}
 *   measure — measureTimelineBeatAlignment(plan, grid, subdivisionBeats) → number|null
 *   grid    — resolveTimelineBeatGrid(plan, segmentMap, options) → TimelineBeatGrid|null
 *   align   — cut times against a beat list, using the shipped tolerance
 *
 * Run with:
 *   cd packages/creation-schema
 *   ./node_modules/.bin/vitest run --config vitest.craft.config.ts
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import {
  BEAT_TOLERANCE_SECONDS,
  beatGridPoints,
  inferSubdivisionBeats,
  measureTimelineBeatAlignment,
  resolveTimelineBeatGrid,
  snapPlanToBeatGrid,
  type TimelineBeatGrid,
} from "../../../packages/creation-schema/src/director/beat-snap";
import type { EditPlan } from "../../../packages/creation-schema/src/director/edit-plan";
import type { SegmentMap } from "../../../packages/creation-schema/src/director/segment-map";

interface Job {
  readonly op: "snap" | "measure" | "grid" | "align" | "points";
  readonly plan?: EditPlan;
  readonly segmentMap?: SegmentMap;
  readonly options?: {
    readonly cutOffsetSeconds?: number;
    readonly subdivisionBeats?: number;
    readonly referenceShotLengthsInBeats?: readonly number[];
  };
  /** `align`: explicit cut times to judge. */
  readonly cuts?: readonly number[];
  /** `measure`/`points`: an explicit grid to judge against. */
  readonly grid?: TimelineBeatGrid | null;
}

/** Nearest grid distance and signed offset, mirroring the shipped tolerance. */
function judgeCuts(cuts: readonly number[], points: readonly number[]) {
  const offsets: number[] = [];
  if (points.length > 0) {
    for (const cut of cuts) {
      let best = Number.POSITIVE_INFINITY;
      let bestPoint = points[0]!;
      for (const point of points) {
        const distance = Math.abs(point - cut);
        if (distance < best) {
          best = distance;
          bestPoint = point;
        }
      }
      offsets.push(cut - bestPoint);
    }
  }
  const onBeat = offsets.filter((o) => Math.abs(o) <= BEAT_TOLERANCE_SECONDS).length;
  const sorted = [...offsets].sort((a, b) => a - b);
  const median = sorted.length
    ? sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]!
      : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2
    : null;
  return {
    toleranceSeconds: BEAT_TOLERANCE_SECONDS,
    evaluated: cuts.length,
    onBeat,
    onBeatRatio: cuts.length ? onBeat / cuts.length : null,
    medianOffsetSeconds: median,
    meanAbsOffsetSeconds: offsets.length
      ? offsets.reduce((sum, o) => sum + Math.abs(o), 0) / offsets.length
      : null,
    pointsCount: points.length,
  };
}

describe("craft bridge", () => {
  const jobPath = process.env.KOVE_CRAFT_JOB;
  const outPath = process.env.KOVE_CRAFT_OUT;

  it.runIf(Boolean(jobPath))("runs the requested operation", () => {
    expect(outPath, "KOVE_CRAFT_OUT must be set alongside KOVE_CRAFT_JOB").toBeTruthy();
    const job = JSON.parse(readFileSync(jobPath!, "utf8")) as Job;
    const options = job.options ?? {};

    let payload: unknown;
    switch (job.op) {
      case "snap": {
        const plan = job.plan as EditPlan;
        const requestedUnit = inferSubdivisionBeats(
          options.referenceShotLengthsInBeats ?? [],
          options.subdivisionBeats ?? 1,
        );
        const grid = resolveTimelineBeatGrid(plan, job.segmentMap, options);
        const result = snapPlanToBeatGrid(plan, job.segmentMap, options);
        payload = {
          plan: result.plan,
          report: result.report,
          requestedUnit,
          grid,
        };
        break;
      }
      case "measure": {
        payload = {
          onBeatRatio: measureTimelineBeatAlignment(
            job.plan as EditPlan,
            job.grid ?? null,
            options.subdivisionBeats ?? 1,
          ),
        };
        break;
      }
      case "grid": {
        payload = {
          grid: resolveTimelineBeatGrid(job.plan as EditPlan, job.segmentMap, options),
        };
        break;
      }
      case "points": {
        const grid = job.grid ?? null;
        payload = {
          points: grid ? beatGridPoints(grid, options.subdivisionBeats ?? 1) : [],
        };
        break;
      }
      case "align": {
        const grid = job.grid ?? null;
        const points = grid ? beatGridPoints(grid, options.subdivisionBeats ?? 1) : [];
        payload = judgeCuts(job.cuts ?? [], points);
        break;
      }
      default:
        throw new Error(`unknown op: ${String(job.op)}`);
    }

    writeFileSync(outPath!, JSON.stringify(payload, null, 2));
    expect(payload).toBeTruthy();
  });

  it("always exposes the shipped tolerance", () => {
    // Guards against a silent change to the tolerance the scorecard reports
    // against: the harness reads it from here, so the two cannot drift apart.
    expect(BEAT_TOLERANCE_SECONDS).toBeCloseTo(0.04, 6);
  });
});
