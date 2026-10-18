import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaItem, Project } from "@kove-advanced/core/types/project";
import { HeadlessHost } from "../headless-host";
import { executeTool } from "../executor";
import { MockLLMClient, type LLMClient, type LLMResponse } from "../llm";
import type { EditingHost, TextOverlayOptions, OverlayRef } from "../host";
import {
  baselineFrameTimestamps,
  captureAdaptiveFrames,
  MAX_BURST_FRAMES_PER_VIDEO,
  setAnalysisMode,
} from "../registry";
import { computeAdaptiveTimestamps, DEFAULT_SAMPLE_CONFIG } from "@kove-advanced/frame-worker";
import { mediaFingerprint, setPerceptionEntries } from "./perception-cache";

// ---------------------------------------------------------------------------
// Fake host: every extractVideoFrame call is recorded; each frame is a tiny
// fixed payload (never decoded in these tests — cut detection is injected).
// ---------------------------------------------------------------------------

interface JobLog {
  timestamps: number[];
}

function makeFrameHost(project: Project, log: JobLog): HeadlessHost {
  return new HeadlessHost(project as unknown as Project, {
    jobRunner: async (kind: string, params: Record<string, unknown>) => {
      if (kind !== "extractVideoFrame") {
        return { ok: false, error: `unexpected job kind ${kind}` };
      }
      const timeSeconds = params.timeSeconds as number;
      log.timestamps.push(timeSeconds);
      return {
        ok: true,
        data: { imageDataBase64: "aGVsbG8=", width: 32, height: 18 },
      };
    },
  });
}

function makeProject(): Project {
  return {
    id: "seg-project",
    name: "Segments",
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
          sourceFile: { name: "footage.mp4", size: 1000, lastModified: 1_700_000_000_000 },
        },
      ],
    },
  } as unknown as Project;
}

// ---------------------------------------------------------------------------
// Two-pass capture (unit level — deterministic injected cut detector)
// ---------------------------------------------------------------------------

describe("captureAdaptiveFrames — two-pass sampling", () => {
  it("pass 1 captures the baseline grid; pass 2 captures ONLY burst frames around detected cuts", async () => {
    const log: JobLog = { timestamps: [] };
    const host = makeFrameHost(makeProject(), log);
    const duration = 10;
    const detector = async () => [{ timestamp: 2.0, score: 0.9 }] as const;

    const result = await captureAdaptiveFrames(host, "video-1", duration, DEFAULT_SAMPLE_CONFIG, detector);

    const baseline = baselineFrameTimestamps(duration);
    expect(result.pass1Frames).toBe(baseline.length);
    expect(result.boundaryCount).toBe(1);
    expect(result.cutDetectionUnavailable).toBe(false);
    expect(result.burstCapped).toBe(false);

    // The expected second-pass set: adaptive targets not already covered.
    const targets = computeAdaptiveTimestamps(duration, [{ timestamp: 2.0, score: 0.9 }], DEFAULT_SAMPLE_CONFIG);
    const expectedBurst = targets.filter(
      (t) => !baseline.some((b) => Math.abs(b - t) < 0.05),
    );
    expect(result.pass2Frames).toBe(expectedBurst.length);
    expect(expectedBurst.length).toBeGreaterThan(0);

    // Everything captured = baseline ∪ expected burst, sorted, no duplicates.
    expect(result.frames.length).toBe(baseline.length + expectedBurst.length);
    for (let i = 1; i < result.frames.length; i += 1) {
      expect(result.frames[i]!.timestamp).toBeGreaterThan(result.frames[i - 1]!.timestamp);
    }
    // Burst frames live in the ±2s window around the cut — nothing elsewhere.
    const burst = result.frames.filter((f) => !baseline.some((b) => Math.abs(b - f.timestamp) < 0.05));
    for (const f of burst) {
      expect(f.timestamp).toBeGreaterThanOrEqual(0);
      expect(f.timestamp).toBeLessThanOrEqual(4.001);
    }

    // The job log must match the frame list exactly (no stray captures).
    expect(log.timestamps.length).toBe(result.frames.length);
  });

  it("with no cuts, pass 2 captures nothing (baseline only, zero extra cost)", async () => {
    const log: JobLog = { timestamps: [] };
    const host = makeFrameHost(makeProject(), log);
    const detector = async () => [] as const;
    const result = await captureAdaptiveFrames(host, "video-1", 10, DEFAULT_SAMPLE_CONFIG, detector);
    expect(result.pass2Frames).toBe(0);
    expect(result.boundaryCount).toBe(0);
    expect(result.frames.length).toBe(baselineFrameTimestamps(10).length);
  });

  it("a failing detector degrades to baseline-only instead of failing the capture", async () => {
    const log: JobLog = { timestamps: [] };
    const host = makeFrameHost(makeProject(), log);
    const detector = async () => {
      throw new Error("createImageBitmap is not available (headless host)");
    };
    const result = await captureAdaptiveFrames(host, "video-1", 10, DEFAULT_SAMPLE_CONFIG, detector);
    expect(result.cutDetectionUnavailable).toBe(true);
    expect(result.pass2Frames).toBe(0);
    expect(result.frames.length).toBe(baselineFrameTimestamps(10).length);
  });

  it("caps the burst budget, keeping the frames closest to a cut", async () => {
    const log: JobLog = { timestamps: [] };
    const project = makeProject();
    (project.mediaLibrary.items[0] as { metadata: { duration: number } }).metadata.duration = 60;
    const host = makeFrameHost(project, log);
    // A cut every 2s for 60s → far more burst frames than the budget allows.
    const boundaries = Array.from({ length: 30 }, (_, i) => ({ timestamp: (i + 1) * 2, score: 0.9 }));
    const detector = async () => boundaries;

    const result = await captureAdaptiveFrames(host, "video-1", 60, DEFAULT_SAMPLE_CONFIG, detector);
    expect(result.burstCapped).toBe(true);
    expect(result.pass2Frames).toBe(MAX_BURST_FRAMES_PER_VIDEO);
    expect(result.frames.length).toBe(baselineFrameTimestamps(60).length + MAX_BURST_FRAMES_PER_VIDEO);
  });
});

// ---------------------------------------------------------------------------
// extract_segments tool: perception cache + two-pass report (fetch-stubbed
// vision worker; the registry defaults to eco mode → localhost worker URL)
// ---------------------------------------------------------------------------

interface VisionCall {
  videoId: string;
  frameCount: number;
}

function stubVisionWorker(): { calls: VisionCall[]; impl: (input: unknown, init?: unknown) => Promise<Response> } {
  const calls: VisionCall[] = [];
  const impl = async (input: unknown, init?: unknown): Promise<Response> => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? "");
    if (!url.includes("/analyze-frames")) {
      return new Response("not found", { status: 404 });
    }
    const body = JSON.parse((init as { body: string }).body) as {
      videoId: string;
      frames: Array<{ batchIndex: number; frames: Array<{ timestamp: number }> }>;
    };
    calls.push({
      videoId: body.videoId,
      frameCount: body.frames.reduce((n, b) => n + b.frames.length, 0),
    });
    const payload = {
      batches: body.frames.map((batch) => ({
        batchIndex: batch.batchIndex,
        descriptions: batch.frames.map((frame) => ({
          timestamp: frame.timestamp,
          description: `frame at ${frame.timestamp.toFixed(2)}`,
          sceneType: "b-roll",
          motionLevel: "medium",
          hasDialogue: false,
          confidence: 0.9,
        })),
      })),
    };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, impl };
}

describe("extract_segments — perception cache", () => {
  let vision: { calls: VisionCall[]; impl: (input: unknown, init?: unknown) => Promise<Response> };
  let jobLog: JobLog;

  beforeEach(() => {
    setAnalysisMode("eco");
    vision = stubVisionWorker();
    jobLog = { timestamps: [] };
    vi.stubGlobal("fetch", vision.impl);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("first run analyzes, stores perception on the project; repeat run is a zero-cost cache hit; forceRefresh re-analyzes", async () => {
    const project = makeProject();
    const host = makeFrameHost(project, jobLog);

    const first = await executeTool("extract_segments", {}, host);
    expect(first.ok).toBe(true);
    const firstData = first.data as Record<string, unknown>;
    expect(firstData.cached).toBeUndefined();
    expect(first.summary).toMatch(/baseline \+ \d+ burst frame\(s\) around \d+ cut\(s\)/);
    expect(vision.calls).toHaveLength(1);
    const firstJobCount = jobLog.timestamps.length;
    expect(firstJobCount).toBeGreaterThan(0);

    // Perception is now on the project, fingerprint-validated.
    const media = project.mediaLibrary.items[0];
    expect(project.perceptionCache?.entries[media.id]?.fingerprint).toBe(mediaFingerprint(media));

    // Repeat: same media, no changes → cache hit, no new frames, no new vision.
    const second = await executeTool("extract_segments", {}, host);
    expect(second.ok).toBe(true);
    const secondData = second.data as Record<string, unknown>;
    expect(secondData.cached).toBe(true);
    expect(second.summary).toContain("perception cache hit");
    expect(vision.calls).toHaveLength(1);
    expect(jobLog.timestamps.length).toBe(firstJobCount);

    // The cached segment map still carries real perception.
    const segMap = secondData.segmentMap as { videos: Array<{ segments: unknown[] }> };
    expect(segMap.videos[0]!.segments.length).toBeGreaterThan(0);

    // forceRefresh re-runs the analysis even though the cache is fresh.
    const third = await executeTool("extract_segments", { forceRefresh: true }, host);
    expect(third.ok).toBe(true);
    expect((third.data as Record<string, unknown>).cached).toBeUndefined();
    expect(vision.calls).toHaveLength(2);
    expect(jobLog.timestamps.length).toBeGreaterThan(firstJobCount);
  });

  it("a re-imported file (new size/mtime) invalidates the cache and re-analyzes", async () => {
    const project = makeProject();
    const host = makeFrameHost(project, jobLog);

    const first = await executeTool("extract_segments", {}, host);
    expect(first.ok).toBe(true);
    expect(vision.calls).toHaveLength(1);

    const media = project.mediaLibrary.items[0] as MediaItem & { sourceFile: { size: number; lastModified: number } };
    media.sourceFile.size = 9999;
    media.sourceFile.lastModified = 1_900_000_000_000;

    const second = await executeTool("extract_segments", {}, host);
    expect(second.ok).toBe(true);
    expect((second.data as Record<string, unknown>).cached).toBeUndefined();
    expect(vision.calls).toHaveLength(2);
    expect(project.perceptionCache?.entries[media.id]?.fingerprint).toBe(mediaFingerprint(media));
  });
});

// ---------------------------------------------------------------------------
// plan_edit: resolves perception from the cache instead of the metadata-only
// fallback when the LLM did not pass a segmentMap.
// ---------------------------------------------------------------------------

type HarnessHost = HeadlessHost &
  { llm: NonNullable<EditingHost["llm"]> } &
  Pick<EditingHost, "createTextOverlay" | "removeOverlay">;

const END: LLMResponse = { text: "Done.", stopReason: "end_turn", toolUses: [] };

class CountingLLM implements LLMClient {
  calls = 0;
  readonly systems: string[] = [];
  private readonly inner: MockLLMClient;
  constructor(script: LLMResponse[]) {
    this.inner = new MockLLMClient([...script, END]);
  }
  async complete(input: { system?: string }): Promise<LLMResponse> {
    this.calls += 1;
    if (input.system) this.systems.push(input.system);
    return this.inner.complete();
  }
}

function planResponse(input: Record<string, unknown>): LLMResponse {
  return {
    text: "",
    stopReason: "tool_use",
    toolUses: [{ id: `plan-${Math.random().toString(36).slice(2)}`, name: "submit_edit_plan", input }],
  };
}

function validPlan(): Record<string, unknown> {
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
      rationale: "perception-cache fixture",
    },
  };
}

describe("plan_edit — perception cache resolution", () => {
  beforeEach(() => {
    setAnalysisMode("eco");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses cached perception (not the metadata-only fallback) when no segmentMap is passed", async () => {
    const project = makeProject();
    const media = project.mediaLibrary.items[0];
    setPerceptionEntries(project, [
      {
        media,
        entry: {
          fingerprint: mediaFingerprint(media),
          capturedAtMs: 1,
          frameCount: 15,
          twoPass: true,
          videoMap: {
            videoId: media.id,
            duration: 10,
            segments: [
              {
                id: "video-1-seg-0",
                startTime: 0,
                endTime: 10,
                description: "cached perception description",
                sceneType: "b-roll",
                motionLevel: "medium",
                hasDialogue: false,
                visualContent: "x",
                confidence: 0.9,
              },
            ],
          },
        },
      },
    ]);

    const host = new HeadlessHost(project as unknown as Project) as HarnessHost;
    host.createTextOverlay = async (_options: TextOverlayOptions): Promise<OverlayRef> => ({
      id: "text-1",
      trackId: "text-track",
    });
    host.removeOverlay = async (): Promise<boolean> => true;
    const llm = new CountingLLM([planResponse(validPlan())]);
    host.llm = { client: llm, provider: "openai" };

    const result = await executeTool("plan_edit", { prompt: "make a 10 second edit" }, host);
    expect(result.ok).toBe(true);

    const directorPrompt = llm.systems[0] ?? "";
    expect(directorPrompt).toContain("cached perception description");
    // The metadata-only fallback would describe the footage as "footage.mp4 — 10.0s".
    expect(directorPrompt).not.toContain("footage.mp4 — 10.0s");
    expect(llm.calls).toBeGreaterThan(0);
  });
});
