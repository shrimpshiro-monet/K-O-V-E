import { describe, expect, it } from "vitest";
import type { Project } from "@kove-advanced/core/types/project";
import type { EditingHost, TextOverlayOptions, OverlayRef } from "../host";
import { HeadlessHost } from "../headless-host";
import { executeTool } from "../executor";
import { MockLLMClient, type LLMResponse } from "../llm";

// ---------------------------------------------------------------------------
// Minimal harness (same shape as plan-edit-integrity): a scripted plan goes
// through the real plan_edit funnel and we capture the text overlays that
// would land on the timeline.
// ---------------------------------------------------------------------------

const END: LLMResponse = { text: "Done.", stopReason: "end_turn", toolUses: [] };

function planResponse(input: Record<string, unknown>): LLMResponse {
  return {
    text: "",
    stopReason: "tool_use",
    toolUses: [{ id: `plan-${Math.random().toString(36).slice(2)}`, name: "submit_edit_plan", input }],
  };
}

function makeProject(): Project {
  return {
    id: "legibility-project",
    name: "Legibility",
    createdAt: 0,
    modifiedAt: 0,
    settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48000, channels: 2 },
    timeline: { duration: 0, tracks: [], subtitles: [], markers: [] },
    mediaLibrary: {
      items: [{ id: "video-1", name: "footage.mp4", type: "video", metadata: { duration: 10 } }],
    },
  } as unknown as Project;
}

function harness(plan: Record<string, unknown>): {
  host: EditingHost;
  createdTextOverlays: TextOverlayOptions[];
} {
  const project = makeProject();
  const host = new HeadlessHost(project) as unknown as EditingHost & { llm: NonNullable<EditingHost["llm"]> };
  const createdTextOverlays: TextOverlayOptions[] = [];
  let textSeq = 0;
  host.createTextOverlay = async (options: TextOverlayOptions): Promise<OverlayRef> => {
    createdTextOverlays.push(options);
    textSeq += 1;
    return { id: `text-${textSeq}`, trackId: "text-track" };
  };
  const scripted = new MockLLMClient([planResponse(plan), END]);
  host.llm = { client: scripted, provider: "openai" };
  return { host, createdTextOverlays };
}

/** A plan whose text elements carry NO style fields at all. */
function planWithBareTextElements(textElements: Record<string, unknown>[]): Record<string, unknown> {
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
    ],
    textElements,
    effects: [],
    transitions: [],
    audioDecisions: [],
    metadata: {
      targetDuration: 4,
      targetPlatform: "social",
      genre: "test",
      pacing: "fast",
      rationale: "legibility fixture",
    },
  };
}

const bareCaption = {
  content: "the comeback starts here",
  style: "caption",
  startTime: 0.5,
  duration: 2,
  position: { x: 0.5, y: 0.93 },
  rationale: "hook caption",
};

describe("plan-derived text legibility defaults", () => {
  it("fills stroke, shadow and a readable font floor for bare plan text", async () => {
    const { host, createdTextOverlays } = harness(
      planWithBareTextElements([bareCaption]),
    );
    const result = await executeTool("plan_edit", { prompt: "make a highlight" }, host);
    expect(result.ok).toBe(true);
    expect(createdTextOverlays).toHaveLength(1);

    const style = createdTextOverlays[0]!.style as Record<string, unknown>;
    // 1080p frame → caption floor 4.5% of height, NOT the unset/48px default drift.
    expect(style.fontSize).toBe(Math.round(1080 * 0.045));
    expect(style.strokeColor).toBe("#111827");
    expect(style.strokeWidth).toBeGreaterThanOrEqual(2);
    expect(style.shadowColor).toBe("rgba(0, 0, 0, 0.6)");
    expect(style.shadowBlur).toBeGreaterThanOrEqual(8);
    expect(style.shadowOffsetY).toBeGreaterThanOrEqual(2);
  });

  it("clamps caption positions out of the bottom platform-UI band", async () => {
    const { host, createdTextOverlays } = harness(
      planWithBareTextElements([bareCaption]),
    );
    await executeTool("plan_edit", { prompt: "make a highlight" }, host);
    expect(createdTextOverlays[0]!.position!.y).toBeLessThanOrEqual(0.85);
    expect(createdTextOverlays[0]!.position!.x).toBeGreaterThanOrEqual(0.05);
  });

  it("leaves explicit plan styling untouched (fill undefined, never override)", async () => {
    const explicit = {
      ...bareCaption,
      position: { x: 0.5, y: 0.7 },
      templateOverride: {
        strokeColor: "#00ff00",
        strokeWidth: 9,
        shadowColor: "rgba(0, 255, 0, 0.5)",
        shadowBlur: 4,
        shadowOffsetY: 1,
        fontSize: 96,
      },
    };
    const { host, createdTextOverlays } = harness(planWithBareTextElements([explicit]));
    const result = await executeTool("plan_edit", { prompt: "make a highlight" }, host);
    expect(result.ok).toBe(true);

    const style = createdTextOverlays[0]!.style as Record<string, unknown>;
    expect(style.strokeColor).toBe("#00ff00");
    expect(style.strokeWidth).toBe(9);
    expect(style.shadowColor).toBe("rgba(0, 255, 0, 0.5)");
    expect(style.shadowBlur).toBe(4);
    expect(style.shadowOffsetY).toBe(1);
    expect(style.fontSize).toBe(96);
    expect(createdTextOverlays[0]!.position!.y).toBe(0.7);
  });

  it("caps no explicit size: sizes above the floor pass through as-is", async () => {
    const sized = { ...bareCaption, fontSize: 80 };
    const { host, createdTextOverlays } = harness(planWithBareTextElements([sized]));
    await executeTool("plan_edit", { prompt: "make a highlight" }, host);
    expect(createdTextOverlays[0]!.style as Record<string, unknown>).toMatchObject({ fontSize: 80 });
  });
});
