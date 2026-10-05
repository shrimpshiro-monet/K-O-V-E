import { describe, expect, it } from "vitest";
import { ActionExecutor } from "../actions/action-executor";
import { ActionHistory } from "../actions/action-history";
import type { Project } from "../types/project";
import type { Clip } from "../types/timeline";
import {
  executeCutPlan,
  planClipCuts,
  type ProposedCut,
} from "./silence-removal";

/**
 * End-to-end against the REAL ActionExecutor: computeCutRanges →
 * planClipCuts → executeCutPlan (split → bounds lookup → rippleDelete) →
 * final timeline layout → full undo restores the original clip.
 *
 * Note on ordering (spec step C): the executor resolves `__LAST_ADDED__`
 * only while replaying undo actions, so forward deletes cannot reference
 * pieces created by earlier splits statically. executeCutPlan therefore
 * resolves each delete target from the live timeline at execution time —
 * safe because planClipCuts processes cuts right-to-left, and a ripple
 * delete only shifts clips to the RIGHT of the removed piece.
 */

function makeProject(): Project {
  const clip: Partial<Clip> = {
    id: "clip-1",
    mediaId: "media-1",
    trackId: "track-1",
    startTime: 10,
    duration: 20,
    inPoint: 5,
    outPoint: 25,
    effects: [],
    audioEffects: [],
    volume: 1,
    keyframes: [],
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      anchor: { x: 0.5, y: 0.5 },
      rotation: 0,
      opacity: 1,
    },
  };
  return {
    id: "p1",
    name: "Test",
    createdAt: 0,
    modifiedAt: 0,
    settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48000, channels: 2 },
    timeline: {
      duration: 40,
      tracks: [
        {
          id: "track-1",
          name: "Video",
          type: "video",
          hidden: false,
          muted: false,
          clips: [clip],
        },
      ],
    },
    mediaLibrary: { items: [] },
  } as unknown as Project;
}

const trackClips = (project: Project) =>
  project.timeline.tracks[0]!.clips.map((c) => ({
    startTime: c.startTime,
    duration: c.duration,
  }));

const CUTS: ProposedCut[] = [
  { id: "left", start: 2, end: 4, reason: "silence", label: "2.0s silence" },
  { id: "right", start: 15, end: 16, reason: "filler", label: "filler “um”" },
];

describe("silence removal against the real ActionExecutor", () => {
  it("splits, deletes and ripples two cuts correctly (right-to-left plan)", async () => {
    const project = makeProject();
    const clip = project.timeline.tracks[0]!.clips[0] as Clip;
    const history = new ActionHistory();
    const executor = new ActionExecutor(history);

    const plan = planClipCuts(clip, CUTS);
    expect(plan.supported).toBe(true);
    // Right-to-left: the 15s cut executes before the 2s cut.
    expect(plan.ops.map((op) => op.cut.id)).toEqual(["right", "left"]);

    history.beginGroup("silence-removal");
    const execution = await executeCutPlan(executor, project, clip.id, plan);
    history.endGroup();

    expect(execution).toEqual({ ok: true, cutsDeleted: 2 });
    // Original [10,30] minus [12,14] and [25,26], rippled:
    //   [10,12] + [12,23] + [23,27] — contiguous, total 17s (20 − 2 − 1).
    expect(trackClips(project)).toEqual([
      { startTime: 10, duration: 2 },
      { startTime: 12, duration: 11 },
      { startTime: 23, duration: 4 },
    ]);
  });

  it("groups every op under one history group → single undo reverts all", async () => {
    const project = makeProject();
    const clip = project.timeline.tracks[0]!.clips[0] as Clip;
    const history = new ActionHistory();
    const executor = new ActionExecutor(history);
    const original = JSON.stringify(trackClips(project));

    const cuts: ProposedCut[] = [
      { id: "a", start: 1, end: 3, reason: "silence", label: "2.0s silence" },
      { id: "b", start: 8, end: 9, reason: "silence", label: "1.0s silence" },
      { id: "c", start: 18, end: 20, reason: "silence", label: "2.0s silence" },
    ];
    const plan = planClipCuts(clip, cuts);

    history.beginGroup("silence-removal");
    const execution = await executeCutPlan(executor, project, clip.id, plan);
    history.endGroup();
    expect(execution.cutsDeleted).toBe(3);

    // The whole batch is ONE undo unit: undoGroup() returns every inverse in
    // the group at once; replaying them reverts to the untouched clip.
    const inverses = history.undoGroup();
    // 3 cuts: 2 splits+delete, 2 splits+delete, 1 split+delete (tail edge).
    expect(inverses).toHaveLength(8);
    for (const inverse of inverses) {
      const result = await executor.execute(inverse, project);
      expect(result.success, result.error?.message ?? "").toBe(true);
    }
    expect(JSON.stringify(trackClips(project))).toBe(original);
    // And the history is empty — one undo consumed the entire batch.
    expect(history.undoGroup()).toEqual([]);
  });

  it("handles a head cut (piece keeps the original clip id)", async () => {
    const project = makeProject();
    const clip = project.timeline.tracks[0]!.clips[0] as Clip;
    const executor = new ActionExecutor(new ActionHistory());

    const plan = planClipCuts(clip, [
      { id: "head", start: 0, end: 2, reason: "silence", label: "2.0s silence" },
    ]);
    const execution = await executeCutPlan(executor, project, clip.id, plan);
    expect(execution).toEqual({ ok: true, cutsDeleted: 1 });
    expect(trackClips(project)).toEqual([{ startTime: 10, duration: 18 }]);
  });

  it("handles a full-clip cut (no splits, delete the whole clip)", async () => {
    const project = makeProject();
    const clip = project.timeline.tracks[0]!.clips[0] as Clip;
    const executor = new ActionExecutor(new ActionHistory());

    const plan = planClipCuts(clip, [
      { id: "all", start: 0, end: 20, reason: "silence", label: "20s silence" },
    ]);
    const execution = await executeCutPlan(executor, project, clip.id, plan);
    expect(execution).toEqual({ ok: true, cutsDeleted: 1 });
    expect(trackClips(project)).toEqual([]);
  });

  it("refuses unsupported clips without touching the project", async () => {
    const project = makeProject();
    const clip = { ...(project.timeline.tracks[0]!.clips[0] as Clip), reversed: true } as Clip;
    const executor = new ActionExecutor(new ActionHistory());
    const before = JSON.stringify(trackClips(project));

    const plan = planClipCuts(clip, CUTS);
    const execution = await executeCutPlan(executor, project, clip.id, plan);

    expect(execution.ok).toBe(false);
    expect(execution.error).toMatch(/reversed/);
    expect(JSON.stringify(trackClips(project))).toBe(before);
  });
});
