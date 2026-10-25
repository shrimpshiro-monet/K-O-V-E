import { executeTool } from "@kove-advanced/agent";
import { allocateSourceRanges } from "@kove-advanced/core/mirror/allocate-shots";
import { fitProfileToFootage } from "@kove-advanced/core/mirror/fit-profile-to-footage";
import { frameToSeconds, shotDurationFrames } from "@kove-advanced/core/mirror/timebase";
import { probeReferenceClock as probeContainerClock } from "@kove-advanced/core/mirror/reference-clock";
import type { ReferenceProfile } from "@kove-advanced/core/mirror/reference-profile";
import type { LabStats } from "@kove-advanced/core/color/reinhard-transfer";
import { getLiveEditorHost, runExclusive } from "../agent/host-singleton";
import { extractReference, sampleVideoStats, type ReferenceClock } from "./extract-reference";
import { enrichReferenceWithAudio } from "./enrich-reference-audio";
import { abortable, abortError, isAbortError, throwIfAborted } from "./reference-measurement";

/** A source video the reference structure can be applied to. */
export interface ReferenceSourceMedia {
  readonly id: string;
  readonly name: string;
  readonly duration: number;
  readonly blob: Blob | null;
}

export interface MeasuredReference {
  readonly profile: ReferenceProfile;
  readonly clock: ReferenceClock;
}

export interface MeasureReferenceOptions {
  /** Coalesced measurement progress (at most ~4 notices/s, plus the total). */
  onProgress?: (done: number, total: number) => void;
  /** Cancels container probing, decoding and frame analysis. */
  signal?: AbortSignal;
}

/**
 * Measures a reference video end to end: the frame clock comes from the
 * container itself, then shots, camera motion and color are measured locally.
 * The user is never asked to type a frame rate for a normal file.
 *
 * Every stage is cancellable through `signal`, and the analysis is bounded by
 * `extractReference`'s work budget, so this never wedges the tab.
 */
export async function measureReferenceVideo(
  file: Blob,
  options: MeasureReferenceOptions = {},
): Promise<MeasuredReference> {
  const { signal } = options;
  throwIfAborted(signal);
  const probe = await abortable(probeContainerClock(file), signal);
  const clock: ReferenceClock = {
    fps: probe.fps,
    fpsSource: "web-metadata",
    durationSeconds: probe.durationSeconds,
    codedDimensions: { width: probe.width, height: probe.height },
    rotationDegrees: probe.rotationDegrees,
  };
  throwIfAborted(signal);
  const profile = await extractReference(file, clock, {
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(signal ? { signal } : {}),
  });
  return { profile, clock };
}

/**
 * Adds the reference's beat grid and caption windows. The transcript is what
 * lets the director reproduce the reference's text timing instead of guessing,
 * so a failure here is a warning, not a stop.
 */
export async function enrichReferenceVideo(
  file: Blob,
  profile: ReferenceProfile,
  onStatus?: (message: string) => void,
  signal?: AbortSignal,
): Promise<ReferenceProfile> {
  try {
    return await enrichReferenceWithAudio(file, profile, {
      ...(onStatus ? { onStatus } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    // Cancellation is not an enrichment failure; it must stop the turn.
    if (signal?.aborted || isAbortError(error)) throw abortError(signal);
    return {
      ...profile,
      warnings: [
        ...(profile.warnings ?? []),
        "Audio annotation enrichment failed; the measured profile is used as-is.",
      ],
    };
  }
}

/**
 * Attaches the reference's EditDNA to the project without touching the
 * timeline. Used by the reference-only intent: the plan can then follow the
 * reference's rhythm and camera moves, but nothing is rebuilt.
 */
export async function attachReferenceProfile(profile: ReferenceProfile): Promise<void> {
  const result = await runExclusive(() =>
    executeTool(
      "execute_action",
      { type: "project/setMirrorProfile", params: { profile } },
      getLiveEditorHost(),
    ),
  );
  if (!result.ok) throw new Error(result.error?.message ?? result.summary);
}

/**
 * Rebuilds the source footage to the reference's structure, 1:1. The source
 * clips are re-cut to the reference's shot lengths and the measured grade is
 * transferred, so the timeline the model sees already has the shape of the
 * reference before the model adds anything.
 *
 * A reference longer than the footage is fitted to it: the shots keep their
 * lengths and the structure is cut where the footage runs out.
 */
export async function applyReferenceStructure(
  profile: ReferenceProfile,
  media: readonly ReferenceSourceMedia[],
): Promise<{ shotItemIds: string[]; summary: string; warnings: string[] }> {
  if (!media.length) throw new Error("No source footage to rebuild from the reference");
  const availableSeconds = media.reduce((sum, item) => sum + item.duration, 0);
  const fitted = fitProfileToFootage(profile, availableSeconds);
  const applied = fitted.profile;
  const stats: LabStats[] = [];
  const ranges = allocateSourceRanges(
    applied.shots.map((shot) => frameToSeconds(shotDurationFrames(shot), applied.fps)),
    media.map((item) => ({ id: item.id, duration: item.duration })),
  );
  const statsByRange = new Map<string, LabStats>();
  for (let i = 0; i < applied.shots.length; i++) {
    const range = ranges[i];
    const item = media.find((m) => m.id === range.mediaId);
    const blob = item?.blob;
    if (!blob) throw new Error(`Source video ${item?.name ?? "unknown"} is not available locally`);
    const key = `${range.mediaId}:${range.inPoint}`;
    const measured =
      statsByRange.get(key) ??
      (await sampleVideoStats(
        blob,
        range.inPoint + Math.min(0.25, (range.outPoint - range.inPoint) / 2),
      ));
    statsByRange.set(key, measured);
    stats.push(measured);
  }
  const result = await runExclusive(() =>
    executeTool(
      "mirror_reference_1to1",
      { profile: applied, userMediaIds: media.map((item) => item.id), targetStats: stats },
      getLiveEditorHost(),
    ),
  );
  if (!result.ok) throw new Error(result.error?.message ?? result.summary);
  const data = result.data as { shotItemIds: string[] };
  return {
    shotItemIds: data.shotItemIds,
    summary: result.summary,
    warnings: fitted.fitted
      ? [
          `The reference is longer than the footage: the structure was fitted to ${availableSeconds.toFixed(1)}s.`,
        ]
      : [],
  };
}
