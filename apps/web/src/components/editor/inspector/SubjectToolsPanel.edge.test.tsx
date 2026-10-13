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
  const actual =
    await importOriginal<typeof import("../../../services/agent/vision-analysis")>();
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
              inPoint: 0,
              outPoint: 4,
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

/**
 * Three keyframes: the subject walks across the first two, then stands still.
 * That is the case a single mask-wide feather cannot serve — it has to be wide
 * during the walk and tight once the subject settles.
 */
const walkingThenStill = (): SubjectMatteAnalysis => {
  const keyframes = [
    {
      timeMs: 0,
      path: { closed: true, points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.2 }, { x: 0.3, y: 0.4 }] },
      coverage: 0.2,
      centroid: { x: 0.2, y: 0.3 },
      pointCount: 3,
    },
    {
      timeMs: 1000,
      path: { closed: true, points: [{ x: 0.5, y: 0.2 }, { x: 0.7, y: 0.2 }, { x: 0.7, y: 0.4 }] },
      coverage: 0.3,
      centroid: { x: 0.6, y: 0.3 },
      pointCount: 3,
    },
    {
      timeMs: 2000,
      path: { closed: true, points: [{ x: 0.5, y: 0.2 }, { x: 0.7, y: 0.2 }, { x: 0.7, y: 0.4 }] },
      coverage: 0.3,
      centroid: { x: 0.6, y: 0.3 },
      pointCount: 3,
    },
  ];
  return {
    result: {
      width: 64,
      height: 64,
      sampledFrames: 6,
      missedFrames: 0,
      keyframeCount: 3,
      keyframes: keyframes.map((keyframe) => ({
        timeMs: keyframe.timeMs,
        coverage: keyframe.coverage,
        pointCount: keyframe.pointCount,
        centroid: keyframe.centroid,
      })),
      averageCoverage: 0.27,
      boundingBox: { x: 0.1, y: 0.2, width: 0.6, height: 0.2 },
      warnings: [],
    },
    plan: {
      keyframes,
      sampledFrames: 6,
      missedFrames: 0,
      averageCoverage: 0.27,
      boundingBox: { x: 0.1, y: 0.2, width: 0.6, height: 0.2 },
      warnings: [],
    },
    maskWidth: 64,
    maskHeight: 64,
  };
};

describe("SubjectToolsPanel edge refinement", () => {
  const maskEngine = new MaskEngine({ width: 1920, height: 1080 });
  const originalGetMaskEngine = useEngineStore.getState().getMaskEngine;
  const originalExecuteAction = useProjectStore.getState().executeAction;

  beforeEach(() => {
    maskEngine.clearAllMasks();
    analysisMock.analyzeFacesInMedia.mockReset();
    analysisMock.analyzeSubjectMatte.mockReset();
    analysisMock.analyzeSubjectMatte.mockResolvedValue(walkingThenStill());

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

  const analyze = async () => {
    render(<SubjectToolsPanel clipId={CLIP_ID} />);
    fireEvent.click(screen.getByRole("button", { name: /Analyze Subject/i }));
    await screen.findByRole("button", { name: /Apply matte \(3 keyframes\)/i });
  };

  /**
   * The inspector's sliders are Radix thumbs, not range inputs, so they are
   * driven here the way a user types an exact value: open the value editor,
   * type, commit with Enter.
   */
  const setSlider = async (label: RegExp, value: string) => {
    const thumb = screen.getByRole("slider", { name: label });
    const name = thumb.getAttribute("aria-label");
    fireEvent.click(screen.getByRole("button", { name: `Edit ${name} value` }));
    const input = await screen.findByLabelText(`${name} value`);
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: "Enter" });
  };

  it("exposes the edge controls that were previously unreachable", async () => {
    await analyze();

    expect(screen.getByRole("slider", { name: /Mask feather/i })).toBeTruthy();
    expect(screen.getByRole("slider", { name: /Edge expansion/i })).toBeTruthy();
    expect(screen.getByRole("slider", { name: /Motion response/i })).toBeTruthy();
    expect(screen.getByRole("slider", { name: /Matte opacity/i })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /Invert matte/i })).toBeTruthy();
  });

  it("shows a live before/after edge preview", async () => {
    await analyze();

    expect(screen.getByTestId("matte-edge-preview-before")).toBeTruthy();
    expect(screen.getByTestId("matte-edge-preview-after")).toBeTruthy();
    expect(screen.getByText(/Edge preview/i)).toBeTruthy();
  });

  it("previews the keyframe the user selects", async () => {
    await analyze();

    // Defaults to the first keyframe.
    expect(screen.getByText(/keyframe 1\/3 · 0\.00s/i)).toBeTruthy();

    await setSlider(/Preview keyframe/i, "3");

    await waitFor(() => {
      expect(screen.getByText(/keyframe 3\/3 · 2\.00s/i)).toBeTruthy();
    });
  });

  it("lists a per-keyframe feather that follows the subject's motion", async () => {
    await analyze();

    const list = screen.getByTestId("matte-edge-keyframes");
    expect(list.textContent).toContain("Per-keyframe feather (3)");

    // Default motion response is 60%, base feather 4px, cap 12px: the two
    // moving keyframes widen, the settled one stays at base.
    const feathers = [...list.querySelectorAll("li")].map(
      (item) => item.textContent ?? "",
    );
    expect(feathers).toHaveLength(3);
    expect(feathers[0]).toMatch(/motion 100%/);
    expect(feathers[2]).toMatch(/motion 0%/);
    expect(feathers[0]).not.toBe(feathers[2]);
  });

  it("makes the feather uniform when motion response is turned off", async () => {
    await analyze();

    await setSlider(/Motion response/i, "0");

    await waitFor(() => {
      const feathers = [...screen.getByTestId("matte-edge-keyframes").querySelectorAll("li")].map(
        (item) => item.textContent ?? "",
      );
      // Every keyframe reports the same 4.0px feather now.
      expect(feathers.every((text) => text.includes("4.0px"))).toBe(true);
    });
  });

  it("writes per-keyframe feather overrides onto the mask", async () => {
    await analyze();

    fireEvent.click(screen.getByRole("button", { name: /Apply matte \(3 keyframes\)/i }));

    await waitFor(() => {
      expect(useProjectStore.getState().project.masks?.[0]?.keyframes).toHaveLength(3);
    });

    const mask = useProjectStore.getState().project.masks![0];
    const feathers = mask.keyframes.map((keyframe) => keyframe.feathering);

    // A flat mask-wide feather (the old behaviour) would leave these undefined.
    expect(feathers.every((value) => typeof value === "number")).toBe(true);
    // The settled keyframe is tighter than the moving ones.
    expect(feathers[2]!).toBeLessThan(feathers[0]!);
    // ...and the mask-level value is the base those keyframes inherit.
    expect(mask.feathering).toBe(4);
  });

  it("carries expansion, invert and opacity onto the written mask", async () => {
    await analyze();

    await setSlider(/Edge expansion/i, "6");
    await setSlider(/Matte opacity/i, "50");
    fireEvent.click(screen.getByRole("checkbox", { name: /Invert matte/i }));

    fireEvent.click(screen.getByRole("button", { name: /Apply matte \(3 keyframes\)/i }));

    await waitFor(() => {
      expect(useProjectStore.getState().project.masks?.[0]?.expansion).toBe(6);
    });

    const mask = useProjectStore.getState().project.masks![0];
    expect(mask.inverted).toBe(true);
    expect(mask.opacity).toBeCloseTo(0.5, 5);
    expect(mask.keyframes.every((keyframe) => keyframe.expansion === 6)).toBe(true);
  });

  it("reports the feather range it wrote", async () => {
    await analyze();

    fireEvent.click(screen.getByRole("button", { name: /Apply matte \(3 keyframes\)/i }));

    await waitFor(() => {
      expect(screen.getByText(/keyframed with the subject's motion/i)).toBeTruthy();
    });
    expect(screen.getByText(/Edge feather [\d.]+–[\d.]+px/i)).toBeTruthy();
  });

  it("keeps the whole refinement inside a single undoable action", async () => {
    await analyze();

    fireEvent.click(screen.getByRole("button", { name: /Apply matte \(3 keyframes\)/i }));

    await waitFor(() => {
      expect(useProjectStore.getState().project.masks?.[0]?.keyframes).toHaveLength(3);
    });

    const actions = (useProjectStore.getState().executeAction as ReturnType<typeof vi.fn>).mock
      .calls;
    const maskActions = actions.filter(([action]) => action.type === "mask/setAll");
    expect(maskActions).toHaveLength(1);
  });
});
