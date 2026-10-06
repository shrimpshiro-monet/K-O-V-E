import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MaskEngine, type Mask, type Project } from "@kove-advanced/core";
import { executeTool } from "@kove-advanced/agent";
import { useEngineStore } from "../../stores/engine-store";
import { useProjectStore } from "../../stores/project-store";
import { createEmptyProject } from "../../stores/project/project-helpers";
import { LiveEditorHost } from "./live-host";
import type { SubjectMatteAnalysis } from "./vision-analysis";

const visionMock = vi.hoisted(() => ({
  analyzeFacesInMedia: vi.fn(),
  analyzeSubjectMatte: vi.fn(),
}));

vi.mock("./vision-analysis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./vision-analysis")>();
  return {
    ...actual,
    analyzeFacesInMedia: visionMock.analyzeFacesInMedia,
    analyzeSubjectMatte: visionMock.analyzeSubjectMatte,
  };
});

const CLIP_ID = "clip-1";
const MEDIA_ID = "media-1";

function projectWithClip(): Project {
  const project = createEmptyProject("Vision host");
  return {
    ...project,
    timeline: {
      ...project.timeline,
      duration: 6,
      tracks: [
        {
          id: "track-1",
          type: "video",
          name: "V1",
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
          transitions: [],
          clips: [
            {
              id: CLIP_ID,
              mediaId: MEDIA_ID,
              trackId: "track-1",
              startTime: 1,
              duration: 4,
              inPoint: 2,
              outPoint: 6,
              transform: {
                position: { x: 0, y: 0 },
                scale: { x: 1, y: 1 },
                rotation: 0,
                anchor: { x: 0.5, y: 0.5 },
                opacity: 1,
              },
              effects: [],
              audioEffects: [],
              volume: 1,
              keyframes: [],
            },
          ],
        },
      ],
    },
    mediaLibrary: {
      items: [
        {
          id: MEDIA_ID,
          name: "take.mp4",
          type: "video",
          fileHandle: null,
          blob: new Blob(["video-bytes"]),
          thumbnailUrl: null,
          waveformData: null,
          metadata: { duration: 20 },
        },
      ],
    },
  } as unknown as Project;
}

const matteAnalysis = (): SubjectMatteAnalysis => ({
  result: {
    width: 64,
    height: 64,
    sampledFrames: 5,
    missedFrames: 1,
    keyframeCount: 2,
    keyframes: [
      { timeMs: 2000, coverage: 0.2, pointCount: 4, centroid: { x: 0.4, y: 0.4 } },
      { timeMs: 4000, coverage: 0.25, pointCount: 4, centroid: { x: 0.45, y: 0.4 } },
    ],
    averageCoverage: 0.22,
    boundingBox: { x: 0.2, y: 0.2, width: 0.4, height: 0.5 },
    warnings: [],
  },
  plan: {
    keyframes: [
      {
        timeMs: 2000,
        path: { closed: true, points: [{ x: 0.2, y: 0.2 }, { x: 0.4, y: 0.2 }, { x: 0.4, y: 0.4 }] },
        coverage: 0.2,
        centroid: { x: 0.4, y: 0.4 },
        pointCount: 3,
      },
      {
        timeMs: 4000,
        path: { closed: true, points: [{ x: 0.3, y: 0.2 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.4 }] },
        coverage: 0.25,
        centroid: { x: 0.45, y: 0.4 },
        pointCount: 3,
      },
    ],
    sampledFrames: 5,
    missedFrames: 1,
    averageCoverage: 0.22,
    boundingBox: { x: 0.2, y: 0.2, width: 0.4, height: 0.5 },
    warnings: ["1 sampled frame(s) had no subject"],
  },
  maskWidth: 64,
  maskHeight: 64,
});

describe("LiveEditorHost vision bridge", () => {
  const maskEngine = new MaskEngine({ width: 1920, height: 1080 });
  const originalGetMaskEngine = useEngineStore.getState().getMaskEngine;
  const originalExecuteAction = useProjectStore.getState().executeAction;

  beforeEach(() => {
    vi.stubGlobal("createImageBitmap", vi.fn());
    maskEngine.clearAllMasks();
    visionMock.analyzeFacesInMedia.mockReset();
    visionMock.analyzeSubjectMatte.mockReset();
    visionMock.analyzeSubjectMatte.mockResolvedValue(matteAnalysis());
    visionMock.analyzeFacesInMedia.mockResolvedValue({
      width: 1920,
      height: 1080,
      sampledFrames: 4,
      sampledTimesMs: [2000, 3000, 4000, 5000],
      tracks: [
        {
          id: "face-1",
          firstTimeMs: 2000,
          lastTimeMs: 5000,
          framesDetected: 4,
          averageConfidence: 0.9,
          averageBox: { x: 100, y: 100, width: 200, height: 200 },
          score: 0.8,
        },
      ],
      primaryTrackId: "face-1",
      warnings: [],
    });

    useEngineStore.setState({ getMaskEngine: async () => maskEngine });
    useProjectStore.setState({
      hasOpenProject: true,
      project: projectWithClip(),
      executeAction: vi.fn(async (action) => {
        if (action.type === "mask/setAll") {
          useProjectStore.setState((state) => ({
            project: { ...state.project, masks: action.params.masks as Mask[] },
          }));
        }
        return { success: true, id: action.id };
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useEngineStore.setState({ getMaskEngine: originalGetMaskEngine });
    useProjectStore.setState({ hasOpenProject: false, executeAction: originalExecuteAction });
  });

  it("reports the vision features as available in a browser-like environment", () => {
    const host = new LiveEditorHost();
    const features = host.features();
    expect(features.analyzeFaces).toBe(true);
    expect(features.analyzeSubjectMatte).toBe(true);
    expect(features.applySubjectMatte).toBe(true);
  });

  it("analyzes faces over the clip's source window, not the media duration", async () => {
    const host = new LiveEditorHost();
    const result = await host.analyzeFaces({ mediaId: MEDIA_ID });
    expect("code" in result).toBe(false);
    if ("code" in result) return;
    expect(result.primaryTrackId).toBe("face-1");
    expect(visionMock.analyzeFacesInMedia).toHaveBeenCalledWith(
      expect.objectContaining({ durationSeconds: 20 }),
    );
  });

  it("returns unsupported_host when the media has no local bytes", async () => {
    const project = projectWithClip();
    useProjectStore.setState({
      project: {
        ...project,
        mediaLibrary: {
          items: project.mediaLibrary.items.map((item) => ({ ...item, blob: null })),
        },
      } as Project,
    });
    const host = new LiveEditorHost();
    const result = await host.analyzeFaces({ mediaId: MEDIA_ID });
    expect("code" in result && result.code).toBe("unsupported_host");
  });

  it("runs detect_faces through the real host", async () => {
    const host = new LiveEditorHost();
    const result = await executeTool("detect_faces", { clipId: CLIP_ID }, host);
    expect(result.ok).toBe(true);
    expect((result.data as { primaryTrackId: string }).primaryTrackId).toBe("face-1");
  });

  it("writes a rotoscoped matte as one mask/setAll action through the tool seam", async () => {
    const host = new LiveEditorHost();
    const result = await executeTool(
      "apply_subject_matte",
      { clipId: CLIP_ID, featherPx: 6 },
      host,
    );

    expect(result.ok).toBe(true);
    const masks = useProjectStore.getState().project.masks ?? [];
    expect(masks).toHaveLength(1);
    expect(masks[0].clipId).toBe(CLIP_ID);
    expect(masks[0].feathering).toBe(6);
    // Source 2000ms → clip-local 0 → timeline 1; source 4000ms → timeline 3.
    expect(masks[0].keyframes.map((keyframe) => keyframe.time)).toEqual([1, 3]);
    // The live MaskEngine got the same masks so the inspector updates.
    expect(maskEngine.getMasksForClip(CLIP_ID)).toHaveLength(1);

    const data = result.data as { keyframeCount: number; timebase: string };
    expect(data.keyframeCount).toBe(2);
    expect(data.timebase).toBe("timeline-seconds");
  });

  it("applies a separation preset in the same call", async () => {
    const host = new LiveEditorHost();
    const result = await executeTool(
      "apply_subject_matte",
      {
        clipId: CLIP_ID,
        separation: { preset: "color-background", backgroundColor: "#123456" },
      },
      host,
    );
    expect(result.ok).toBe(true);
    expect((result.data as { separationApplied: boolean }).separationApplied).toBe(true);
  });

  it("reports NO_SUBJECT rather than writing an empty mask", async () => {
    visionMock.analyzeSubjectMatte.mockResolvedValueOnce({
      ...matteAnalysis(),
      plan: { ...matteAnalysis().plan, keyframes: [] },
      result: { ...matteAnalysis().result, keyframeCount: 0, keyframes: [] },
    });
    const host = new LiveEditorHost();
    const result = await executeTool("apply_subject_matte", { clipId: CLIP_ID }, host);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NO_SUBJECT");
    expect(useProjectStore.getState().project.masks ?? []).toHaveLength(0);
  });
});
