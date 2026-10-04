import { describe, expect, it } from "vitest";
import type { Project } from "@kove-advanced/core/types/project";
import { listRegisteredActionTypes } from "@kove-advanced/core/actions/registry";
import type { EditingHost, OverlayRef, TextOverlayOptions, UpdateTextOverlayOptions } from "./host";
import { HeadlessHost } from "./headless-host";
import { executeTool } from "./executor";

/**
 * Boundary tests: what the agent can ALREADY reach through open-object tools
 * (`execute_action`, `update_text_clip`, `create_text_clip`) vs what gets
 * stripped by host shortcuts. Complements effect-timing-boundary.test.ts —
 * these pin today's behavior so any change is deliberate.
 */

function makeProject(): Project {
  return {
    id: "boundary-project",
    name: "Boundary",
    createdAt: 0,
    modifiedAt: 0,
    settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48000, channels: 2 },
    timeline: { duration: 0, tracks: [], subtitles: [], markers: [] },
    mediaLibrary: { items: [] },
    textClips: [],
  } as unknown as Project;
}

function textClips(project: Project): Array<Record<string, unknown>> {
  return (project as unknown as { textClips: Array<Record<string, unknown>> }).textClips;
}

describe("behindSubject reachability through agent tools", () => {
  it("execute_action + text/create stores behindSubject verbatim (raw clip passthrough)", async () => {
    const host = new HeadlessHost(makeProject());
    const result = await executeTool(
      "execute_action",
      {
        type: "text/create",
        params: {
          clip: {
            id: "t1",
            trackId: "text-track-0",
            startTime: 0,
            duration: 3,
            text: "STEPHEN CURRY",
            behindSubject: true,
          },
        },
      },
      host,
    );
    expect(result.ok).toBe(true);
    const clips = textClips(host.getProject());
    expect(clips).toHaveLength(1);
    expect(clips[0].behindSubject).toBe(true);
  });

  it("execute_action + text/update sets behindSubject on an existing clip", async () => {
    const host = new HeadlessHost(makeProject());
    await executeTool(
      "execute_action",
      {
        type: "text/create",
        params: {
          clip: { id: "t1", trackId: "text-track-0", startTime: 0, duration: 3, text: "hi" },
        },
      },
      host,
    );
    const result = await executeTool(
      "execute_action",
      {
        type: "text/update",
        params: { clipId: "t1", updates: { behindSubject: true } },
      },
      host,
    );
    expect(result.ok).toBe(true);
    expect(textClips(host.getProject())[0].behindSubject).toBe(true);
  });

  it("update_text_clip reaches behindSubject on hosts WITHOUT an updateTextOverlay shortcut (action fallback)", async () => {
    const host = new HeadlessHost(makeProject());
    await executeTool(
      "execute_action",
      {
        type: "text/create",
        params: {
          clip: { id: "t1", trackId: "text-track-0", startTime: 0, duration: 3, text: "hi" },
        },
      },
      host,
    );
    const result = await executeTool(
      "update_text_clip",
      { clipId: "t1", updates: { behindSubject: true } },
      host,
    );
    expect(result.ok).toBe(true);
    expect(textClips(host.getProject())[0].behindSubject).toBe(true);
  });

  it("update_text_clip STRIPS behindSubject on hosts WITH an updateTextOverlay shortcut (app/live host path)", async () => {
    const project = makeProject();
    const host = new HeadlessHost(project);
    const captured: Array<Record<string, unknown>> = [];
    (host as unknown as EditingHost).updateTextOverlay = async (
      _id: string,
      options: UpdateTextOverlayOptions,
    ): Promise<OverlayRef> => {
      captured.push({ ...(options as unknown as Record<string, unknown>) });
      return { id: "t1", trackId: "text-track-0" } as OverlayRef;
    };
    await executeTool(
      "execute_action",
      {
        type: "text/create",
        params: {
          clip: { id: "t1", trackId: "text-track-0", startTime: 0, duration: 3, text: "hi" },
        },
      },
      host,
    );
    const result = await executeTool(
      "update_text_clip",
      { clipId: "t1", updates: { behindSubject: true, text: "still works" } },
      host,
    );
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    // The whitelist drops behindSubject before it reaches the host…
    expect("behindSubject" in captured[0]).toBe(false);
    expect(captured[0].text).toBe("still works");
    // …and the shortcut returns before the action fallback, so the clip never gets it.
    expect(textClips(project)[0].behindSubject).toBeUndefined();
  });

  it("create_text_clip STRIPS behindSubject via the headless createTextOverlay whitelist", async () => {
    const host = new HeadlessHost(makeProject());
    const result = await executeTool(
      "create_text_clip",
      {
        clip: { text: "hi", startTime: 0, duration: 3, behindSubject: true },
      },
      host,
    );
    expect(result.ok).toBe(true);
    const clips = textClips(host.getProject());
    expect(clips).toHaveLength(1);
    expect(clips[0].behindSubject).toBeUndefined();
  });
});

describe("action catalog boundary", () => {
  it("text overlay actions are registered", () => {
    const types = listRegisteredActionTypes();
    expect(types).toEqual(expect.arrayContaining(["text/create", "text/update", "text/remove"]));
  });

  it("no action exists for filter presets, segmentation, mattes, reframing or LUTs", () => {
    const types = listRegisteredActionTypes();
    const offenders = types.filter((t) =>
      /preset|segment|matte|behind|reframe|lut/i.test(t),
    );
    expect(offenders).toEqual([]);
  });

  it("execute_action rejects an invented preset-apply action", async () => {
    const host = new HeadlessHost(makeProject());
    const result = await executeTool(
      "execute_action",
      { type: "clip/applyFilterPreset", params: { clipId: "c1", presetId: "color-bw-crushed" } },
      host,
    );
    expect(result.ok).toBe(false);
  });
});
