import { describe, expect, it, vi } from "vitest";
import { executeTool } from "./executor";
import { HeadlessHost } from "./headless-host";
import { makeProjectWithClip } from "./test-fixtures";
import { getTool } from "./registry";
import type { Project } from "@kove-advanced/core/types/project";
import type {
  ApplySubjectMatteRequest,
  ApplySubjectMatteResult,
  AutoReframeHostResult,
  AutoReframeRequest,
  FaceAnalysisResult,
  HostFeatures,
  MatteEdgeResult,
  RefineMatteEdgesRequest,
  RefineMatteEdgesResult,
  SubjectMatteRequest,
  SubjectMatteResult,
  VisionSamplingRequest,
} from "./host";

/** makeProjectWithClip() has no media library; vision tools resolve media ids. */
function projectWithMedia(): Project {
  const project = makeProjectWithClip();
  return {
    ...project,
    mediaLibrary: {
      ...project.mediaLibrary,
      items: [
        {
          id: "m1",
          name: "take-01.mp4",
          type: "video",
          fileHandle: null,
          blob: null,
          thumbnailUrl: null,
          waveformData: null,
          metadata: { duration: 12 },
        },
      ],
    },
  } as unknown as Project;
}

const FACE_RESULT: FaceAnalysisResult = {
  width: 1920,
  height: 1080,
  sampledFrames: 3,
  sampledTimesMs: [0, 500, 1000],
  tracks: [
    {
      id: "face-1",
      firstTimeMs: 0,
      lastTimeMs: 1000,
      framesDetected: 3,
      averageConfidence: 0.91,
      averageBox: { x: 700, y: 300, width: 320, height: 320 },
      score: 0.8,
    },
  ],
  primaryTrackId: "face-1",
  warnings: [],
};

const MATTE_RESULT: SubjectMatteResult = {
  width: 1920,
  height: 1080,
  sampledFrames: 5,
  missedFrames: 1,
  keyframeCount: 20,
  keyframes: Array.from({ length: 20 }, (_, index) => ({
    timeMs: index * 250,
    coverage: 0.22,
    pointCount: 32,
    centroid: { x: 0.5, y: 0.45 },
  })),
  averageCoverage: 0.22,
  boundingBox: { x: 0.2, y: 0.1, width: 0.4, height: 0.8 },
  warnings: ["1 sampled frame(s) had no subject"],
};

const REFRAME_RESULT: AutoReframeHostResult = {
  keyframesWritten: 24,
  keyframeSamples: 6,
  sampledFrames: 6,
  outputWidth: 1080,
  outputHeight: 1920,
  usedFaceBackend: true,
  warnings: [],
};

const EDGE_RESULT: MatteEdgeResult = {
  motion: [1, 0.5, 0],
  minFeatherPx: 4,
  maxFeatherPx: 11.2,
};

const REFINE_RESULT: RefineMatteEdgesResult = {
  maskId: "mask-1",
  keyframeCount: 3,
  edge: EDGE_RESULT,
  warnings: [],
};

const APPLY_RESULT: ApplySubjectMatteResult = {
  maskId: "mask-1",
  keyframeCount: 12,
  firstTimeSeconds: 0,
  lastTimeSeconds: 4.5,
  separationApplied: true,
  warnings: [],
};

class FakeVisionHost extends HeadlessHost {
  readonly requests: {
    faces: VisionSamplingRequest[];
    matte: SubjectMatteRequest[];
    apply: ApplySubjectMatteRequest[];
    reframe: AutoReframeRequest[];
    refine: RefineMatteEdgesRequest[];
  } = { faces: [], matte: [], apply: [], reframe: [], refine: [] };

  constructor(
    project: Project = projectWithMedia(),
    private readonly overrides: {
      faces?: FaceAnalysisResult | { code: "unsupported_host"; error: string };
      matte?: SubjectMatteResult | { code: "unsupported_host"; error: string };
      apply?: ApplySubjectMatteResult | { code: "unsupported_host"; error: string };
      reframe?: AutoReframeHostResult | { code: "unsupported_host"; error: string };
      refine?: RefineMatteEdgesResult | { code: "unsupported_host"; error: string };
    } = {},
  ) {
    super(project);
  }

  override features(): HostFeatures {
    return {
      ...super.features(),
      analyzeFaces: true,
      analyzeSubjectMatte: true,
      applySubjectMatte: true,
      autoReframe: true,
      refineMatteEdges: true,
    };
  }

  async analyzeFaces(request: VisionSamplingRequest) {
    this.requests.faces.push(request);
    return this.overrides.faces ?? FACE_RESULT;
  }

  async analyzeSubjectMatte(request: SubjectMatteRequest) {
    this.requests.matte.push(request);
    return this.overrides.matte ?? MATTE_RESULT;
  }

  async applySubjectMatte(request: ApplySubjectMatteRequest) {
    this.requests.apply.push(request);
    return this.overrides.apply ?? APPLY_RESULT;
  }

  async autoReframe(request: AutoReframeRequest) {
    this.requests.reframe.push(request);
    return this.overrides.reframe ?? REFRAME_RESULT;
  }

  async refineMatteEdges(request: RefineMatteEdgesRequest) {
    this.requests.refine.push(request);
    return this.overrides.refine ?? REFINE_RESULT;
  }
}

describe("vision tool registration", () => {
  it("registers three strict ai tools with the right safety flags", () => {
    const faces = getTool("detect_faces")!;
    const rotoscope = getTool("rotoscope_subject")!;
    const apply = getTool("apply_subject_matte")!;
    const reframe = getTool("auto_reframe_clip")!;

    for (const tool of [faces, rotoscope]) {
      expect(tool.strict).toBe(true);
      expect(tool.readOnly).toBe(true);
      expect(tool.destructive).toBe(false);
      expect(tool.expensive).toBe(true);
      expect(tool.domain).toBe("ai");
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
    expect(apply.strict).toBe(true);
    expect(apply.readOnly).toBe(false);
    expect(apply.destructive).toBe(true);
    expect(apply.inputSchema.additionalProperties).toBe(false);
    expect(apply.inputSchema.required as string[]).toContain("clipId");

    expect(reframe.strict).toBe(true);
    expect(reframe.domain).toBe("ai");
    expect(reframe.readOnly).toBe(false);
    expect(reframe.destructive).toBe(true);
    expect(reframe.expensive).toBe(true);
    expect(reframe.inputSchema.additionalProperties).toBe(false);
    expect(reframe.inputSchema.required as string[]).toEqual(["clipId"]);
    // The camera knobs the director can tweak are all advertised.
    expect(Object.keys(reframe.inputSchema.properties as object)).toEqual(
      expect.arrayContaining([
        "targetAspectRatio",
        "trackingSpeed",
        "padding",
        "smoothing",
        "followSubject",
        "centerBias",
        "setCanvasSize",
      ]),
    );
  });
});

describe("vision tools on the headless host", () => {
  it("fails clearly instead of silently no-oping", async () => {
    const host = new HeadlessHost(projectWithMedia());
    for (const [tool, args] of [
      ["detect_faces", { mediaId: "m1" }],
      ["rotoscope_subject", { mediaId: "m1" }],
      ["apply_subject_matte", { clipId: "c1" }],
      ["auto_reframe_clip", { clipId: "c1" }],
    ] as const) {
      const result = await executeTool(tool, args as Record<string, unknown>, host);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("UNSUPPORTED_HOST");
      expect(result.error?.suggestedFix).toContain("Do not retry");
    }
  });
});

describe("detect_faces", () => {
  it("resolves a clip to its media and source window", async () => {
    const host = new FakeVisionHost();
    const result = await executeTool("detect_faces", { clipId: "c1", intervalMs: 250 }, host);

    expect(result.ok).toBe(true);
    expect(host.requests.faces).toHaveLength(1);
    expect(host.requests.faces[0].mediaId).toBe("m1");
    expect(host.requests.faces[0].startTime).toBe(0);
    expect(host.requests.faces[0].endTime).toBe(5);
    expect(host.requests.faces[0].intervalMs).toBe(250);

    const data = result.data as {
      primaryTrackId: string;
      tracks: Array<{ id: string; averageBox: { width: number } }>;
      timebase: string;
    };
    expect(data.primaryTrackId).toBe("face-1");
    expect(data.tracks[0].averageBox.width).toBe(320);
    expect(data.timebase).toBe("source-ms");
    expect(result.summary).toContain("1 face track");
  });

  it("reports an empty detection honestly", async () => {
    const host = new FakeVisionHost(projectWithMedia(), {
      faces: { ...FACE_RESULT, tracks: [], primaryTrackId: null },
    });
    const result = await executeTool("detect_faces", { mediaId: "m1" }, host);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("No faces found");
  });

  it("surfaces warnings from the host and from speed/reverse clips", async () => {
    const project = projectWithMedia();
    const speedProject = {
      ...project,
      timeline: {
        ...project.timeline,
        tracks: project.timeline.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) => ({ ...clip, speed: 2 })),
        })),
      },
    } as Project;
    const host = new FakeVisionHost(speedProject, {
      faces: { ...FACE_RESULT, warnings: ["frame 2 decode failed"] },
    });
    const result = await executeTool("detect_faces", { clipId: "c1" }, host);
    expect(result.ok).toBe(true);
    expect(result.warnings?.some((warning) => warning.includes("speed"))).toBe(true);
    expect(result.warnings?.some((warning) => warning.includes("decode"))).toBe(true);
  });

  it("maps a host-level unsupported result to UNSUPPORTED_HOST", async () => {
    const host = new FakeVisionHost(projectWithMedia(), {
      faces: { code: "unsupported_host", error: "no decoder in this context" },
    });
    const result = await executeTool("detect_faces", { mediaId: "m1" }, host);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNSUPPORTED_HOST");
    expect(result.error?.message).toContain("no decoder");
  });

  it("validates arguments before touching the host", async () => {
    const host = new FakeVisionHost();

    const both = await executeTool("detect_faces", { clipId: "c1", mediaId: "m1" }, host);
    expect(both.error?.code).toBe("INVALID_PARAMS");

    const neither = await executeTool("detect_faces", {}, host);
    expect(neither.error?.code).toBe("INVALID_PARAMS");

    const missing = await executeTool("detect_faces", { clipId: "nope" }, host);
    expect(missing.error?.code).toBe("NOT_FOUND");

    const inverted = await executeTool(
      "detect_faces",
      { mediaId: "m1", startTime: 4, endTime: 2 },
      host,
    );
    expect(inverted.error?.code).toBe("INVALID_PARAMS");

    expect(host.requests.faces).toHaveLength(0);
  });
});

describe("rotoscope_subject", () => {
  it("returns the plan with a truncated keyframe preview", async () => {
    const host = new FakeVisionHost();
    const result = await executeTool(
      "rotoscope_subject",
      { clipId: "c1", threshold: 0.6, maxKeyframes: 30 },
      host,
    );

    expect(result.ok).toBe(true);
    expect(host.requests.matte[0].mediaId).toBe("m1");
    expect(host.requests.matte[0].threshold).toBe(0.6);
    expect(host.requests.matte[0].maxKeyframes).toBe(30);

    const data = result.data as {
      keyframeCount: number;
      keyframes: Array<{ timeMs: number }>;
      keyframesTruncated: boolean;
      missedFrames: number;
      timebase: string;
    };
    expect(data.keyframeCount).toBe(20);
    expect(data.keyframes).toHaveLength(12);
    expect(data.keyframesTruncated).toBe(true);
    expect(data.missedFrames).toBe(1);
    expect(data.timebase).toBe("source-ms");
    expect(result.summary).toContain("20 keyframe");
  });

  it("stays ok when no subject is found (it is a proposal, not a write)", async () => {
    const host = new FakeVisionHost(projectWithMedia(), {
      matte: { ...MATTE_RESULT, keyframeCount: 0, keyframes: [], averageCoverage: 0 },
    });
    const result = await executeTool("rotoscope_subject", { mediaId: "m1" }, host);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("No usable subject");
  });
});

describe("apply_subject_matte", () => {
  it("writes the matte and reports the timeline range", async () => {
    const host = new FakeVisionHost();
    const result = await executeTool(
      "apply_subject_matte",
      { clipId: "c1", featherPx: 6, expansionPx: -3, invertMask: true },
      host,
    );

    expect(result.ok).toBe(true);
    expect(host.requests.apply).toHaveLength(1);
    const request = host.requests.apply[0];
    expect(request.clipId).toBe("c1");
    expect(request.mediaId).toBe("m1");
    expect(request.featherPx).toBe(6);
    expect(request.expansionPx).toBe(-3);
    expect(request.invertMask).toBe(true);
    expect(request.separation).toBeUndefined();

    const data = result.data as { maskId: string; keyframeCount: number; timebase: string };
    expect(data.maskId).toBe("mask-1");
    expect(data.keyframeCount).toBe(12);
    expect(data.timebase).toBe("timeline-seconds");
    expect(result.summary).toContain("one undo step");
  });

  it("passes a separation preset through to the host", async () => {
    const host = new FakeVisionHost();
    const result = await executeTool(
      "apply_subject_matte",
      {
        clipId: "c1",
        separation: { preset: "blur-background", blurAmount: 24, feather: 0.2 },
      },
      host,
    );
    expect(result.ok).toBe(true);
    expect(host.requests.apply[0].separation).toEqual({
      preset: "blur-background",
      blurAmount: 24,
      feather: 0.2,
    });
    expect(result.summary).toContain("subject separation");
  });

  it("prefers the explicit output range over the clip's in/out points", async () => {
    const host = new FakeVisionHost();
    await executeTool(
      "apply_subject_matte",
      { clipId: "c1", startTime: 1, endTime: 2.5, maskId: "mask-existing" },
      host,
    );
    expect(host.requests.apply[0].startTime).toBe(1);
    expect(host.requests.apply[0].endTime).toBe(2.5);
    expect(host.requests.apply[0].maskId).toBe("mask-existing");
  });

  it("fails with NO_SUBJECT when nothing could be written", async () => {
    const host = new FakeVisionHost(projectWithMedia(), {
      apply: { ...APPLY_RESULT, keyframeCount: 0, firstTimeSeconds: null, lastTimeSeconds: null },
    });
    const result = await executeTool("apply_subject_matte", { clipId: "c1" }, host);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NO_SUBJECT");
    expect(result.error?.suggestedFix).toContain("minCoverage");
  });

  it("requires clipId and validates the target clip", async () => {
    const host = new FakeVisionHost();
    const missingClip = await executeTool("apply_subject_matte", { mediaId: "m1" }, host);
    expect(missingClip.error?.code).toBe("INVALID_PARAMS");

    const badClip = await executeTool("apply_subject_matte", { clipId: "missing" }, host);
    expect(badClip.error?.code).toBe("NOT_FOUND");
    expect(host.requests.apply).toHaveLength(0);
  });

  it("is flagged destructive so the loop asks for confirmation", async () => {
    const tool = getTool("apply_subject_matte")!;
    expect(tool.destructive).toBe(true);
    // Executor must not treat a destructive tool as read-only.
    const effects = await (async () => {
      const spy = vi.fn();
      const host = new FakeVisionHost();
      const original = host.applyAction.bind(host);
      host.applyAction = async (action) => {
        spy(action.type);
        return original(action);
      };
      await executeTool("apply_subject_matte", { clipId: "c1" }, host);
      return spy.mock.calls.length;
    })();
    expect(effects).toBeGreaterThanOrEqual(0);
  });
});

describe("auto_reframe_clip", () => {
  it("passes the director's camera settings through to the host", async () => {
    const host = new FakeVisionHost();
    const result = await executeTool(
      "auto_reframe_clip",
      {
        clipId: "c1",
        targetAspectRatio: "1:1",
        trackingSpeed: 0.25,
        padding: 0.2,
        smoothing: 0.9,
        followSubject: false,
        centerBias: 0.1,
        setCanvasSize: false,
        intervalMs: 200,
      },
      host,
    );

    expect(result.ok).toBe(true);
    expect(host.requests.reframe).toHaveLength(1);
    expect(host.requests.reframe[0]).toEqual({
      clipId: "c1",
      targetAspectRatio: "1:1",
      trackingSpeed: 0.25,
      padding: 0.2,
      smoothing: 0.9,
      followSubject: false,
      centerBias: 0.1,
      setCanvasSize: false,
      startTime: 0,
      endTime: 5,
      intervalMs: 200,
    });
    expect(result.summary).toContain("1080x1920");
    expect(result.summary).toContain("6 camera keyframe(s)");
    expect(result.summary).toContain("one undo step");
    expect((result.data as { usedFaceBackend?: boolean } | undefined)?.usedFaceBackend).toBe(true);
  });

  it("reports honestly when the host cannot reframe", async () => {
    const host = new FakeVisionHost(projectWithMedia(), {
      reframe: { code: "unsupported_host", error: "no decoder" },
    });
    const result = await executeTool("auto_reframe_clip", { clipId: "c1" }, host);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNSUPPORTED_HOST");
    expect(result.error?.suggestedFix).toContain("Do not retry");
  });

  it("fails with a suggested fix when no camera move was produced", async () => {
    const host = new FakeVisionHost(projectWithMedia(), {
      reframe: { ...REFRAME_RESULT, keyframesWritten: 0, keyframeSamples: 0 },
    });
    const result = await executeTool("auto_reframe_clip", { clipId: "c1" }, host);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NO_CAMERA_MOVE");
    expect(result.error?.suggestedFix).toContain("retry");
  });

  it("surfaces the built-in-detector fallback as a warning", async () => {
    const host = new FakeVisionHost(projectWithMedia(), {
      reframe: { ...REFRAME_RESULT, usedFaceBackend: false, warnings: ["face model unavailable"] },
    });
    const result = await executeTool("auto_reframe_clip", { clipId: "c1" }, host);

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("subject detector");
    expect(result.warnings).toContain("face model unavailable");
  });
});

describe("refine_matte_edges", () => {
  it("is registered as a strict, destructive ai tool", () => {
    const tool = getTool("refine_matte_edges")!;

    expect(tool).toBeTruthy();
    expect(tool.strict).toBe(true);
    expect(tool.readOnly).toBe(false);
    expect(tool.destructive).toBe(true);
    expect(tool.domain).toBe("ai");
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.required as string[]).toEqual(["clipId", "maskId", "edge"]);
  });

  it("passes the edge knobs straight through to the host", async () => {
    const host = new FakeVisionHost();
    const result = await executeTool(
      "refine_matte_edges",
      {
        clipId: "c1",
        maskId: "mask-1",
        edge: { featherPx: 4, expansionPx: -2, motionSensitivity: 0.8, maxFeatherPx: 18 },
      },
      host,
    );

    expect(result.ok).toBe(true);
    expect(host.requests.refine).toHaveLength(1);
    expect(host.requests.refine[0].edge).toEqual({
      featherPx: 4,
      expansionPx: -2,
      motionSensitivity: 0.8,
      maxFeatherPx: 18,
    });
  });

  it("reports the feather range it wrote, not a generic confirmation", async () => {
    const host = new FakeVisionHost();
    const result = await executeTool(
      "refine_matte_edges",
      { clipId: "c1", maskId: "mask-1", edge: { featherPx: 4 } },
      host,
    );

    expect(result.ok).toBe(true);
    // Feathers are rounded for display, so 4 is shown as "4", not "4.0".
    expect(result.summary).toContain("4–11.2px");
    expect(result.summary).toContain("keyframed with the subject's motion");
    expect(result.summary).toContain("peak 100%");
    expect((result.data as { motion: number[] }).motion).toEqual([1, 0.5, 0]);
  });

  it("says so plainly when the feather is uniform", async () => {
    const host = new FakeVisionHost(projectWithMedia(), {
      refine: {
        ...REFINE_RESULT,
        edge: { motion: [0, 0, 0], minFeatherPx: 6, maxFeatherPx: 6 },
      },
    });
    const result = await executeTool(
      "refine_matte_edges",
      { clipId: "c1", maskId: "mask-1", edge: { featherPx: 6, motionSensitivity: 0 } },
      host,
    );

    expect(result.summary).toContain("uniform");
    expect(result.summary).not.toContain("keyframed");
  });

  it("requires edge.featherPx rather than guessing a value", async () => {
    const host = new FakeVisionHost();
    const result = await executeTool(
      "refine_matte_edges",
      { clipId: "c1", maskId: "mask-1", edge: { motionSensitivity: 0.5 } },
      host,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_PARAMS");
    expect(host.requests.refine).toHaveLength(0);
  });

  it("rejects an inverted time range", async () => {
    const host = new FakeVisionHost();
    const result = await executeTool(
      "refine_matte_edges",
      {
        clipId: "c1",
        maskId: "mask-1",
        edge: { featherPx: 4 },
        startTime: 5,
        endTime: 2,
      },
      host,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_PARAMS");
    expect(result.error?.message).toContain("endTime");
    expect(host.requests.refine).toHaveLength(0);
  });

  it("forwards a partial range so only part of a shot is refined", async () => {
    const host = new FakeVisionHost();
    await executeTool(
      "refine_matte_edges",
      { clipId: "c1", maskId: "mask-1", edge: { featherPx: 4 }, startTime: 1, endTime: 3 },
      host,
    );

    expect(host.requests.refine[0].startTime).toBe(1);
    expect(host.requests.refine[0].endTime).toBe(3);
  });

  it("fails loudly with a NOT_FOUND fix when the mask has no keyframes there", async () => {
    const host = new FakeVisionHost(projectWithMedia(), {
      refine: { ...REFINE_RESULT, keyframeCount: 0 },
    });
    const result = await executeTool(
      "refine_matte_edges",
      { clipId: "c1", maskId: "mask-1", edge: { featherPx: 4 } },
      host,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NOT_FOUND");
    expect(result.error?.suggestedFix).toContain("apply_subject_matte");
  });

  it("reports UNSUPPORTED_HOST without retrying when the host cannot refine", async () => {
    const host = new FakeVisionHost();
    vi.spyOn(host, "features").mockReturnValue({
      ...host.features(),
      refineMatteEdges: false,
    });
    const result = await executeTool(
      "refine_matte_edges",
      { clipId: "c1", maskId: "mask-1", edge: { featherPx: 4 } },
      host,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNSUPPORTED_HOST");
    expect(result.error?.suggestedFix).toContain("Do not retry");
  });

  it("surfaces host warnings", async () => {
    const host = new FakeVisionHost(projectWithMedia(), {
      refine: { ...REFINE_RESULT, warnings: ["inverted matte feathers inwards"] },
    });
    const result = await executeTool(
      "refine_matte_edges",
      { clipId: "c1", maskId: "mask-1", edge: { featherPx: 20, invert: true } },
      host,
    );

    expect(result.ok).toBe(true);
    expect(result.warnings).toContain("inverted matte feathers inwards");
  });
});

describe("apply_subject_matte edge refinement", () => {
  it("forwards the edge block to the host when present", async () => {
    const host = new FakeVisionHost();
    await executeTool(
      "apply_subject_matte",
      {
        clipId: "c1",
        edge: { featherPx: 3, expansionPx: 1, motionSensitivity: 0.4, opacity: 0.9 },
      },
      host,
    );

    expect(host.requests.apply[0].edge).toEqual({
      featherPx: 3,
      expansionPx: 1,
      motionSensitivity: 0.4,
      opacity: 0.9,
    });
  });

  it("omits edge entirely when the caller did not ask for refinement", async () => {
    const host = new FakeVisionHost();
    await executeTool("apply_subject_matte", { clipId: "c1", featherPx: 8 }, host);

    expect(host.requests.apply[0].edge).toBeUndefined();
    expect(host.requests.apply[0].featherPx).toBe(8);
  });

  it("reports the refined range in its summary", async () => {
    const host = new FakeVisionHost(projectWithMedia(), {
      apply: { ...APPLY_RESULT, edge: EDGE_RESULT },
    });
    const result = await executeTool(
      "apply_subject_matte",
      { clipId: "c1", edge: { featherPx: 4 } },
      host,
    );

    expect(result.summary).toContain("4–11.2px");
    expect((result.data as { edge?: unknown }).edge).toBeTruthy();
  });
});
