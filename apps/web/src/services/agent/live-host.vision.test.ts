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

/**
 * Three mask keyframes: the subject moves between the first two and is still
 * for the last, so a motion-aware edge has something to react to.
 */
const maskWithMatte = (): Mask => ({
  id: "mask-existing",
  clipId: CLIP_ID,
  type: "drawn",
  path: { closed: true, points: [{ x: 0.1, y: 0.1 }] },
  feathering: 4,
  inverted: false,
  expansion: 0,
  opacity: 1,
  keyframes: [
    {
      id: "kf-1",
      time: 1,
      path: {
        closed: true,
        points: [
          { x: 0.1, y: 0.1 },
          { x: 0.4, y: 0.1 },
          { x: 0.4, y: 0.4 },
          { x: 0.1, y: 0.4 },
        ],
      },
      easing: "linear",
    },
    {
      id: "kf-2",
      time: 2,
      path: {
        closed: true,
        points: [
          { x: 0.5, y: 0.1 },
          { x: 0.8, y: 0.1 },
          { x: 0.8, y: 0.4 },
          { x: 0.5, y: 0.4 },
        ],
      },
      easing: "linear",
    },
    {
      id: "kf-3",
      time: 3,
      path: {
        closed: true,
        points: [
          { x: 0.5, y: 0.1 },
          { x: 0.8, y: 0.1 },
          { x: 0.8, y: 0.4 },
          { x: 0.5, y: 0.4 },
        ],
      },
      easing: "linear",
    },
  ],
});

describe("LiveEditorHost refineMatteEdges", () => {
  const maskEngine = new MaskEngine({ width: 1920, height: 1080 });
  const originalGetMaskEngine = useEngineStore.getState().getMaskEngine;
  const originalExecuteAction = useProjectStore.getState().executeAction;

  beforeEach(() => {
    maskEngine.clearAllMasks();
    useEngineStore.setState({ getMaskEngine: async () => maskEngine });
    useProjectStore.setState({
      hasOpenProject: true,
      project: { ...projectWithClip(), masks: [maskWithMatte()] },
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
    useEngineStore.setState({ getMaskEngine: originalGetMaskEngine });
    useProjectStore.setState({ hasOpenProject: false, executeAction: originalExecuteAction });
  });

  const refine = (args: Record<string, unknown>) =>
    executeTool(
      "refine_matte_edges",
      { clipId: CLIP_ID, maskId: "mask-existing", edge: { featherPx: 4 }, ...args },
      new LiveEditorHost(),
    );

  it("is advertised as an available capability", () => {
    expect(new LiveEditorHost().features().refineMatteEdges).toBe(true);
  });

  it("writes a per-keyframe feather that follows the shapes it already has", async () => {
    const result = await refine({});

    expect(result.ok).toBe(true);
    const mask = useProjectStore.getState().project.masks![0];
    const feathers = mask.keyframes.map((keyframe) => keyframe.feathering);

    // All three are numbers now (a flat edge would leave them undefined)...
    expect(feathers.every((value) => typeof value === "number")).toBe(true);
    // ...and the settled keyframe (3) is tighter than the moving ones.
    expect(feathers[2]!).toBeLessThan(feathers[0]!);
    expect(feathers[2]).toBeCloseTo(4, 5);
  });

  it("does not re-run segmentation to do it", async () => {
    visionMock.analyzeSubjectMatte.mockClear();
    await refine({});
    expect(visionMock.analyzeSubjectMatte).not.toHaveBeenCalled();
  });

  it("honours motionSensitivity 0 as a uniform feather", async () => {
    await refine({ edge: { featherPx: 7, motionSensitivity: 0 } });

    const mask = useProjectStore.getState().project.masks![0];
    expect(mask.keyframes.map((keyframe) => keyframe.feathering)).toEqual([7, 7, 7]);
  });

  it("carries expansion, invert and opacity onto the mask", async () => {
    const result = await refine({
      edge: { featherPx: 5, expansionPx: -3, invert: true, opacity: 0.6 },
    });

    expect(result.ok).toBe(true);
    const mask = useProjectStore.getState().project.masks![0];
    expect(mask.expansion).toBe(-3);
    expect(mask.inverted).toBe(true);
    expect(mask.opacity).toBeCloseTo(0.6, 5);
    expect(mask.keyframes.every((keyframe) => keyframe.expansion === -3)).toBe(true);
  });

  it("refines only the requested range and leaves the rest alone", async () => {
    await refine({ edge: { featherPx: 9, motionSensitivity: 0 }, endTime: 2 });

    const mask = useProjectStore.getState().project.masks![0];
    expect(mask.keyframes[0].feathering).toBe(9);
    expect(mask.keyframes[1].feathering).toBe(9);
    // Outside the range: untouched, so no override was written.
    expect(mask.keyframes[2].feathering).toBeUndefined();
    expect(mask.keyframes[2].id).toBe("kf-3");
  });

  it("commits the refinement as one undoable action", async () => {
    await refine({});

    const actions = (useProjectStore.getState().executeAction as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(actions.filter(([action]) => action.type === "mask/setAll")).toHaveLength(1);
  });

  it("keeps the live MaskEngine in sync so the preview updates immediately", async () => {
    await refine({ edge: { featherPx: 6, motionSensitivity: 0 } });

    expect(maskEngine.getMask("mask-existing")?.keyframes[0]?.feathering).toBe(6);
  });

  it("reports unsupported_host for an unknown mask or clip", async () => {
    const host = new LiveEditorHost();
    const missingMask = await host.refineMatteEdges({
      clipId: CLIP_ID,
      maskId: "nope",
      edge: { featherPx: 4 },
    });
    expect("code" in missingMask).toBe(true);

    const missingClip = await host.refineMatteEdges({
      clipId: "nope",
      maskId: "mask-existing",
      edge: { featherPx: 4 },
    });
    expect("code" in missingClip).toBe(true);
  });

  it("reports unsupported_host when the range holds no keyframes", async () => {
    const host = new LiveEditorHost();
    const result = await host.refineMatteEdges({
      clipId: CLIP_ID,
      maskId: "mask-existing",
      edge: { featherPx: 4 },
      startTime: 50,
      endTime: 60,
    });

    expect("code" in result).toBe(true);
    if ("code" in result) expect(result.error).toContain("no keyframes");
  });
});
