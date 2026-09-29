import type { Project, DirectorPlanCommit, DirectorPlanState } from "@kove-advanced/core/types/project";
import type { EditingHost } from "../host";

/**
 * Plan-revision state helpers.
 *
 * The state lives ON the project (`project.directorPlanState`) so it persists
 * with the project file, survives reloads, and is isolated per project —
 * the project serializer spreads the whole object, so no schema migration is
 * needed for reads; older files simply lack the field.
 */

const DEFAULT_STATE: DirectorPlanState = { revision: 0, commit: null };

export function getDirectorPlanState(project: Project): DirectorPlanState {
  const state = project.directorPlanState;
  if (
    state &&
    typeof state.revision === "number" &&
    Number.isFinite(state.revision)
  ) {
    return state;
  }
  return DEFAULT_STATE;
}

export function setDirectorPlanState(project: Project, state: DirectorPlanState): void {
  (project as { directorPlanState?: DirectorPlanState }).directorPlanState = state;
}

/**
 * Deterministic idempotency key for a planning turn: identical inputs (same
 * prompt, genre, footage graph, reference analysis) derive the same key, so a
 * retried turn replays the committed result instead of re-applying.
 * FNV-1a over the JSON — collision risk is irrelevant for a per-project
 * single-entry replay cache.
 */
export function derivePlanIdempotencyKey(parts: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(parts) ?? "";
  } catch {
    json = String(parts);
  }
  let hash = 2166136261;
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const fnv = (hash >>> 0).toString(36);
  return `plan-${fnv}-${json.length.toString(36)}`;
}

/**
 * A stored replay is only valid while its committed clips are still on the
 * timeline. If the user manually deleted the plan's clips, repeating the turn
 * must produce a fresh plan rather than report a success that no longer
 * describes the timeline.
 */
export function replayIsIntact(project: Project, state: DirectorPlanState): boolean {
  if (!state.lastReplay || !state.commit) return false;
  const present = new Set(
    project.timeline.tracks.flatMap((track) => track.clips.map((clip) => clip.id)),
  );
  const owned = state.commit.ownedClipIds;
  // Text-only or empty plans: nothing clip-shaped to verify — accept the replay.
  if (owned.length === 0) return true;
  return owned.every((clipId) => present.has(clipId));
}

export interface RemoveOwnedResult {
  readonly removed: number;
  readonly warnings: string[];
}

/**
 * Best-effort removal of everything the previous committed plan created.
 * Transitions go first (they reference clips), then clips, then text
 * overlays, then motion instances/compositions. Failures are collected as
 * warnings — a missing entity (already deleted by the user) is not an error.
 */
export async function removeOwnedEntities(
  host: EditingHost,
  commit: DirectorPlanCommit,
): Promise<RemoveOwnedResult> {
  let removed = 0;
  const warnings: string[] = [];

  const run = async (type: string, params: Record<string, unknown>, label: string): Promise<void> => {
    try {
      const result = await host.applyAction({
        type: type as never,
        id: `plan-cleanup-${type}-${removed}-${Date.now()}`,
        timestamp: Date.now(),
        params,
      });
      if (result.success) removed += 1;
      else warnings.push(`Could not remove ${label}: ${result.error?.message ?? "unknown error"}`);
    } catch (error) {
      warnings.push(`Could not remove ${label}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  };

  for (const transitionId of commit.ownedTransitionIds ?? []) {
    await run("transition/remove", { transitionId }, `transition ${transitionId}`);
  }
  for (const clipId of commit.ownedClipIds) {
    await run("clip/remove", { clipId }, `clip ${clipId}`);
  }
  for (const textId of commit.ownedTextClipIds) {
    if (host.removeOverlay) {
      try {
        const okRemoved = await host.removeOverlay("text", textId);
        if (okRemoved) removed += 1;
        else warnings.push(`Could not remove text overlay ${textId}`);
      } catch (error) {
        warnings.push(`Could not remove text overlay ${textId}: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    } else {
      warnings.push(`Host cannot remove text overlay ${textId}; it may remain visible`);
    }
  }
  for (const instanceId of commit.ownedMotionInstanceIds ?? []) {
    await run("motion/removeInstance", { instanceId }, `motion instance ${instanceId}`);
  }
  for (const compositionId of commit.ownedMotionCompositionIds ?? []) {
    await run("motion/removeComposition", { compositionId }, `motion composition ${compositionId}`);
  }

  return { removed, warnings };
}
