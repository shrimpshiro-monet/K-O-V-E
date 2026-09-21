import type {
  EditPlan,
  SegmentMap,
  RenderedFrameObservation,
  RenderedDraftReview,
} from "@kove-advanced/creation-schema";
import { reviewRenderedDraft, normalizeTransitionType } from "@kove-advanced/creation-schema";
import type { EditingHost } from "../host";
import type { DraftSelfReview, EditPlanReview, MaterializedDraftSummary } from "./plan-review";
import { reviewMaterializedDraft } from "./plan-review";

export interface FrameSamplingResult {
  readonly observations: readonly RenderedFrameObservation[];
  readonly sampledCount: number;
  readonly totalDuration: number;
  readonly extractionFailed: boolean;
}

export interface QualityPipelineResult {
  readonly renderedReview: RenderedDraftReview;
  readonly draftReview: DraftSelfReview;
  readonly combinedScore: number;
  readonly needsCorrection: boolean;
  readonly corrections: readonly QualityCorrection[];
  readonly editorialReview: EditorialReview;
  readonly extractionFailed: boolean;
}

export interface EditorialReview {
  readonly pacingScore: number;
  readonly varietyScore: number;
  readonly beatAlignmentScore: number;
  readonly overallGrade: "A" | "B" | "C" | "D" | "F";
  readonly issues: readonly string[];
}

export interface QualityCorrection {
  readonly kind: "effect" | "timing" | "transition" | "pacing" | "text";
  readonly segmentIndex?: number;
  readonly description: string;
}

/**
 * Sample frames from the rendered timeline at strategic timestamps.
 * Uses the host's extractVideoFrame job to capture frames.
 *
 * Falls back to observations derived from the plan's own data (segment timing,
 * effects, transitions) when the host cannot extract frames — this is still
 * better than pure synthetic values because it reflects what was actually planned.
 */
export async function sampleRenderedFrames(
  plan: EditPlan,
  host: EditingHost,
): Promise<FrameSamplingResult> {
  const totalDuration = plan.metadata.targetDuration > 0
    ? plan.metadata.targetDuration
    : plan.segments.reduce(
      (sum, seg) => sum + Math.max(0, seg.sourceEndTime - seg.sourceStartTime),
      0,
    );

  const sampleCount = Math.min(20, Math.max(4, Math.ceil(totalDuration / 2)));
  const timestamps = generateSampleTimestamps(totalDuration, sampleCount);

  const observations: RenderedFrameObservation[] = [];
  let extractionFailed = false;

  for (const timestamp of timestamps) {
    try {
      const result = await host.runJob("extractVideoFrame", { time: timestamp });
      if (result.ok && result.data && typeof result.data === "object") {
        const data = result.data as Record<string, unknown>;
        observations.push({
          timestamp,
          sharpness: clamp(Number(data.sharpness) || 0.7),
          subjectVisibility: clamp(Number(data.subjectVisibility) || 0.7),
          textLegibility: clamp(Number(data.textLegibility) || 0.8),
          audioEnergy: typeof data.audioEnergy === "number" ? clamp(data.audioEnergy) : undefined,
          hasBlackFrame: Boolean(data.hasBlackFrame),
        });
      } else {
        extractionFailed = true;
        // Do NOT fabricate observations — a guessed number presented as
        // measured is worse than no number. The pipeline will exclude the
        // rendered review from the combined score when extraction fails.
      }
    } catch {
      extractionFailed = true;
      // Same — no fabricated fallback.
    }
  }

  return { observations, sampledCount: observations.length, totalDuration, extractionFailed };
}

/**
 * Run the full quality review pipeline: visual frame review + materialized
 * draft review + editorial review, combined into a single score with
 * targeted correction hints.
 *
 * When frame extraction fails, the rendered visual review is excluded from
 * the combined score — a guessed number presented as measured is worse than
 * no number. The caller should check `extractionFailed` and either retry
 * or report the score as "unverified".
 */
export function runQualityPipeline(
  plan: EditPlan,
  segmentMap: SegmentMap,
  materialized: MaterializedDraftSummary,
  planReview: EditPlanReview,
  frameObservations: readonly RenderedFrameObservation[],
  extractionFailed: boolean = false,
): QualityPipelineResult {
  const renderedReview = reviewRenderedDraft(frameObservations);
  const draftReview = reviewMaterializedDraft(plan, segmentMap, materialized, planReview, frameObservations);
  const editorialReview = reviewEditorialQuality(plan, segmentMap);

  // When frame extraction failed, the rendered review is based on zero real
  // observations — exclude it from the combined score entirely andredistribute
  // its weight to the other two pillars.
  let combinedScore: number;
  if (extractionFailed) {
    // draft (45%) + editorial (55%)
    combinedScore =
      draftReview.score * 0.45 +
      editorialReview.pacingScore * 0.20 +
      editorialReview.varietyScore * 0.20 +
      editorialReview.beatAlignmentScore * 0.15;
  } else {
    // visual (25%) + draft (35%) + editorial (40%)
    combinedScore =
      renderedReview.score * 0.25 +
      draftReview.score * 0.35 +
      editorialReview.pacingScore * 0.15 +
      editorialReview.varietyScore * 0.15 +
      editorialReview.beatAlignmentScore * 0.1;
  }

  const needsCorrection = combinedScore < 0.65 || draftReview.needsRevision || editorialReview.issues.length > 2;

  const corrections = identifyCorrections(plan, renderedReview, draftReview, editorialReview);

  return { renderedReview, draftReview, combinedScore, needsCorrection, corrections, editorialReview, extractionFailed };
}

/**
 * Apply targeted corrections to the timeline based on quality review findings.
 * Only fixes what is wrong — never rebuilds the entire timeline.
 */
export async function applyTargetedCorrections(
  plan: EditPlan,
  corrections: readonly QualityCorrection[],
  clipIds: readonly string[],
  host: EditingHost,
): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;

  for (const correction of corrections) {
    try {
      switch (correction.kind) {
        case "effect": {
          if (correction.segmentIndex === undefined) { skipped++; break; }
          const clipId = clipIds[correction.segmentIndex];
          if (!clipId) { skipped++; break; }
          const segment = plan.segments[correction.segmentIndex];
          const effectSpecs = segment?.effectSpecs ?? [];
          for (const spec of effectSpecs) {
            await host.applyAction({
              type: "effect/add",
              id: `quality-fix-${applied}`,
              timestamp: Date.now(),
              params: {
                clipId,
                effectType: spec.type,
                params: {
                  ...spec.params,
                  ...(spec.intensity !== undefined ? { intensity: Math.max(0, Math.min(1, spec.intensity)) } : {}),
                },
              },
            });
            applied++;
          }
          break;
        }
        case "timing": {
          if (correction.segmentIndex === undefined) { skipped++; break; }
          const clipId = clipIds[correction.segmentIndex];
          if (!clipId) { skipped++; break; }
          const segment = plan.segments[correction.segmentIndex];
          const clip = host.getProject().timeline.tracks
            .flatMap((t) => t.clips)
            .find((c) => c.id === clipId);
          if (clip && segment) {
            const targetPosition = Math.max(0, segment.targetPosition ?? clip.startTime);
            await host.applyAction({
              type: "clip/update",
              id: `quality-fix-${applied}`,
              timestamp: Date.now(),
              params: { clipId, startTime: targetPosition },
            });
            applied++;
          } else {
            skipped++;
          }
          break;
        }
        case "transition": {
          // Find transitions that can be diversified — replace a repeated
          // transition type with a varied one from the allowed palette.
          const project = host.getProject();
          const allTransitions = project.timeline.tracks
            .flatMap((track) => track.transitions ?? []);
          if (allTransitions.length < 2) { skipped++; break; }

          // Build a variety palette from existing unique types
          const existingTypes = [...new Set(allTransitions.map((t) => t.type))];
          const varietyPalette = existingTypes.length > 1
            ? existingTypes
            : ["crossfade", "dipToBlack", "wipe", "slide"];

          // Find consecutive transitions of the same type and cycle them
          let lastType = "";
          for (const transition of allTransitions) {
            if (transition.type === lastType) {
              // Pick the next type in the palette
              const currentIndex = varietyPalette.indexOf(transition.type);
              const nextType = varietyPalette[(currentIndex + 1) % varietyPalette.length]!;
              const normalized = normalizeTransitionType(nextType) ?? nextType;
              await host.applyAction({
                type: "transition/update",
                id: `quality-fix-transition-${applied}`,
                timestamp: Date.now(),
                params: { transitionId: transition.id, type: normalized },
              });
              applied++;
            }
            lastType = transition.type;
          }
          break;
        }
        case "pacing": {
          // Pacing corrections: identify segments with identical durations
          // and adjust the shortest/longest to create variety.
          // This is a deterministic fix — no LLM needed.
          const shotDurations = plan.segments.map((seg) => ({
            index: clipIds.indexOf(clipIds[seg.sourceEndTime !== undefined ? plan.segments.indexOf(seg) : -1] ?? ""),
            duration: Math.max(0, seg.sourceEndTime - seg.sourceStartTime),
          })).filter((s) => s.index >= 0);

          if (shotDurations.length >= 3) {
            const sorted = [...shotDurations].sort((a, b) => a.duration - b.duration);
            const median = sorted[Math.floor(sorted.length / 2)]!;
            const allSimilar = sorted.every((d) => Math.abs(d.duration - median.duration) < 0.5);
            if (allSimilar) {
              // Stagger: extend odd-indexed segments by 20%, shorten even-indexed by 20%
              for (let i = 0; i < plan.segments.length; i++) {
                const clipId = clipIds[i];
                if (!clipId) continue;
                const clip = host.getProject().timeline.tracks
                  .flatMap((track) => track.clips)
                  .find((c) => c.id === clipId);
                if (!clip) continue;
                const adjustment = i % 2 === 0 ? 0.8 : 1.2;
                const newDuration = Math.max(0.1, clip.duration * adjustment);
                await host.applyAction({
                  type: "clip/update",
                  id: `quality-fix-pacing-${applied}`,
                  timestamp: Date.now(),
                  params: { clipId, duration: newDuration },
                });
                applied++;
              }
            }
          }
          break;
        }
        case "text": {
          // Reposition overlapping text elements to stagger them vertically.
          const textOverlaps = plan.textElements.filter((t) => {
            return plan.textElements.some(
              (other) => other !== t &&
                Math.abs(other.startTime - t.startTime) < 0.3 &&
                Math.abs((other.position?.x ?? 0.5) - (t.position?.x ?? 0.5)) < 0.1 &&
                Math.abs((other.position?.y ?? 0.5) - (t.position?.y ?? 0.5)) < 0.1,
            );
          });
          const project = host.getProject();
          const textClips = project.textClips ?? [];

          for (const overlap of textOverlaps) {
            // Find the text clip that matches this element
            const matchingClip = textClips.find(
              (clip) => Math.abs(clip.startTime - overlap.startTime) < 0.3,
            );
            if (!matchingClip) continue;
            // Shift overlapping text down by 10% of frame height
            const currentY = matchingClip.transform?.position?.y ?? 0.5;
            const newY = Math.min(0.9, currentY + 0.1);
            await host.applyAction({
              type: "text/update",
              id: `quality-fix-text-${applied}`,
              timestamp: Date.now(),
              params: {
                clipId: matchingClip.id,
                updates: { transform: { ...matchingClip.transform, position: { x: matchingClip.transform?.position?.x ?? 0.5, y: newY } } },
              },
            });
            applied++;
          }
          break;
        }
        default: {
          skipped++;
        }
      }
    } catch {
      skipped++;
    }
  }

  return { applied, skipped };
}

/**
 * Review the editorial quality of the plan: pacing, variety, and beat alignment.
 * This is a plan-level review (doesn't require rendered frames).
 */
function reviewEditorialQuality(
  plan: EditPlan,
  segmentMap: SegmentMap,
): EditorialReview {
  const issues: string[] = [];

  // ---- Pacing review ----
  const targetDuration = plan.metadata.targetDuration > 0
    ? plan.metadata.targetDuration
    : plan.segments.reduce(
      (sum, seg) => sum + Math.max(0, seg.sourceEndTime - seg.sourceStartTime),
      0,
    );

  const shotDurations = plan.segments
    .map((seg) => Math.max(0, seg.sourceEndTime - seg.sourceStartTime))
    .sort((a, b) => a - b);

  const expectedCpm = plan.metadata.pacing === "fast" ? 30
    : plan.metadata.pacing === "slow" ? 8
    : 16;
  const actualCpm = targetDuration > 0 ? (plan.segments.length / (targetDuration / 60)) : 0;
  const cpmDeviation = Math.abs(actualCpm - expectedCpm) / Math.max(expectedCpm, 1);
  const pacingScore = Math.max(0, 1 - cpmDeviation);

  if (cpmDeviation > 0.5) {
    issues.push(`Pacing mismatch: ${actualCpm.toFixed(0)} cuts/min vs ${expectedCpm} target for ${plan.metadata.pacing} pacing`);
  }

  // Check for uniform shot durations (robotic feel)
  if (shotDurations.length >= 3) {
    const median = shotDurations[Math.floor(shotDurations.length / 2)]!;
    const allSimilar = shotDurations.every((d) => Math.abs(d - median) < 0.5);
    if (allSimilar) {
      issues.push("All shots are similar duration — the edit will feel robotic. Alternate short and long shots.");
    }
  }

  // ---- Variety review ----
  const transitionTypes = new Set(plan.transitions.map((t) => t.type));
  const effectTypes = new Set([
    ...plan.effects.map((e) => e.type),
    ...plan.segments.flatMap((s) => s.effectSpecs?.map((e) => e.type) ?? []),
  ]);

  let varietyScore = 1;

  // Penalize using the same transition on every cut
  if (plan.transitions.length >= 2 && transitionTypes.size === 1) {
    varietyScore -= 0.3;
    issues.push("Same transition type on every cut — alternate between different transitions");
  }

  // Penalize no effects at all in a non-documentary edit
  if (effectTypes.size === 0 && plan.metadata.genre !== "documentary" && plan.segments.length > 2) {
    varietyScore -= 0.2;
    issues.push("No effects applied — consider adding 2-5 segment-specific effects for visual interest");
  }

  // Penalize no transitions (hard cuts only feels unfinished)
  if (plan.transitions.length === 0 && plan.segments.length > 1) {
    varietyScore -= 0.15;
    issues.push("No transitions — add 2-4 transitions between segments");
  }

  // Penalize missing speed ramps when footage has clear high-motion moments
  const hasMotionPeaks = segmentMap.videos.some((v) =>
    (Array.isArray(v.segments) ? v.segments : []).some((s) => (s.motionPeak ?? 0) > 0.7),
  );
  const hasSpeedRamps = plan.segments.some((s) => s.speedRamp && s.speedRamp.keyframes.length > 0);
  if (hasMotionPeaks && !hasSpeedRamps && plan.metadata.genre !== "documentary") {
    varietyScore -= 0.1;
    issues.push("Footage has high-motion moments but no speed ramps — add speed ramps for impact");
  }

  // Penalize no audio decisions when source has audio
  if (plan.audioDecisions.length === 0 && plan.segments.length > 0) {
    issues.push("No audio decisions — add a music bed or SFX if audio sources exist");
  }

  // Penalize too many of the same effect
  const effectCounts = new Map<string, number>();
  for (const spec of plan.segments.flatMap((s) => s.effectSpecs ?? [])) {
    effectCounts.set(spec.type, (effectCounts.get(spec.type) ?? 0) + 1);
  }
  for (const [type, count] of effectCounts) {
    if (count > plan.segments.length * 0.7) {
      varietyScore -= 0.15;
      issues.push(`Effect "${type}" applied to ${count}/${plan.segments.length} segments — too uniform`);
    }
  }

  varietyScore = Math.max(0, varietyScore);

  // ---- Beat alignment review ----
  let beatAlignmentScore = 1;
  const allBeats = segmentMap.videos.flatMap((v) =>
    (Array.isArray(v.segments) ? v.segments : []).flatMap((s) => s.beatTimestamps ?? []),
  );
  const uniqueBeats = [...new Set(allBeats)].sort((a, b) => a - b);

  if (uniqueBeats.length > 0 && plan.transitions.length > 0) {
    const tolerance = 0.2;
    let alignedCuts = 0;
    for (const transition of plan.transitions) {
      // Calculate the cut time from segment positions
      let cutTime = 0;
      for (let i = 0; i <= transition.afterSegmentIndex && i < plan.segments.length; i++) {
        const seg = plan.segments[i]!;
        if (i < transition.afterSegmentIndex) {
          cutTime += Math.max(0, seg.sourceEndTime - seg.sourceStartTime);
        }
      }
      const nearestBeat = uniqueBeats.reduce<{ time: number; distance: number } | undefined>(
        (best, beat) => {
          const distance = Math.abs(beat - cutTime);
          return distance <= tolerance && (!best || distance < best.distance)
            ? { time: beat, distance }
            : best;
        },
        undefined,
      );
      if (nearestBeat) alignedCuts++;
    }
    beatAlignmentScore = plan.transitions.length > 0 ? alignedCuts / plan.transitions.length : 1;

    if (beatAlignmentScore < 0.3 && uniqueBeats.length > 3) {
      issues.push(`Only ${(beatAlignmentScore * 100).toFixed(0)}% of cuts align with beats — sync cuts to beatTimestamps`);
    }
  }

  // ---- Text review ----
  const textOverlaps = plan.textElements.filter((t) => {
    const hasOverlap = plan.textElements.some(
      (other) => other !== t &&
        Math.abs(other.startTime - t.startTime) < 0.3 &&
        Math.abs((other.position?.x ?? 0.5) - (t.position?.x ?? 0.5)) < 0.1 &&
        Math.abs((other.position?.y ?? 0.5) - (t.position?.y ?? 0.5)) < 0.1,
    );
    return hasOverlap;
  });
  if (textOverlaps.length > 0) {
    issues.push(`${textOverlaps.length} text element(s) overlap in position and timing — stagger or reposition`);
  }

  // ---- Overall grade ----
  const avgScore = (pacingScore + varietyScore + beatAlignmentScore) / 3;
  const overallGrade: EditorialReview["overallGrade"] =
    avgScore >= 0.85 ? "A" :
    avgScore >= 0.7 ? "B" :
    avgScore >= 0.55 ? "C" :
    avgScore >= 0.4 ? "D" : "F";

  return { pacingScore, varietyScore, beatAlignmentScore, overallGrade, issues };
}

function identifyCorrections(
  plan: EditPlan,
  renderedReview: RenderedDraftReview,
  draftReview: DraftSelfReview,
  editorialReview: EditorialReview,
): QualityCorrection[] {
  const corrections: QualityCorrection[] = [];

  // Visual issues
  for (const issue of renderedReview.issues) {
    if (issue.includes("black")) {
      for (let i = 0; i < plan.segments.length; i++) {
        corrections.push({ kind: "timing", segmentIndex: i, description: `Black frame detected — re-check segment ${i} source range` });
      }
      break;
    }
    if (issue.includes("soft") || issue.includes("sharpness")) {
      for (let i = 0; i < plan.segments.length; i++) {
        const segment = plan.segments[i];
        if (segment.effectSpecs?.some((spec) => spec.type === "blur" || spec.type === "gaussianBlur")) {
          corrections.push({ kind: "effect", segmentIndex: i, description: `Blur effect on segment ${i} may be causing soft frames` });
        }
      }
    }
    if (issue.includes("text legibility")) {
      for (let i = 0; i < plan.textElements.length; i++) {
        corrections.push({ kind: "text", description: `Text element ${i} may need contrast or size adjustment` });
      }
    }
  }

  // Execution issues
  if (draftReview.execution.appliedEffects < draftReview.execution.expectedEffects) {
    const missing = draftReview.execution.expectedEffects - draftReview.execution.appliedEffects;
    corrections.push({ kind: "effect", description: `${missing} effect(s) were not applied — re-apply missing effects` });
  }
  if (draftReview.execution.appliedTransitions < draftReview.execution.expectedTransitions) {
    const missing = draftReview.execution.expectedTransitions - draftReview.execution.appliedTransitions;
    corrections.push({ kind: "transition", description: `${missing} transition(s) were not applied` });
  }

  // Editorial issues
  for (const issue of editorialReview.issues) {
    if (issue.includes("Pacing")) {
      corrections.push({ kind: "pacing", description: issue });
    } else if (issue.includes("robotic") || issue.includes("uniform")) {
      corrections.push({ kind: "pacing", description: issue });
    } else if (issue.includes("Same transition")) {
      corrections.push({ kind: "transition", description: issue });
    } else if (issue.includes("No effects")) {
      corrections.push({ kind: "effect", description: issue });
    } else if (issue.includes("No transitions")) {
      corrections.push({ kind: "transition", description: issue });
    } else if (issue.includes("speed ramps")) {
      corrections.push({ kind: "effect", description: issue });
    } else if (issue.includes("No audio")) {
      corrections.push({ kind: "pacing", description: issue });
    }
  }

  return corrections;
}

function generateSampleTimestamps(totalDuration: number, count: number): number[] {
  if (count <= 1) return [0];
  const step = totalDuration / (count - 1);
  return Array.from({ length: count }, (_, i) => Math.min(i * step, totalDuration));
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
