import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@kove-advanced/core/types/project";
import { HeadlessHost } from "./headless-host";
import type { EditingHost } from "./host";
import { executeTool } from "./executor";
import { getDirectorPlanState } from "./director/plan-state";
import { __getReferenceAnalysisForTest, __setReferenceAnalysisForTest } from "./registry";
import type { EngineReferenceReport } from "./replication/mirror";

/**
 * Registry-level behaviour of the reference-clone tools: the version gate,
 * the stash as the only mirror input, and the shared commit tail.
 */

function makeProject(): Project {
  return {
    id: "mirror-project",
    name: "Mirror",
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
          blob: null,
          fileHandle: null,
          metadata: { duration: 30 },
        },
        {
          id: "ref-1",
          name: "reference.mp4",
          type: "video",
          analysisRole: "reference",
          blob: new Blob(["reference-bytes"]),
          fileHandle: null,
          metadata: { duration: 6 },
        },
      ],
    },
  } as unknown as Project;
}

/** Three two-second shots in a 6s reference. */
function report(
  overrides: Partial<EngineReferenceReport> = {},
  extraCuts: ReadonlyArray<{ time: number; confidence: number }> = [],
): EngineReferenceReport {
  return {
    analysisVersion: "1.2.0",
    videoId: "ref-1",
    role: "reference",
    duration: 6,
    summary: { pacing: "moderate", cutCount: 2, cutsPerMinute: 20 },
    styleProfile: { pacing: "moderate", cutsPerMinute: 20, medianShotDuration: 2 },
    editPattern: {
      cutStyle: "coverage-led",
      cutEvidence: [
        { time: 0, confidence: 0.9 },
        { time: 2, confidence: 0.9 },
        { time: 4, confidence: 0.9 },
        ...extraCuts,
      ],
      transitions: [{ type: "hard-cut", startTime: 2, confidence: 0.82 }],
      effects: [],
    },
    ...overrides,
  };
}

afterEach(() => {
  __setReferenceAnalysisForTest(null);
  vi.unstubAllGlobals();
});

describe("build_mirror_plan", () => {
  it("refuses a 1.1.0-class report (numeric version gate)", () => {
    __setReferenceAnalysisForTest(report({ analysisVersion: "1.1.0" }));
    const host = new HeadlessHost(makeProject());

    const result = executeTool("build_mirror_plan", {}, host);

    return result.then((toolResult) => {
      expect(toolResult.ok).toBe(false);
      expect(toolResult.error?.code).toBe("REFERENCE_VERSION_TOO_OLD");
    });
  });

  it("accepts a newer minor version that a string compare would reject", () => {
    __setReferenceAnalysisForTest(report({ analysisVersion: "1.10.0" }));
    const host = new HeadlessHost(makeProject());

    return executeTool("build_mirror_plan", {}, host).then((toolResult) => {
      expect(toolResult.ok).toBe(true);
    });
  });

  it("refuses to mirror without a stashed engine analysis", () => {
    const host = new HeadlessHost(makeProject());

    return executeTool("build_mirror_plan", {}, host).then((toolResult) => {
      expect(toolResult.ok).toBe(false);
      expect(toolResult.error?.code).toBe("NO_REFERENCE_ANALYSIS");
    });
  });

  it("compiles one segment per reference shot when apply is false", async () => {
    __setReferenceAnalysisForTest(report());
    const host = new HeadlessHost(makeProject());

    const result = await executeTool("build_mirror_plan", {}, host);

    expect(result.ok).toBe(true);
    const data = result.data as {
      editPlan: { segments: Array<{ sourceStartTime: number; sourceEndTime: number }> };
      structuralDiff: { cutCountMatch: boolean; maxShotDriftSec: number };
      applied: boolean;
    };
    expect(data.applied).toBe(false);
    expect(data.editPlan.segments).toHaveLength(3);
    expect(data.structuralDiff.cutCountMatch).toBe(true);
    expect(data.structuralDiff.maxShotDriftSec).toBeLessThanOrEqual(1 / 30);
    // Nothing touched the timeline.
    expect(getDirectorPlanState(host.getProject()).revision).toBe(0);
  });

  it("reports a count mismatch when a shot had to be dropped", async () => {
    __setReferenceAnalysisForTest(report({}, [{ time: 6, confidence: 0.9 }]));
    const host = new HeadlessHost(makeProject());

    const result = await executeTool("build_mirror_plan", {}, host);

    const data = result.data as { structuralDiff: { cutCountMatch: boolean } };
    expect(data.structuralDiff.cutCountMatch).toBe(false);
  });

  it("commits exactly one revision on apply and is idempotent on re-run", async () => {
    __setReferenceAnalysisForTest(report());
    const host = new HeadlessHost(makeProject());
    const project = host.getProject();

    const first = await executeTool("build_mirror_plan", { apply: true }, host);
    expect(first.ok).toBe(true);
    const firstData = first.data as { applied: boolean; revision: number };
    expect(firstData.applied).toBe(true);
    expect(firstData.revision).toBe(1);
    expect(getDirectorPlanState(project).revision).toBe(1);
    const clipCount = project.timeline.tracks.reduce(
      (sum, track) => sum + track.clips.length,
      0,
    );
    expect(clipCount).toBe(3);

    // Same reference, policy and sources → same idempotency key → no-op.
    const second = await executeTool("build_mirror_plan", { apply: true }, host);
    expect(second.ok).toBe(true);
    const secondData = second.data as {
      applied: boolean;
      revision: number;
      idempotentReplay?: boolean;
    };
    expect(secondData.applied).toBe(false);
    expect(secondData.idempotentReplay).toBe(true);
    expect(getDirectorPlanState(project).revision).toBe(1);
    expect(project.timeline.tracks.reduce((sum, track) => sum + track.clips.length, 0)).toBe(
      clipCount,
    );
  });

  it("mirrors onto an explicit source list", async () => {
    __setReferenceAnalysisForTest(report());
    const host = new HeadlessHost(makeProject());

    const result = await executeTool(
      "build_mirror_plan",
      { sourceVideoIds: ["video-1"], fitPolicy: "scale" },
      host,
    );

    const data = result.data as {
      fitPolicy: string;
      editPlan: { segments: Array<{ sourceVideoId: string }> };
    };
    expect(data.fitPolicy).toBe("scale");
    expect(data.editPlan.segments.every((segment) => segment.sourceVideoId === "video-1")).toBe(true);
  });

  it("build_mirror_plan never invokes host.llm", async () => {
    const llmSpy = vi.fn(() => {
      throw new Error(
        "build_mirror_plan must not call the LLM — it is a deterministic compile+commit path",
      );
    });
    // A host that *has* an LLM: if the mirror ever routed through plan_edit's
    // director, this spy would be called and throw.
    const host = new HeadlessHost(makeProject()) as HeadlessHost & {
      llm: NonNullable<EditingHost["llm"]>;
    };
    host.llm = { client: { complete: llmSpy } as never, provider: "anthropic" };

    // Seed the stash exactly as analyze_reference_media would.
    const engineReport = report();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/analyze-upload")) {
          return new Response(JSON.stringify({ jobId: "job-1", status: "pending" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            status: "completed",
            result: {
              referenceAnalysis: { analysisVersion: "1.2.0", videos: [engineReport] },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const analyzed = await executeTool("analyze_reference_media", {}, host);
    expect(analyzed.ok).toBe(true);

    const planned = await executeTool("build_mirror_plan", {}, host);
    const applied = await executeTool("build_mirror_plan", { apply: true }, host);

    expect(planned.ok).toBe(true);
    expect(applied.ok).toBe(true);
    expect(llmSpy).not.toHaveBeenCalled();
  });

  it("rejects an unknown fitPolicy", async () => {
    __setReferenceAnalysisForTest(report());
    const host = new HeadlessHost(makeProject());

    const result = await executeTool("build_mirror_plan", { fitPolicy: "stretch" }, host);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_PARAMS");
  });
});

describe("analyze_reference_media", () => {
  it("uploads the reference, stashes the report and returns a trimmed envelope", async () => {
    const engineReport = report();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/analyze-upload")) {
          return new Response(JSON.stringify({ jobId: "job-1", status: "pending" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            status: "completed",
            result: {
              segmentMap: { videos: [] },
              referenceAnalysis: { analysisVersion: "1.2.0", videos: [engineReport] },
              processingTimeMs: 12,
              frameCount: 3,
              segmentCount: 1,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const host = new HeadlessHost(makeProject());
    const result = await executeTool("analyze_reference_media", {}, host);

    expect(result.ok).toBe(true);
    expect(calls[0]).toContain("/analyze-upload");

    const data = result.data as Record<string, unknown>;
    expect(data.videoId).toBe("ref-1");
    expect(data.role).toBe("reference");
    expect(data.analysisVersion).toBe("1.2.0");
    // Trimmed: no observations, no per-frame timestamps, no timings.
    expect(data.observations).toBeUndefined();
    expect(data.processingTimeMs).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain("cutEvidence");

    // The stash — not the envelope — is what the mirror consumes.
    expect(__getReferenceAnalysisForTest()?.editPattern?.cutEvidence).toHaveLength(3);
  });

  it("fails clearly when the engine is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> => {
        throw new Error("fetch failed");
      }),
    );
    const host = new HeadlessHost(makeProject());

    const result = await executeTool("analyze_reference_media", {}, host);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("REFERENCE_ANALYSIS_FAILED");
    expect(result.summary).toContain("python engine");
  });

  it("fails when no media is marked as a reference", async () => {
    const project = makeProject();
    (project.mediaLibrary.items[1] as { analysisRole?: string }).analysisRole = undefined;
    const host = new HeadlessHost(project);

    const result = await executeTool("analyze_reference_media", {}, host);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NO_REFERENCE_MEDIA");
  });
});
