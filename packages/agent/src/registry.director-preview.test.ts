import { describe, it, expect, vi } from "vitest";
import { HeadlessHost } from "./headless-host";
import { executeTool } from "./executor";
import {
  _resetPlanState,
  MAX_DIRECTOR_PREVIEW_FRAMES,
  MIN_DIRECTOR_PREVIEW_FRAMES,
  selectDirectorPreviewFrames,
  describeDirectorPreviewFrames,
} from "./registry";
import { createTurnContext, trustedAnalysis } from "./turn-context";
import { makeEmptyProject } from "./test-fixtures";
import type { EditingHost } from "./host";
import type { DirectorFrameImage, DirectorFrameRole } from "./turn-context";
import type { LLMTurnInput, LLMResponse, LLMToolUse } from "./llm";

/**
 * The extract_segments → plan_edit frame channel. Frames from REFERENCE
 * videos must reach the director with role "reference" (style examples —
 * not footage to edit), every image's caption carries media ID/name,
 * timestamp and role, and the span-aware source budget never silently hides
 * an analyzed source video.
 */

vi.mock("@kove-advanced/frame-worker", () => {
  const frame = (timestamp: number) => ({
    timestamp,
    imageData: "RkFLRQ==",
    width: 16,
    height: 16,
  });
  const snapshotFor = (videoId: string, timestamps: number[], duration: number) => ({
    videoId,
    duration,
    frameCount: timestamps.length,
    batches: [
      {
        batchIndex: 0,
        sourceTimestamps: [...timestamps],
        imageCount: timestamps.length,
        images: timestamps.map(frame),
      },
    ],
  });
  return {
    extractSegments: vi.fn(async (input: unknown) => {
      const { onVisionInput } = input as {
        onVisionInput?: (snapshot: unknown) => void;
      };
      onVisionInput?.(snapshotFor("video-1", [0, 0.6667, 1.3333, 2, 2.6667], 3));
      onVisionInput?.(snapshotFor("video-2", [0, 0.6667], 1));
      return {
        segmentMap: {
          videos: [
            {
              videoId: "video-1",
              sourceFile: "test.mp4",
              duration: 3,
              resolution: { width: 1920, height: 1080 },
              fps: 30,
              totalFrames: 90,
              segments: [
                {
                  id: "video-1-seg-0",
                  startTime: 0,
                  endTime: 3,
                  sceneType: "b-roll",
                  motionLevel: "medium",
                  description: "sampled source footage",
                  hasDialogue: false,
                  visualContent: "test",
                  confidence: 0.8,
                },
              ],
            },
            {
              videoId: "video-2",
              sourceFile: "style-demo.mp4",
              duration: 1,
              resolution: { width: 1920, height: 1080 },
              fps: 30,
              totalFrames: 30,
              segments: [
                {
                  id: "video-2-seg-0",
                  startTime: 0,
                  endTime: 1,
                  sceneType: "b-roll",
                  motionLevel: "low",
                  description: "reference look",
                  hasDialogue: false,
                  visualContent: "test",
                  confidence: 0.8,
                },
              ],
            },
          ],
        },
        processingTimeMs: 5,
        frameCount: 7,
        segmentCount: 2,
        referenceAnalysis: {
          analysisVersion: "1.1.0" as const,
          videos: [
            {
              videoId: "video-1",
              duration: 3,
              summary: { pacing: "fast" as const, cutCount: 0, cutsPerMinute: 0, dialogueLed: false },
              styleProfile: { version: "1.0.0", confidence: 0.4 },
              timeline: [],
            },
            {
              videoId: "video-2",
              duration: 1,
              summary: { pacing: "slow" as const, cutCount: 0, cutsPerMinute: 0, dialogueLed: false },
              styleProfile: { version: "1.0.0", confidence: 0.9 },
              timeline: [],
            },
          ],
        },
      };
    }),
  };
});

function frameJobRunner(): (
  kind: string,
  params: Record<string, unknown>,
) => Promise<{ ok: boolean; data?: unknown; error?: string }> {
  return async (kind, params) => {
    if (kind !== "extractVideoFrames") return { ok: false, error: `unexpected job ${kind}` };
    const timestamps = Array.isArray(params.timestamps) ? (params.timestamps as number[]) : [];
    return {
      ok: true,
      data: {
        frames: timestamps.map((timestamp) => ({
          timestamp,
          imageDataBase64: "RkFLRQ==",
          width: 16,
          height: 16,
        })),
      },
    };
  };
}

function mediaRolesFor(...entries: ReadonlyArray<readonly [string, DirectorFrameRole, string]>): Map<string, { role: DirectorFrameRole; name?: string }> {
  return new Map(entries.map(([id, role, name]) => [id, { role, name }]));
}

// ---- selectDirectorPreviewFrames (unit) ------------------------------------

describe("selectDirectorPreviewFrames roles and caps", () => {
  it("keeps every reference frame out of the source budget and labels its role", () => {
    const frames = selectDirectorPreviewFrames(
      [
        snapshotOf("src-1", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 30),
        snapshotOf("src-2", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 30),
        snapshotOf("ref-1", [0, 1, 2], 30),
        snapshotOf("ref-2", [5, 6], 30),
      ],
      mediaRolesFor(
        ["src-1", "source", "a.mp4"],
        ["src-2", "source", "b.mp4"],
        ["ref-1", "reference", "look.mp4"],
        ["ref-2", "reference", "mood.mp4"],
      ),
    );
    const sources = frames.filter((frame) => frame.videoId.startsWith("src"));
    const references = frames.filter((frame) => frame.videoId.startsWith("ref"));
    // Budgets are span-aware (60s of source → 12 slots at ~10s spacing; the
    // reference span stays on its own smaller budget) and reference slots
    // never steal from source coverage.
    expect(sources).toHaveLength(12);
    expect(references).toHaveLength(4);
    expect(references.every((frame) => frame.role === "reference")).toBe(true);
    expect(sources.every((frame) => frame.role === "source")).toBe(true);
    // Names ride along for captions.
    expect(sources.every((frame) => frame.mediaName === "a.mp4" || frame.mediaName === "b.mp4")).toBe(true);
    expect(references.every((frame) => frame.mediaName === "look.mp4" || frame.mediaName === "mood.mp4")).toBe(true);
  });

  it("short footage never strands the budget: unused quota redistributes to videos with frames", () => {
    const frames = selectDirectorPreviewFrames(
      [snapshotOf("tiny-1", [0, 1, 2], 3), snapshotOf("long-1", Array.from({ length: 20 }, (_, i) => i), 20)],
      mediaRolesFor(["tiny-1", "source", "tiny.mp4"], ["long-1", "source", "long.mp4"]),
    );
    // Both videos get up to their fair share of the floor budget; a video
    // short on frames keeps what exists (evenly spread) and DONATES the rest
    // of its quota to the long video, so all 12 slots land on the timeline
    // instead of going to waste.
    expect(frames).toHaveLength(MIN_DIRECTOR_PREVIEW_FRAMES);
    const tiny = frames.filter((frame) => frame.videoId === "tiny-1");
    expect(tiny).toHaveLength(3); // its full 3-frame capacity, evenly spread
    expect(tiny[0]!.timestamp).toBe(0);
    expect(tiny[2]!.timestamp).toBe(2);
    const long = frames.filter((frame) => frame.videoId === "long-1");
    expect(long).toHaveLength(MIN_DIRECTOR_PREVIEW_FRAMES - 3);
    expect(new Set(long.map((frame) => frame.timestamp)).size).toBe(long.length);
  });

  it("with more sources than the budget, spreads picks across the video list and leaves nothing for the rest", () => {
    const videos = Array.from({ length: 16 }, (_, index) => `v${index}`);
    const frames = selectDirectorPreviewFrames(
      videos.map((id) => snapshotOf(id, [1])),
      mediaRolesFor(...videos.map((id): [string, DirectorFrameRole, string] => [id, "source", `${id}.mp4`])),
    );
    expect(frames).toHaveLength(MIN_DIRECTOR_PREVIEW_FRAMES);
    // The picks are spread across the video list, not front-loaded, and the
    // videos left out get NOTHING — describeDirectorPreviewFrames must name
    // them instead.
    const picked = new Set(frames.map((frame) => frame.videoId));
    expect(picked.size).toBe(MIN_DIRECTOR_PREVIEW_FRAMES);
    expect(picked.has("v0")).toBe(true);
    expect(picked.has("v15")).toBe(true);
    expect(frames.filter((frame) => !picked.has(frame.videoId)).length).toBe(0);
    expect(16 - picked.size).toBeGreaterThanOrEqual(4);
    // Exactly one frame per picked video when shares are 1.
    for (const id of picked) {
      expect(frames.filter((frame) => frame.videoId === id)).toHaveLength(1);
    }
  });

  it("budget scales with analyzed span: long footage earns more frames", () => {
    const short = selectDirectorPreviewFrames(
      [snapshotOf("v", [0, 1, 2, 3, 4], 5)],
      mediaRolesFor(["v", "source", "short.mp4"]),
    );
    // 320s span → ceiling budget of 32, fully usable against 33 sampled frames.
    const long = selectDirectorPreviewFrames(
      [snapshotOf("v", Array.from({ length: 33 }, (_, i) => i), 320)],
      mediaRolesFor(["v", "source", "long.mp4"]),
    );
    expect(short).toHaveLength(5);
    expect(long).toHaveLength(MAX_DIRECTOR_PREVIEW_FRAMES);
  });

  it("guarantees at least one frame per source when sources fit under the budget", () => {
    const videos = Array.from({ length: MIN_DIRECTOR_PREVIEW_FRAMES }, (_, index) => `v${index}`);
    const frames = selectDirectorPreviewFrames(
      // Span 120s at ~10s spacing → exactly the floor budget = video count.
      videos.map((id) => snapshotOf(id, [0, 1, 2, 3, 4], 10)),
      mediaRolesFor(...videos.map((id) => [id, "source" as const, `${id}.mp4`] as [string, DirectorFrameRole, string])),
    );
    const perVideo = new Map(frames.map((frame) => [frame.videoId, frame.timestamp]));
    expect(frames).toHaveLength(MIN_DIRECTOR_PREVIEW_FRAMES);
    expect(perVideo.size).toBe(MIN_DIRECTOR_PREVIEW_FRAMES);
    // One frame per video is its middle (index 2 of 0..4).
    for (const timestamp of perVideo.values()) expect(timestamp).toBe(2);
  });
});

function snapshotOf(videoId: string, timestamps: number[], duration = timestamps[timestamps.length - 1]! + 1): {
  videoId: string;
  duration: number;
  frameCount: number;
  batches: Array<{
    batchIndex: number;
    sourceTimestamps: number[];
    imageCount: number;
    images: Array<{ timestamp: number; imageData: string; width: number; height: number }>;
  }>;
} {
  return {
    videoId,
    duration,
    frameCount: timestamps.length,
    batches: [
      {
        batchIndex: 0,
        sourceTimestamps: [...timestamps],
        imageCount: timestamps.length,
        images: timestamps.map((timestamp) => ({ timestamp, imageData: "RkFLRQ==", width: 16, height: 16 })),
      },
    ],
  };
}

// ---- describeDirectorPreviewFrames (unit) ----------------------------------

describe("describeDirectorPreviewFrames", () => {
  it("labels reference frames as style references and captions each image with id, name, timestamp, role", () => {
    const frames: DirectorFrameImage[] = [
      { videoId: "video-1", mediaName: "test.mp4", timestamp: 0.6667, dataUrl: "x", width: 16, height: 16, role: "source" },
      { videoId: "video-2", mediaName: "style-demo.mp4", timestamp: 0.3333, dataUrl: "x", width: 16, height: 16, role: "reference" },
    ];
    const text = describeDirectorPreviewFrames(frames);
    expect(text).toContain("Frame 1: test.mp4 (id: video-1), t=0.67s — source footage");
    expect(text).toContain("Frame 2: style-demo.mp4 (id: video-2), t=0.33s — STYLE REFERENCE");
    expect(text).toContain("not footage to edit");
    expect(text).toContain("style-demo.mp4 (video-2)");
    expect(text).toContain("source-footage frame(s) and 1 style-reference frame(s)");
  });

  it("names analyzed sources that have no shown frame under the preview budget", () => {
    // Two 4-frame sources shown (span would grant 12 slots — only 8 frames exist).
    const frames: DirectorFrameImage[] = [
      ...[0, 1, 2, 3].map((timestamp) => ({
        videoId: "v0", timestamp, dataUrl: "x", width: 16, height: 16, role: "source" as const,
      })),
      ...[0, 1, 2, 3].map((timestamp) => ({
        videoId: "v1", timestamp, dataUrl: "x", width: 16, height: 16, role: "source" as const,
      })),
    ];
    const analyzed = Array.from({ length: 12 }, (_, index) => ({
      videoId: `v${index}`,
      sourceFile: `clip-${index}.mp4`,
    }));
    const text = describeDirectorPreviewFrames(frames, analyzed);
    expect(text).toContain("Preview cap: only 8 source frame(s)");
    expect(text).toContain("clip-9.mp4 (v9)");
    expect(text).toContain("clip-11.mp4 (v11)");
    // The shown videos are captioned by videoId here (no mediaName on the
    // frames), so their names must NOT surface inside the cap note.
    for (const index of [0, 1]) {
      expect(text).not.toContain(`clip-${index}.mp4 (v${index})`);
    }
  });
});

// ---- extract_segments + plan_edit integration -------------------------------

function previewTestProject(): ReturnType<typeof makeEmptyProject> {
  return {
    ...makeEmptyProject(),
    id: "director-preview",
    mediaLibrary: {
      items: [
        { id: "video-1", name: "test.mp4", type: "video", metadata: { duration: 3 } },
        { id: "video-2", name: "style-demo.mp4", type: "video", metadata: { duration: 1 }, analysisRole: "reference" },
      ],
    },
  } as unknown as ReturnType<typeof makeEmptyProject>;
}

function submitToolUse(id: string, input: unknown): LLMToolUse {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("submitToolUse requires a non-empty id");
  }
  return { id, name: "submit_edit_plan", input } as LLMToolUse;
}

function submitRankingToolUse(id: string, input: unknown): LLMToolUse {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("submitRankingToolUse requires a non-empty id");
  }
  return { id, name: "submit_moment_shortlist", input } as LLMToolUse;
}

const rankingShortlist = () => ({
  hook: { sourceVideoId: "video-1", startTime: 0, endTime: 1.5, role: "hook", why: "starts mid-action" },
  payoff: { sourceVideoId: "video-1", startTime: 1.8, endTime: 3, role: "payoff", why: "climax lands near the end" },
  landing: { sourceVideoId: "video-1", startTime: 2.6, endTime: 3, role: "landing", why: "settles for the close" },
  moments: [
    { sourceVideoId: "video-1", startTime: 0.8, endTime: 2, role: "development", why: "builds after the hook" },
  ],
});

const simplePlan = (): unknown => ({
  segments: [
    {
      sourceVideoId: "video-1",
      sourceStartTime: 0,
      sourceEndTime: 2,
      trackIndex: 0,
      targetPosition: 0,
      speed: 1,
      effects: [],
      rationale: "test",
    },
  ],
  textElements: [],
  effects: [],
  transitions: [],
  audioDecisions: [],
  metadata: { targetDuration: 2, targetPlatform: "social", genre: "highlight", pacing: "fast", rationale: "test" },
});

function scriptedLLM(
  host: HeadlessHost,
  requests: LLMTurnInput[],
  entries: Array<() => LLMResponse>,
): void {
  (host as unknown as EditingHost & { llm: unknown }).llm = {
    provider: "openai",
    client: {
      complete: async (input: LLMTurnInput) => {
        requests.push(input);
        const entry = entries[requests.length - 1];
        if (!entry) throw new Error(`Unexpected LLM call #${requests.length}`);
        return entry();
      },
    },
  };
}

/**
 * A fresh-footage turn: the frame-evidence gate (footagePlanGate) is what
 * makes plan_edit load the turn's trusted analysis — and its images.
 */
function freshFootageTurn(): { host: HeadlessHost; context: ReturnType<typeof createTurnContext> } {
  _resetPlanState("director-preview");
  return { host: new HeadlessHost(previewTestProject(), { jobRunner: frameJobRunner() }), context: createTurnContext(true) };
}

describe("extract_segments → plan_edit director preview", () => {
  it("analyzes source and reference videos but folds role-labeled frames through to plan_edit", async () => {
    const { host, context } = freshFootageTurn();

    const result = await executeTool("extract_segments", {}, host as unknown as EditingHost, context);

    expect(result.ok, result.error?.message ?? "extract ok").toBe(true);
    const data = result.data as {
      segmentMap: { videos: Array<{ videoId: string }> };
      referenceVideoIds: string[];
      frameCount: number;
    };
    // References are analyzed but are NOT source footage for planning.
    expect(data.segmentMap.videos.map((video) => video.videoId)).toEqual(["video-1"]);
    expect(data.referenceVideoIds).toEqual(["video-2"]);

    // Preview frames: both videos contribute; roles are explicit and every
    // frame carries its media's human-friendly name.
    const images = result.analysisImages as DirectorFrameImage[];
    const byVideo = new Map(images.map((image) => [image.videoId, image.role]));
    expect(byVideo.get("video-1")).toBe("source");
    expect(byVideo.get("video-2")).toBe("reference");
    expect(images.every((image) => (image.mediaName === "test.mp4") === (image.videoId === "video-1"))).toBe(true);
    expect(images.every((image) => (image.mediaName === "style-demo.mp4") === (image.videoId === "video-2"))).toBe(true);
    expect(result.summary).toContain("1 reference(s)");

    // The executor folds the role-labeled frames into the turn's analysis.
    const analysis = trustedAnalysis(context);
    expect(analysis?.images).toHaveLength(images.length);
    expect(analysis?.images.every((image) => image.role !== undefined && image.mediaName !== undefined)).toBe(true);
  });

  it("plan_edit runs a moment-ranking scouting pass, then captions every frame in the planning message", async () => {
    const { host, context } = freshFootageTurn();
    await executeTool("extract_segments", {}, host as unknown as EditingHost, context);

    const requests: LLMTurnInput[] = [];
    // Call 1 = moment ranking; call 2 = planning; call 3 = the density-review
    // revision returning the same plan (this host renders no frames, so no
    // rendered-repair call).
    scriptedLLM(host, requests, [
      () => ({ text: "", stopReason: "tool_use", toolUses: [submitRankingToolUse("shortlist-1", rankingShortlist())] } as LLMResponse),
      () => ({ text: "", stopReason: "tool_use", toolUses: [submitToolUse("plan-1", simplePlan())] } as LLMResponse),
      () => ({ text: "", stopReason: "tool_use", toolUses: [submitToolUse("plan-rev", simplePlan())] } as LLMResponse),
    ]);

    const llmHost = host as unknown as EditingHost;
    const planResult = await executeTool("plan_edit", { prompt: "make a reel" }, llmHost, context);
    expect(planResult.ok, (planResult.error?.message ?? planResult.summary)).toBe(true);

    // Pass 1 (ranking): the scouting call also sees the frames plus the
    // ranking brief that mirrors canonical ids and the footage graph.
    const rankingContent = requests[0]?.messages.find((message) => message.role === "user")?.content;
    expect(Array.isArray(rankingContent)).toBe(true);
    const rankingBlocks = rankingContent as Array<{ type: string; text?: string; base64?: string }>;
    const rankingText = rankingBlocks[0]?.text ?? "";
    expect(rankingText).toContain("Canonical sourceVideoId values");
    expect(rankingText).toContain("video_0: video-1");
    expect(rankingText).toContain("Frame 1: test.mp4 (id: video-1)");
    expect(rankingBlocks.filter((block) => block.type === "image")).toHaveLength(
      (trustedAnalysis(context)?.images ?? []).length,
    );

    // Pass 2 (planning): captions every frame AND carries the accepted
    // shortlist, so the director starts from ranked evidence.
    const userContent = requests[1]?.messages.find((message) => message.role === "user")?.content;
    expect(Array.isArray(userContent)).toBe(true);
    const blocks = userContent as Array<{ type: string; text?: string; base64?: string }>;
    expect(blocks[0]?.type).toBe("text");
    const text = blocks[0]?.text ?? "";
    expect(text).toContain("Frame 1: test.mp4 (id: video-1)");
    expect(text).toMatch(/t=\d+\.\d\ds/);
    expect(text).toMatch(/Frame \d+: style-demo\.mp4 \(id: video-2\), t=\d+\.\d\ds — STYLE REFERENCE \(style cues only — not footage to edit\)/);
    expect(text).toContain("not footage to edit");
    expect(text).toContain("source-footage frame(s) and 2 style-reference frame(s)");
    const planningSystemText = requests[1]?.system ?? "";
    expect(planningSystemText).toContain("## Moment ranking");
    expect(planningSystemText).toContain("hook: video-1 0.00s-1.50s — hook");
    expect(planningSystemText).toContain("payoff: video-1 1.80s-3.00s — payoff");
    expect(planningSystemText).toContain("## Moment zoom (dense views of your top-ranked ranges)");

    // Coarse-to-fine: below the regular preview frames, the planning message
    // carries the dense moment-zoom group — its caption plus one image per
    // zoom frame sampled INSIDE the ranked ranges.
    const zoomCaption = blocks
      .map((block) => block.text ?? "")
      .find((textCandidate) => textCandidate.includes("Moment-zoom:")) ?? "";
    expect(zoomCaption).toContain("Moment-zoom:");
    expect(zoomCaption).toContain("video-1 0.00s-1.50s");
    expect(zoomCaption).toContain("NOT additional moments");
    const allImageBlocks = blocks.filter((block) => block.type === "image");
    const previewCount = trustedAnalysis(context)?.images?.length ?? 0;
    expect(allImageBlocks.length).toBeGreaterThan(previewCount);

    // One image block per captioned preview frame first, then the zoom group.
    const imageBlocks = blocks.filter((block) => block.type === "image");
    const images = trustedAnalysis(context)?.images ?? [];
    expect(imageBlocks.slice(0, images.length).length).toBe(images.length);
    expect(imageBlocks.length - images.length).toBe(18); // 4 ranges × ≤6 zoom frames
    expect(imageBlocks.every((block) => typeof block.base64 === "string" && block.base64.length > 0)).toBe(true);
  });

  it("an unusable ranking response falls back to the single-pass director with a provenance note", async () => {
    const { host, context } = freshFootageTurn();
    await executeTool("extract_segments", {}, host as unknown as EditingHost, context);

    const requests: LLMTurnInput[] = [];
    scriptedLLM(host, requests, [
      () => ({ text: "", stopReason: "tool_use", toolUses: [submitRankingToolUse("shortlist-1", { hook: "not an object", moments: [] })] } as LLMResponse),
      () => ({ text: "", stopReason: "tool_use", toolUses: [submitToolUse("plan-1", simplePlan())] } as LLMResponse),
      () => ({ text: "", stopReason: "tool_use", toolUses: [submitToolUse("plan-rev", simplePlan())] } as LLMResponse),
    ]);

    const planResult = await executeTool("plan_edit", { prompt: "make a reel" }, host as unknown as EditingHost, context);
    expect(planResult.ok, (planResult.error?.message ?? planResult.summary)).toBe(true);

    const fallbackSystemText = requests[1]?.system ?? "";
    expect(fallbackSystemText).toContain("## Edit density contract");
    expect(fallbackSystemText).toContain("(Moment-ranking pass returned nothing usable; planning proceeded in one pass.)");
  });
});
