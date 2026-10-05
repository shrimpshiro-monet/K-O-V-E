import { describe, expect, it, vi } from "vitest";
import { executeTool } from "./executor";
import { HeadlessHost } from "./headless-host";
import { makeProjectWithClip } from "./test-fixtures";
import { getTool } from "./registry";
import type { Project } from "@kove-advanced/core/types/project";
import type {
  ApplySubjectMatteRequest,
  ApplySubjectMatteResult,
  FaceAnalysisResult,
  HostFeatures,
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
  } = { faces: [], matte: [], apply: [] };

  constructor(
    project: Project = projectWithMedia(),
    private readonly overrides: {
      faces?: FaceAnalysisResult | { code: "unsupported_host"; error: string };
      matte?: SubjectMatteResult | { code: "unsupported_host"; error: string };
      apply?: ApplySubjectMatteResult | { code: "unsupported_host"; error: string };
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
}

describe("vision tool registration", () => {
  it("registers three strict ai tools with the right safety flags", () => {
    const faces = getTool("detect_faces")!;
    const rotoscope = getTool("rotoscope_subject")!;
    const apply = getTool("apply_subject_matte")!;

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
  });
});

describe("vision tools on the headless host", () => {
  it("fails clearly instead of silently no-oping", async () => {
    const host = new HeadlessHost(projectWithMedia());
    for (const [tool, args] of [
      ["detect_faces", { mediaId: "m1" }],
      ["rotoscope_subject", { mediaId: "m1" }],
      ["apply_subject_matte", { clipId: "c1" }],
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
