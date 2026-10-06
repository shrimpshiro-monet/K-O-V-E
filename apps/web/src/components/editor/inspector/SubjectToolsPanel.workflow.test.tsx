import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MaskEngine, type Mask, type Project } from "@kove-advanced/core";
import { useEngineStore } from "../../../stores/engine-store";
import { useProjectStore } from "../../../stores/project-store";
import { createEmptyProject } from "../../../stores/project/project-helpers";
import { SubjectToolsPanel } from "./SubjectToolsPanel";
import type { SubjectMatteAnalysis } from "../../../services/agent/vision-analysis";

const analysisMock = vi.hoisted(() => ({
  analyzeFacesInMedia: vi.fn(),
  analyzeSubjectMatte: vi.fn(),
}));

vi.mock("../../../services/agent/vision-analysis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../services/agent/vision-analysis")>();
  return {
    ...actual,
    analyzeFacesInMedia: analysisMock.analyzeFacesInMedia,
    analyzeSubjectMatte: analysisMock.analyzeSubjectMatte,
  };
});

const CLIP_ID = "clip-1";

function projectWithClip(): Project {
  const project = createEmptyProject("Subject tools");
  return {
    ...project,
    timeline: {
      ...project.timeline,
      duration: 8,
      tracks: [
        {
          id: "video-track",
          type: "video",
          name: "Video",
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
          transitions: [],
          clips: [
            {
              id: CLIP_ID,
              mediaId: "media-1",
              trackId: "video-track",
              startTime: 2,
              duration: 4,
              inPoint: 1,
              outPoint: 5,
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
          id: "media-1",
          name: "take.mp4",
          type: "video",
          fileHandle: null,
          blob: new Blob(["video"]),
          thumbnailUrl: null,
          waveformData: null,
          metadata: { duration: 10 },
        },
      ],
    },
  } as unknown as Project;
}

const matteAnalysis = (): SubjectMatteAnalysis => ({
  result: {
    width: 64,
    height: 64,
    sampledFrames: 8,
    missedFrames: 0,
    keyframeCount: 2,
    keyframes: [
      { timeMs: 1000, coverage: 0.2, pointCount: 4, centroid: { x: 0.4, y: 0.4 } },
      { timeMs: 3000, coverage: 0.22, pointCount: 5, centroid: { x: 0.5, y: 0.4 } },
    ],
    averageCoverage: 0.21,
    boundingBox: { x: 0.2, y: 0.2, width: 0.4, height: 0.5 },
    warnings: [],
  },
  plan: {
    keyframes: [
      {
        timeMs: 1000,
        path: { closed: true, points: [{ x: 0.2, y: 0.2 }, { x: 0.4, y: 0.2 }, { x: 0.4, y: 0.4 }] },
        coverage: 0.2,
        centroid: { x: 0.4, y: 0.4 },
        pointCount: 3,
      },
      {
        timeMs: 3000,
        path: { closed: true, points: [{ x: 0.3, y: 0.2 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.4 }] },
        coverage: 0.22,
        centroid: { x: 0.5, y: 0.4 },
        pointCount: 3,
      },
    ],
    sampledFrames: 8,
    missedFrames: 0,
    averageCoverage: 0.21,
    boundingBox: { x: 0.2, y: 0.2, width: 0.4, height: 0.5 },
    warnings: [],
  },
  maskWidth: 64,
  maskHeight: 64,
});

describe("SubjectToolsPanel workflow", () => {
  const maskEngine = new MaskEngine({ width: 1920, height: 1080 });
  const originalGetMaskEngine = useEngineStore.getState().getMaskEngine;
  const originalExecuteAction = useProjectStore.getState().executeAction;

  beforeEach(() => {
    maskEngine.clearAllMasks();
    analysisMock.analyzeFacesInMedia.mockReset();
    analysisMock.analyzeSubjectMatte.mockReset();
    analysisMock.analyzeSubjectMatte.mockResolvedValue(matteAnalysis());
    analysisMock.analyzeFacesInMedia.mockResolvedValue({
      width: 1920,
      height: 1080,
      sampledFrames: 4,
      sampledTimesMs: [0, 500, 1000, 1500],
      tracks: [
        {
          id: "face-1",
          firstTimeMs: 0,
          lastTimeMs: 1500,
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
    cleanup();
    useEngineStore.setState({ getMaskEngine: originalGetMaskEngine });
    useProjectStore.setState({ hasOpenProject: false, executeAction: originalExecuteAction });
  });

  it("disables analysis until a clip with local media is selected", () => {
    render(<SubjectToolsPanel />);
    expect(screen.getByRole("button", { name: /Detect Faces/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Analyze Subject/i })).toBeDisabled();
  });

  it("reviews the matte, then writes it as one undoable mask action", async () => {
    render(<SubjectToolsPanel clipId={CLIP_ID} />);

    fireEvent.click(screen.getByRole("button", { name: /Analyze Subject/i }));

    await waitFor(() => {
      expect(analysisMock.analyzeSubjectMatte).toHaveBeenCalled();
    });
    const applyButton = await screen.findByRole("button", { name: /Apply matte \(2 keyframes\)/i });

    fireEvent.click(applyButton);

    await waitFor(() => {
      expect(useProjectStore.getState().project.masks?.[0]?.keyframes).toHaveLength(2);
    });
    const mask = useProjectStore.getState().project.masks![0];
    expect(mask.clipId).toBe(CLIP_ID);
    // Keyframes are absolute source ms. The clip starts at timeline 2s and
    // shows source from 1s: source 1000ms → t=2s, source 3000ms → t=4s.
    expect(mask.keyframes.map((keyframe) => keyframe.time)).toEqual([2, 4]);
    expect(maskEngine.getMasksForClip(CLIP_ID)).toHaveLength(1);
    expect(await screen.findByText(/one undo step/i)).toBeInTheDocument();
  });

  it("re-applying updates the same mask instead of stacking a second one", async () => {
    render(<SubjectToolsPanel clipId={CLIP_ID} />);

    fireEvent.click(screen.getByRole("button", { name: /Analyze Subject/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Apply matte/i }));
    await waitFor(() => {
      expect(useProjectStore.getState().project.masks).toHaveLength(1);
    });

    fireEvent.click(screen.getByRole("button", { name: /Apply matte/i }));
    await waitFor(() => {
      expect(screen.getAllByText(/one undo step/i).length).toBeGreaterThan(0);
    });
    expect(useProjectStore.getState().project.masks).toHaveLength(1);
    expect(useProjectStore.getState().project.masks![0].keyframes).toHaveLength(2);
  });

  it("lists detected face tracks and marks the primary", async () => {
    render(<SubjectToolsPanel clipId={CLIP_ID} />);

    fireEvent.click(screen.getByRole("button", { name: /Detect Faces/i }));

    await waitFor(() => {
      expect(screen.getByText(/face-1 \(primary\)/)).toBeInTheDocument();
    });
    expect(analysisMock.analyzeFacesInMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        durationSeconds: 10,
        request: expect.objectContaining({ mediaId: "media-1", startTime: 1, endTime: 5 }),
      }),
    );
  });

  it("surfaces analysis failures instead of writing anything", async () => {
    analysisMock.analyzeSubjectMatte.mockRejectedValueOnce(new Error("decoder exploded"));
    render(<SubjectToolsPanel clipId={CLIP_ID} />);

    fireEvent.click(screen.getByRole("button", { name: /Analyze Subject/i }));

    await waitFor(() => {
      expect(screen.getByText("decoder exploded")).toBeInTheDocument();
    });
    expect(useProjectStore.getState().project.masks ?? []).toHaveLength(0);
  });
});
