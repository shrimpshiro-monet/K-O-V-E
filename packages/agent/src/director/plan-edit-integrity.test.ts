import { describe, expect, it } from "vitest";
import type { Project } from "@kove-advanced/core/types/project";
import { TRANSITION_TYPES } from "@kove-advanced/core/types/effects";
import {
  SUPPORTED_TRANSITION_TYPES,
  pacingMatches,
} from "@kove-advanced/creation-schema";
import type { EditingHost, TextOverlayOptions, OverlayRef } from "../host";
import { HeadlessHost } from "../headless-host";
import { executeTool } from "../executor";
import { MockLLMClient, type LLMClient, type LLMResponse } from "../llm";
import { getDirectorPlanState } from "./plan-state";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const END: LLMResponse = { text: "Done.", stopReason: "end_turn", toolUses: [] };

function planResponse(input: Record<string, unknown>): LLMResponse {
  return {
    text: "",
    stopReason: "tool_use",
    toolUses: [{ id: `plan-${Math.random().toString(36).slice(2)}`, name: "submit_edit_plan", input }],
  };
}

/** Counts complete() calls so tests can assert bounded LLM usage. */
class CountingLLM implements LLMClient {
  calls = 0;
  private readonly inner: MockLLMClient;
  constructor(script: LLMResponse[]) {
    this.inner = new MockLLMClient([...script, END]);
  }
  async complete(): Promise<LLMResponse> {
    this.calls += 1;
    return this.inner.complete();
  }
}

function makeProject(): Project {
  return {
    id: "integrity-project",
    name: "Integrity",
    createdAt: 0,
    modifiedAt: 0,
    settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48000, channels: 2 },
    timeline: { duration: 0, tracks: [], subtitles: [], markers: [] },
    mediaLibrary: {
      items: [
        {
          id: "video-1",
          name: "footage.mp4",
          type: "video",
          metadata: { duration: 10 },
        },
        {
          id: "audio-1",
          name: "track.mp3",
          type: "audio",
          metadata: { duration: 30 },
        },
      ],
    },
  } as unknown as Project;
}

type HarnessHost = HeadlessHost &
  { llm: NonNullable<EditingHost["llm"]> } &
  Pick<EditingHost, "createTextOverlay" | "removeOverlay">;

interface Harness {
  host: HarnessHost;
  project: Project;
  llm: CountingLLM;
  createdTextOverlays: TextOverlayOptions[];
  setLlm: (...responses: LLMResponse[]) => CountingLLM;
  failNextTextCreation: () => void;
}

function harness(script: LLMResponse[] = []): Harness {
  const project = makeProject();
  const host = new HeadlessHost(project) as HarnessHost;
  const createdTextOverlays: TextOverlayOptions[] = [];
  let textShouldFail = false;
  let textSeq = 0;

  // Headless hosts have no overlay APIs — stub the engine-aware surface the
  // materializer uses, capturing what the director asked for.
  host.createTextOverlay = async (options: TextOverlayOptions): Promise<OverlayRef> => {
    if (textShouldFail) throw new Error("text engine unavailable (simulated interruption)");
    createdTextOverlays.push(options);
    textSeq += 1;
    return { id: `text-${textSeq}`, trackId: "text-track" };
  };
  host.removeOverlay = async (): Promise<boolean> => true;

  const state: Harness = {
    host,
    project,
    llm: new CountingLLM(script),
    createdTextOverlays,
    setLlm: (...responses: LLMResponse[]) => {
      state.llm = new CountingLLM(responses);
      host.llm = { client: state.llm, provider: "openai" };
      return state.llm;
    },
    failNextTextCreation: () => {
      textShouldFail = true;
    },
  };
  host.llm = { client: state.llm, provider: "openai" };
  return state;
}

function snapshotEdl(project: Project): string {
  return JSON.stringify({
    tracks: project.timeline.tracks,
    textClips: project.textClips ?? [],
    motionCompositions: project.motionCompositions ?? [],
    motionInstances: project.motionInstances ?? [],
  });
}

function timelineClips(project: Project): ReturnType<() => Project["timeline"]["tracks"][number]["clips"]> {
  return project.timeline.tracks.flatMap((track) => track.clips);
}

/** A well-formed plan against the harness project (video_0 resolves to video-1). */
function validPlan(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    segments: [
      {
        sourceVideoId: "video_0",
        sourceStartTime: 0,
        sourceEndTime: 4,
        trackIndex: 0,
        targetPosition: 0,
        effects: [],
        rationale: "hook",
      },
      {
        sourceVideoId: "video_0",
        sourceStartTime: 4,
        sourceEndTime: 8,
        trackIndex: 0,
        targetPosition: 4,
        effects: [],
        rationale: "payoff",
      },
    ],
    textElements: [],
    effects: [],
    transitions: [{ afterSegmentIndex: 0, type: "crossfade", duration: 0.25, rationale: "smooth cut" }],
    audioDecisions: [],
    metadata: {
      targetDuration: 8,
      targetPlatform: "social",
      genre: "test",
      pacing: "fast",
      rationale: "integrity fixture",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The invariant: one accepted planning turn → one valid timeline revision;
// repeating or retrying cannot change the result.
// ---------------------------------------------------------------------------

describe("plan_edit integrity", () => {
  it("accepts a valid plan as revision 1 and reports quality as unavailable, never a synthetic score", async () => {
    const h = harness([planResponse(validPlan())]);
    const result = await executeTool("plan_edit", { prompt: "make a highlight" }, h.host);

    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.revision).toBe(1);
    expect(data.idempotentReplay).toBe(false);
    // Fake quality signal is gone: unavailable status, no percentage anywhere.
    expect((data.quality as { status: string }).status).toBe("unavailable");
    expect(data.combinedScore).toBeUndefined();
    expect(data.qualityPipeline).toBeUndefined();
    expect(result.summary).not.toMatch(/Quality:\s*\d+%/);
    expect(timelineClips(h.project)).toHaveLength(2);
    expect(getDirectorPlanState(h.project).revision).toBe(1);
  });

  it("replays the same turn idempotently: second submit changes nothing and skips the LLM", async () => {
    const h = harness([planResponse(validPlan())]);
    const first = await executeTool("plan_edit", { prompt: "make a highlight" }, h.host);
    expect(first.ok).toBe(true);
    const edlAfterFirst = snapshotEdl(h.project);
    expect(h.llm.calls).toBe(1);

    const second = await executeTool("plan_edit", { prompt: "make a highlight" }, h.host);
    expect(second.ok).toBe(true);
    const data = second.data as Record<string, unknown>;
    expect(data.idempotentReplay).toBe(true);
    expect(data.revision).toBe(1);
    // Exact persisted EDL — byte-identical.
    expect(snapshotEdl(h.project)).toBe(edlAfterFirst);
    // No second planning call: the repeat was free.
    expect(h.llm.calls).toBe(1);
  });

  it("rejects a stale base revision and leaves the committed EDL untouched", async () => {
    const h = harness([planResponse(validPlan())]);
    expect((await executeTool("plan_edit", { prompt: "first pass" }, h.host)).ok).toBe(true);
    const edl = snapshotEdl(h.project);

    h.setLlm(planResponse(validPlan()));
    const stale = await executeTool(
      "plan_edit",
      { prompt: "second pass", baseRevision: 99 },
      h.host,
    );
    expect(stale.ok).toBe(false);
    expect(stale.error?.code).toBe("STALE_REVISION");
    expect((stale.data as { currentRevision: number }).currentRevision).toBe(1);
    expect(snapshotEdl(h.project)).toBe(edl);
    expect(h.llm.calls).toBe(0); // rejected before spending a plan call
  });

  it("replaces rather than stacks: a second plan leaves exactly one plan's content", async () => {
    const h = harness([planResponse(validPlan())]);
    expect((await executeTool("plan_edit", { prompt: "plan A" }, h.host)).ok).toBe(true);
    const clipsAfterA = timelineClips(h.project);
    expect(clipsAfterA).toHaveLength(2);

    h.setLlm(planResponse(validPlan()));
    const second = await executeTool(
      "plan_edit",
      { prompt: "plan B", baseRevision: 1 },
      h.host,
    );
    expect(second.ok).toBe(true);
    const data = second.data as Record<string, unknown>;
    expect(data.revision).toBe(2);
    expect((data.replacedPrevious as { revision: number }).revision).toBe(1);

    // Exactly one plan's clips — B's, not A's, not both.
    const clips = timelineClips(h.project);
    expect(clips).toHaveLength(2);
    const idsAfterA = new Set(clipsAfterA.map((clip) => clip.id));
    expect(clips.some((clip) => idsAfterA.has(clip.id))).toBe(false);
    expect(getDirectorPlanState(h.project).revision).toBe(2);
  });

  it("keeps intentional overlays legal: music and text over video commit fine", async () => {
    const plan = validPlan({
      textElements: [
        { content: "BIG HOOK", style: "title", startTime: 0, duration: 2, position: { x: 0.5, y: 0.2 }, rationale: "hook" },
      ],
      audioDecisions: [
        {
          type: "music",
          sourceVideoId: "audio-1",
          sourceStartTime: 0,
          sourceEndTime: 4,
          startTime: 0,
          duration: 4,
          volume: 0.4,
          rationale: "bed under speech",
        },
      ],
    });
    const h = harness([planResponse(plan)]);
    const result = await executeTool("plan_edit", { prompt: "hook with music" }, h.host);
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.audioCount).toBe(1);
    expect(data.textIds).toHaveLength(1);
    expect(h.createdTextOverlays[0]?.position).toEqual({ x: 0.5, y: 0.2 });
    // Position passed normalized — NOT pre-multiplied into pixels.
    expect(h.createdTextOverlays[0]?.position?.x).toBeLessThanOrEqual(1);
  });

  it("returns structured validation errors for an unsupported effect and leaves the timeline untouched", async () => {
    const bad = validPlan({
      segments: [
        {
          sourceVideoId: "video_0",
          sourceStartTime: 0,
          sourceEndTime: 4,
          trackIndex: 0,
          targetPosition: 0,
          effects: [],
          effectSpecs: [{ type: "shake", params: {}, rationale: "energy" }],
          rationale: "hook",
        },
        {
          sourceVideoId: "video_0",
          sourceStartTime: 4,
          sourceEndTime: 8,
          trackIndex: 0,
          targetPosition: 4,
          effects: [],
          rationale: "payoff",
        },
      ],
    });
    // First attempt invalid; the bounded repair attempt is also invalid.
    const h = harness([planResponse(bad), planResponse(bad)]);
    const result = await executeTool("plan_edit", { prompt: "shake it" }, h.host);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_EDIT_PLAN");
    const data = result.data as { issues: Array<{ code: string; message: string }> };
    expect(data.issues.some((issue) => issue.code === "unsupported_effect")).toBe(true);
    expect(data.issues.some((issue) => issue.message.includes("shake"))).toBe(true);
    expect(data.issues.some((issue) => issue.message.includes("chromatic-aberration"))).toBe(true);
    expect(timelineClips(h.project)).toHaveLength(0);
    expect(getDirectorPlanState(h.project).revision).toBe(0);
    expect(h.llm.calls).toBe(2); // plan + exactly one repair attempt
  });

  it("repairs a rejected plan when the second attempt is valid", async () => {
    const bad = validPlan({
      segments: [
        {
          sourceVideoId: "video_0",
          sourceStartTime: 0,
          sourceEndTime: 4,
          trackIndex: 0,
          targetPosition: 0,
          effects: ["not-a-real-effect"],
          rationale: "hook",
        },
      ],
      transitions: [],
      metadata: { targetDuration: 4, targetPlatform: "social", genre: "test", pacing: "fast", rationale: "x" },
    });
    const h = harness([planResponse(bad), planResponse(validPlan())]);
    const result = await executeTool("plan_edit", { prompt: "repair me" }, h.host);

    expect(result.ok).toBe(true);
    expect(timelineClips(h.project)).toHaveLength(2);
    expect(h.llm.calls).toBe(2); // plan + one repair
    expect(getDirectorPlanState(h.project).revision).toBe(1);
  });

  it("rejects a text position outside the normalized 0-1 range", async () => {
    const bad = validPlan({
      textElements: [
        { content: "corner?", style: "caption", startTime: 0, duration: 2, position: { x: 960, y: 540 }, rationale: "pixels" },
      ],
    });
    const h = harness([planResponse(bad), planResponse(bad)]);
    const result = await executeTool("plan_edit", { prompt: "positioned caption" }, h.host);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_EDIT_PLAN");
    const data = result.data as { issues: Array<{ code: string }> };
    expect(data.issues.some((issue) => issue.code === "invalid_text_position")).toBe(true);
    expect(timelineClips(h.project)).toHaveLength(0);
  });

  it("treats hardCut as a cut: no transition object is committed", async () => {
    const plan = validPlan({
      transitions: [{ afterSegmentIndex: 0, type: "hardCut", duration: 0, rationale: "smash cut" }],
    });
    const h = harness([planResponse(plan)]);
    const result = await executeTool("plan_edit", { prompt: "hard cuts only" }, h.host);

    expect(result.ok).toBe(true);
    expect(h.project.timeline.tracks.flatMap((track) => track.transitions ?? [])).toHaveLength(0);
    const data = result.data as { editPlan: { transitions: unknown[] } };
    expect(data.editPlan.transitions).toHaveLength(0);
  });

  it("rejects an unsupported transition name with a structured error", async () => {
    const plan = validPlan({
      transitions: [{ afterSegmentIndex: 0, type: "star-wipe-9000", duration: 0.3, rationale: "flashy" }],
    });
    const h = harness([planResponse(plan), planResponse(plan)]);
    const result = await executeTool("plan_edit", { prompt: "fancy transition" }, h.host);

    expect(result.ok).toBe(false);
    const data = result.data as { issues: Array<{ code: string }> };
    expect(data.issues.some((issue) => issue.code === "unsupported_transition")).toBe(true);
    expect(timelineClips(h.project)).toHaveLength(0);
  });

  it("rejects overlapping primary-video segments on the same track", async () => {
    const plan = validPlan({
      segments: [
        {
          sourceVideoId: "video_0",
          sourceStartTime: 0,
          sourceEndTime: 4,
          trackIndex: 0,
          targetPosition: 0,
          effects: [],
          rationale: "one",
        },
        {
          sourceVideoId: "video_0",
          sourceStartTime: 4,
          sourceEndTime: 8,
          trackIndex: 0,
          targetPosition: 2, // overlaps segment 1
          effects: [],
          rationale: "two",
        },
      ],
      transitions: [],
    });
    const h = harness([planResponse(plan), planResponse(plan)]);
    const result = await executeTool("plan_edit", { prompt: "stacked" }, h.host);

    expect(result.ok).toBe(false);
    const data = result.data as { issues: Array<{ code: string }> };
    expect(data.issues.some((issue) => issue.code === "overlapping_timeline_segments")).toBe(true);
    expect(timelineClips(h.project)).toHaveLength(0);
  });

  it("retries a truncated plan call once instead of failing", async () => {
    const truncated: LLMResponse = { text: "partial", stopReason: "max_tokens", toolUses: [] };
    const h = harness([truncated, planResponse(validPlan())]);
    const result = await executeTool("plan_edit", { prompt: "long plan" }, h.host);

    expect(result.ok).toBe(true);
    expect(h.llm.calls).toBe(2);
    expect(getDirectorPlanState(h.project).revision).toBe(1);
  });

  it("interrupted mid-apply leaves the previous revision untouched; the retry commits exactly once", async () => {
    const h = harness([planResponse(validPlan())]);
    h.failNextTextCreation(); // text engine throws after clips were added

    const planWithText = validPlan({
      textElements: [{ content: "boom", style: "title", startTime: 0, duration: 1, rationale: "x" }],
    });
    h.setLlm(planResponse(planWithText));
    const failed = await executeTool("plan_edit", { prompt: "gets interrupted" }, h.host);
    expect(failed.ok).toBe(false);
    expect(failed.error?.code).toBe("EDIT_PLAN_APPLY_FAILED");
    // Compensating cleanup: nothing from the partial apply remains.
    expect(timelineClips(h.project)).toHaveLength(0);
    expect(h.project.timeline.tracks.flatMap((track) => track.transitions ?? [])).toHaveLength(0);
    expect(getDirectorPlanState(h.project).revision).toBe(0);
    expect(getDirectorPlanState(h.project).lastReplay).toBeUndefined();

    // Recovery: engine back, retry the turn.
    const h2 = h;
    h2.host.createTextOverlay = async (options: TextOverlayOptions) => {
      h2.createdTextOverlays.push(options);
      return { id: "text-recovered", trackId: "text-track" };
    };
    h2.setLlm(planResponse(planWithText));
    const retried = await executeTool("plan_edit", { prompt: "gets interrupted" }, h2.host);
    expect(retried.ok).toBe(true);
    // Exactly one plan's worth of content after the retry — not doubled.
    expect(timelineClips(h2.project)).toHaveLength(2);
    expect(getDirectorPlanState(h2.project).revision).toBe(1);
  });

  it("supports only replace_plan mode", async () => {
    const h = harness([planResponse(validPlan())]);
    const result = await executeTool(
      "plan_edit",
      { prompt: "patch please", mode: "patch" },
      h.host,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PATCH_UNSUPPORTED");
    expect(h.llm.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Renderer-backed vocabulary boundary tools + sync with core
// ---------------------------------------------------------------------------

describe("renderer-backed vocabulary boundary", () => {
  it("keeps the creation-schema transition list in sync with the core renderer list", () => {
    expect([...SUPPORTED_TRANSITION_TYPES].sort()).toEqual([...TRANSITION_TYPES].sort());
  });

  it("rejects unsupported effect types at the effect/add boundary", async () => {
    const project = makeProject();
    const host = new HeadlessHost(project);
    // Seed a clip to attach the effect to.
    await host.applyAction({
      type: "track/add",
      id: "t1",
      timestamp: Date.now(),
      params: { trackType: "video" },
    });
    const track = host.getProject().timeline.tracks[0];
    await host.applyAction({
      type: "clip/add",
      id: "c1",
      timestamp: Date.now(),
      params: { trackId: track.id, mediaId: "video-1", startTime: 0, duration: 4 },
    });
    const clipId = host.getProject().timeline.tracks[0]!.clips[0]!.id;

    const rejected = await executeTool("add_video_effect", { clipId, effectType: "zoom-punch" }, host);
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.code).toBe("UNSUPPORTED_EFFECT");

    const accepted = await executeTool(
      "add_video_effect",
      { clipId, effectType: "chromatic-aberration" },
      host,
    );
    expect(accepted.ok).toBe(true);
  });

  it("rejects unsupported transition types at the add_transition boundary", async () => {
    const project = makeProject();
    const host = new HeadlessHost(project);
    await host.applyAction({
      type: "track/add",
      id: "t1",
      timestamp: Date.now(),
      params: { trackType: "video" },
    });
    const trackId = host.getProject().timeline.tracks[0]!.id;
    for (const [index, startTime] of [0, 4].entries()) {
      await host.applyAction({
        type: "clip/add",
        id: `c${index}`,
        timestamp: Date.now(),
        params: { trackId, mediaId: "video-1", startTime, duration: 4 },
      });
    }
    const [clipA, clipB] = host.getProject().timeline.tracks[0]!.clips;

    const rejected = await executeTool(
      "add_transition",
      { clipAId: clipA!.id, clipBId: clipB!.id, transitionType: "match-cut-fancy", duration: 0.3 },
      host,
    );
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.code).toBe("UNSUPPORTED_TRANSITION");

    const accepted = await executeTool(
      "add_transition",
      { clipAId: clipA!.id, clipBId: clipB!.id, transitionType: "crossfade", duration: 0.3 },
      host,
    );
    expect(accepted.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// medium / moderate pacing equivalence
// ---------------------------------------------------------------------------

describe("style review pacing equivalence", () => {
  it("treats medium and moderate as the same pacing band", () => {
    expect(pacingMatches("moderate", "medium")).toBe(true);
    expect(pacingMatches("medium", "medium")).toBe(true);
    expect(pacingMatches("fast", "slow")).toBe(false);
    expect(pacingMatches("unknown", "slow")).toBe(false);
  });
});
