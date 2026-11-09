import { beforeEach, describe, it, expect, afterEach } from "vitest";
import { HeadlessHost } from "./headless-host";
import { executeTool } from "./executor";
import { _resetPlanState, setPlanEditRankingEnabled } from "./registry";
import { makeEmptyProject } from "./test-fixtures";
import { installPixelShim, restorePixelShim, patternFrameDataUrl } from "./test-pixel-shim";
import type { EditPlan } from "@kove-advanced/creation-schema";
import type { Action, ActionError, ActionResult } from "@kove-advanced/core/types/actions";
import type { EditingHost, HostFeatures, TimelineFrame, TimelineFrameRequest } from "./host";
import type { LLMTurnInput, LLMResponse, LLMToolUse } from "./llm";

beforeEach(() => {
  setPlanEditRankingEnabled(false);
  _resetPlanState("p1");
});

/**
 * Regression tests for the director's rendered-review repair loop:
 *
 * 1. When a repair materialization adds artifacts and THEN fails, the catch
 *    must compensate every partial repair artifact so the first committed
 *    plan stands alone. (A `const repairedOwned` inside the try used to
 *    shadow the outer variable and silently skip this cleanup.)
 * 2. Exactly ONE automated repair — whatever its outcome, no second repair
 *    loop runs.
 */

afterEach(() => restorePixelShim());

function planToolUse(id: string, input: unknown): LLMToolUse {
  return { id, name: "submit_edit_plan", input } as LLMToolUse;
}

function oneSegmentPlan(): unknown {
  return {
    segments: [
      {
        sourceVideoId: "video-1",
        sourceStartTime: 0,
        sourceEndTime: 4,
        trackIndex: 0,
        targetPosition: 0,
        speed: 1,
        effects: [],
        rationale: "opening",
      },
    ],
    textElements: [],
    effects: [],
    transitions: [],
    audioDecisions: [],
    metadata: { targetDuration: 4, targetPlatform: "social", genre: "highlight", pacing: "fast", rationale: "test" },
  };
}

/** Two segments over the same footage: the repair's replacement edit. */
function twoSegmentPlan(): unknown {
  return {
    segments: [
      {
        sourceVideoId: "video-1",
        sourceStartTime: 0,
        sourceEndTime: 4,
        trackIndex: 0,
        targetPosition: 0,
        speed: 1,
        effects: [],
        rationale: "opening",
      },
      {
        sourceVideoId: "video-1",
        sourceStartTime: 4,
        sourceEndTime: 8,
        trackIndex: 0,
        targetPosition: 4,
        speed: 1,
        effects: [],
        rationale: "payoff",
      },
    ],
    textElements: [],
    effects: [],
    transitions: [],
    audioDecisions: [],
    metadata: { targetDuration: 8, targetPlatform: "social", genre: "highlight", pacing: "fast", rationale: "test" },
  };
}

/** Source segment map with a low-confidence segment: drops the self-review
 * score low enough that the rendered-repair gate actually engages. */
function lowConfidenceSegmentMap(): unknown {
  return {
    videos: [
      {
        videoId: "video-1",
        sourceFile: "test.mp4",
        duration: 8,
        resolution: { width: 1920, height: 1080 },
        fps: 30,
        totalFrames: 240,
        segments: [
          {
            id: "video-1-seg-0",
            startTime: 0,
            endTime: 8,
            sceneType: "b-roll",
            motionLevel: "medium",
            description: "sampled footage",
            hasDialogue: false,
            visualContent: "test content",
            confidence: 0.4,
          },
        ],
      },
    ],
  };
}

interface RepairTestHarness {
  readonly host: EditingHost;
  readonly project: ReturnType<typeof makeEmptyProject>;
  readonly llmCalls: LLMTurnInput[];
  readonly clipAdds: Array<{ trackId: string; mediaId: string }>;
}

function blackFrame(): TimelineFrame & { width: number; height: number } {
  return {
    dataUrl: patternFrameDataUrl({ pattern: "black" }),
    mimeType: "image/jpeg" as const,
    width: 96,
    height: 64,
    renderer: "pixel-shim",
  };
}

/**
 * plan_edit host wired for the rendered-review repair path: headless host +
 * scripted LLM + a working renderTimelineFrame (backed by the pixel shim) +
 * an optional deterministic `clip/add` failure after N successful adds.
 */
function makeHost(options: {
  projectId: string;
  llmScript: LLMResponse[];
  failClipAddAt?: number;
}): RepairTestHarness {
  _resetPlanState(options.projectId);
  const project = {
    ...makeEmptyProject(),
    id: options.projectId,
    mediaLibrary: {
      items: [{ id: "video-1", name: "test.mp4", type: "video", metadata: { duration: 8 } }],
    },
  } as unknown as ReturnType<typeof makeEmptyProject>;
  const baseHost = new HeadlessHost(project);

  const llmCalls: LLMTurnInput[] = [];
  const clipAdds: Array<{ trackId: string; mediaId: string }> = [];
  let llmIndex = 0;
  let clipAddCount = 0;
  const injectedError: ActionError = {
    code: "OVERLAP_DETECTED",
    message: "injected repair failure",
  };

  const host = baseHost as HeadlessHost & EditingHost;
  const baseApplyAction = baseHost.applyAction.bind(baseHost);
  const baseFeatures: HostFeatures = baseHost.features();
  host.features = () => ({ ...baseFeatures, renderTimelineFrame: true });
  host.renderTimelineFrame = async (request: TimelineFrameRequest): Promise<TimelineFrame> => {
    void request;
    return blackFrame();
  };
  host.llm = {
    provider: "openai",
    client: {
      complete: async (input: LLMTurnInput): Promise<LLMResponse> => {
        llmCalls.push(input);
        const next = options.llmScript[llmIndex];
        llmIndex += 1;
        if (!next) return { text: "script exhausted", toolUses: [], stopReason: "end_turn" as const };
        return next;
      },
    },
  };
  host.applyAction = async (action: Action): Promise<ActionResult> => {
    if (action.type === "clip/add") {
      clipAddCount += 1;
      const params = action.params as { trackId: string; mediaId: string };
      clipAdds.push({ trackId: params.trackId, mediaId: params.mediaId });
      if (options.failClipAddAt !== undefined && clipAddCount === options.failClipAddAt) {
        return { success: false, error: injectedError };
      }
    }
    return baseApplyAction(action);
  };

  return { host: host as unknown as EditingHost, project, llmCalls, clipAdds };
}

function videoTrackClips(harness: RepairTestHarness): Array<Record<string, unknown>> {
  return harness.project.timeline.tracks
    .filter((track) => track.type === "video")
    .flatMap((track) => track.clips)
    .map((clip) => clip as unknown as Record<string, unknown>);
}

function directorData(result: { ok: boolean; data?: unknown }): Record<string, unknown> {
  return result.data as Record<string, unknown>;
}

describe("plan_edit rendered-review repair cleanup", () => {
  it("compensates partial repair artifacts when a repair fails after materializing; the first plan remains the commit", async () => {
    installPixelShim();
    const harness = makeHost({
      projectId: "repair-cleanup-regression",
      // Scripted director sub-calls, in order:
      // 1: initial plan (1 segment → black rendered frames → repair gate).
      // 2: the pre-commit style/density review pass (one bounded revision);
      //    it returns the identical plan, which passes validation unchanged.
      // 3: the rendered-repair plan (2 segments) whose SECOND clip/add fails —
      //    the first repair artifact is already on the timeline by then.
      llmScript: [
        { text: "", stopReason: "tool_use", toolUses: [planToolUse("plan-1", oneSegmentPlan())] },
        { text: "", stopReason: "tool_use", toolUses: [planToolUse("density-rev", oneSegmentPlan())] },
        { text: "", stopReason: "tool_use", toolUses: [planToolUse("plan-repair", twoSegmentPlan())] },
      ],
      failClipAddAt: 3,
    });

    const result = await executeTool(
      "plan_edit",
      { prompt: "make a highlight", segmentMap: lowConfidenceSegmentMap() },
      harness.host,
    );

    expect(result.ok, result.error?.message ?? result.summary).toBe(true);
    const data = directorData(result);

    // The repair was attempted and reported as not applied.
    expect((data.renderedRepairNote as string) ?? "").toContain("automated rendered repair not applied");
    expect((data.renderedRepairNote as string) ?? "").toContain("injected repair failure");
    expect(data.quality && (data.quality as { repairApplied?: boolean }).repairApplied).toBe(false);

    // Exactly three LLM calls: plan + bounded density revision + ONE rendered
    // repair — never a second repair loop.
    expect(harness.llmCalls).toHaveLength(3);

    // Timeline: the FIRST plan's only clip, untouched. The repair's
    // successfully-materialized artifact must have been compensated away
    // (clip adds: 1 commit + 1 repair kept + 1 repair failed).
    const clips = videoTrackClips(harness);
    expect(harness.clipAdds).toHaveLength(3);
    expect(clips).toHaveLength(1);
    expect(clips[0].inPoint).toBe(0);
    expect(clips[0].outPoint).toBe(4);

    // Committed plan data is the FIRST plan; state points at its clip only.
    const editPlan = data.editPlan as EditPlan;
    expect(editPlan.segments).toHaveLength(1);
    const commit = (
      harness.project as unknown as {
        directorPlanState?: { revision: number; commit: { ownedClipIds: readonly string[] } | null };
      }
    ).directorPlanState;
    expect(commit?.revision).toBe(1);
    expect(commit?.commit?.ownedClipIds).toHaveLength(1);
    expect(commit?.commit?.ownedClipIds[0]).toBe((clips[0].id as string));
  });

  it("compensation does not run when the repair plan fails BEFORE materializing artifacts", async () => {
    installPixelShim();
    const harness = makeHost({
      projectId: "repair-cleanup-empty",
      llmScript: [
        { text: "", stopReason: "tool_use", toolUses: [planToolUse("plan-1", oneSegmentPlan())] },
        { text: "", stopReason: "tool_use", toolUses: [planToolUse("density-rev", oneSegmentPlan())] },
        // The rendered-repair call returns no EditPlan at all.
        { text: "no plan this time", stopReason: "end_turn", toolUses: [] },
      ],
    });

    const result = await executeTool(
      "plan_edit",
      { prompt: "make a highlight", segmentMap: lowConfidenceSegmentMap() },
      harness.host,
    );

    expect(result.ok, result.error?.message ?? result.summary).toBe(true);
    expect((result.summary as string) ?? "").toContain("automated rendered repair not applied");
    expect((result.summary as string) ?? "").toContain(
      "director returned no EditPlan for the rendered repair",
    );
    expect(videoTrackClips(harness)).toHaveLength(1);
    expect(harness.llmCalls).toHaveLength(3);
  });
});

describe("plan_edit one-repair limit", () => {
  it("applies at most one automated repair even when the re-review still scores low", async () => {
    installPixelShim();
    const harness = makeHost({
      projectId: "repair-once-success",
      // The rendered repair (call 3) succeeds and replaces the first plan. The
      // re-render still comes back all-black (score 0.35 < 0.6) but NO fourth
      // LLM call / repair loop is allowed.
      llmScript: [
        { text: "", stopReason: "tool_use", toolUses: [planToolUse("plan-1", oneSegmentPlan())] },
        { text: "", stopReason: "tool_use", toolUses: [planToolUse("density-rev", oneSegmentPlan())] },
        { text: "", stopReason: "tool_use", toolUses: [planToolUse("plan-repair", twoSegmentPlan())] },
      ],
    });

    const result = await executeTool(
      "plan_edit",
      { prompt: "make a highlight", segmentMap: lowConfidenceSegmentMap() },
      harness.host,
    );

    expect(result.ok, result.error?.message ?? result.summary).toBe(true);
    const data = directorData(result);
    expect(harness.llmCalls).toHaveLength(3);
    expect(data.quality && (data.quality as { repairApplied?: boolean }).repairApplied).toBe(true);
    expect(result.summary as string).toContain("automated rendered repair applied");

    // The repaired plan is what committed; its artifacts replaced the first.
    const editPlan = data.editPlan as EditPlan;
    expect(editPlan.segments).toHaveLength(2);
    expect(videoTrackClips(harness)).toHaveLength(2);

    // Review data carries the honesty labels and the measured score.
    const quality = data.quality as { status?: string; method?: string; repairApplied?: boolean; sampleCap?: number };
    expect(quality.status).toBe("reviewed");
    expect(quality.method).toBe("heuristic-pixel-proxies");
    expect(quality.sampleCap).toBe(8);
    expect(result.summary as string).toContain("heuristic pixel proxies");
    expect(result.summary as string).toContain("not semantic subject/OCR QA");
  });

  it("reports heuristic method on the first-commit failure path too", async () => {
    installPixelShim();
    const harness = makeHost({
      projectId: "repair-once-failure",
      llmScript: [
        { text: "", stopReason: "tool_use", toolUses: [planToolUse("plan-1", oneSegmentPlan())] },
        { text: "", stopReason: "tool_use", toolUses: [planToolUse("density-rev", oneSegmentPlan())] },
        { text: "nothing to say", stopReason: "end_turn", toolUses: [] },
      ],
    });

    const result = await executeTool(
      "plan_edit",
      { prompt: "make a highlight", segmentMap: lowConfidenceSegmentMap() },
      harness.host,
    );

    expect(result.ok, result.error?.message ?? result.summary).toBe(true);
    const quality = directorData(result).quality as { status?: string; method?: string; score?: number; sampleTimes?: number[]; sampleCap?: number };
    expect(quality.status).toBe("reviewed");
    expect(quality.method).toBe("heuristic-pixel-proxies");
    expect(quality.score).toBeCloseTo(0.35, 2);
    expect(quality.sampleCap).toBe(8);
    expect(quality.sampleTimes).toHaveLength(2);
    expect(harness.llmCalls).toHaveLength(3);
  });
});
