import { describe, expect, it } from "vitest";
import type { Project } from "@kove-advanced/core/types/project";
import { buildSystemPrompt } from "@kove-advanced/agent";
import type { EditingHost } from "@kove-advanced/agent";
import { describeEditorContext } from "./editor-context";
import type { EditorContextSnapshot } from "./editor-context";

function makeProject(): Project {
  const clipAfterSplit = {
    id: "clip-2",
    mediaId: "m1",
    trackId: "t1",
    startTime: 2,
    duration: 4,
    inPoint: 2,
    outPoint: 6,
    speed: 1,
    effects: [
      { id: "fx-1", type: "brightness", params: { amount: 0.2 }, enabled: true },
      { id: "fx-2", type: "blur", params: {}, enabled: false },
    ],
    audioEffects: [],
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      anchor: { x: 0.5, y: 0.5 },
      rotation: 0,
      opacity: 1,
    },
    volume: 1,
    keyframes: [],
  };
  return {
    id: "p1",
    name: "Context Test",
    createdAt: 0,
    modifiedAt: 0,
    settings: {
      width: 1920,
      height: 1080,
      frameRate: 30,
      sampleRate: 48000,
      channels: 2,
    },
    timeline: {
      duration: 6,
      subtitles: [],
      markers: [],
      tracks: [
        {
          id: "t1",
          type: "video",
          name: "Video 1",
          clips: [clipAfterSplit],
          transitions: [],
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
        },
      ],
    },
    mediaLibrary: {
      items: [
        {
          id: "m1",
          name: "captain price take 2.mp4",
          type: "video",
          source: { kind: "import" },
          metadata: { duration: 6, width: 1920, height: 1080 },
          addedAt: 0,
        },
      ],
    },
    textClips: [
      {
        id: "text-1",
        trackId: "t1",
        startTime: 2.5,
        duration: 5,
        text: "HELLO FROM THE USER",
        style: {},
        transform: clipAfterSplit.transform,
        keyframes: [],
        effects: [
          { id: "txt-fx-1", type: "dropShadow", params: {}, enabled: true },
        ],
      },
    ],
  } as unknown as Project;
}

function snapshot(
  overrides: Partial<EditorContextSnapshot> = {},
): EditorContextSnapshot {
  return {
    playheadSec: 2.5,
    pixelsPerSecond: 50,
    isScrubbing: false,
    timelineDurationSec: 6,
    selectedItems: [],
    project: makeProject(),
    ...overrides,
  };
}

describe("describeEditorContext", () => {
  it("reports the playhead even with nothing selected", () => {
    const text = describeEditorContext(snapshot({ playheadSec: 3.25 }));
    expect(text).toContain("playheadSec: 3.250");
    expect(text).toContain("timelineDurationSec: 6.000");
    expect(text).toContain("- selection: none");
  });

  it("tells the model to resolve 'here' against the playhead", () => {
    const text = describeEditorContext(snapshot());
    expect(text).toMatch(/here/i);
    expect(text).toContain("playheadSec");
  });

  it("resolves a selected clip to track index, times and media name", () => {
    const text = describeEditorContext(
      snapshot({
        playheadSec: 2.5,
        selectedItems: [{ type: "clip", id: "clip-2", trackId: "t1" }],
      }),
    );
    expect(text).toContain('type=clip id="clip-2"');
    expect(text).toContain("trackIndex=0");
    expect(text).toContain('trackId="t1"');
    expect(text).toContain("startSec=2.000");
    expect(text).toContain("endSec=6.000");
    expect(text).toContain('mediaName="captain price take 2.mp4"');
  });

  it("lists the effects on the selected clip so the model can target them by id", () => {
    const text = describeEditorContext(
      snapshot({
        selectedItems: [{ type: "clip", id: "clip-2", trackId: "t1" }],
      }),
    );
    expect(text).toContain('{id="fx-1" type=brightness enabled=true}');
    expect(text).toContain('{id="fx-2" type=blur enabled=false}');
  });

  it("resolves a selected text clip, including its quoted content and effects", () => {
    const text = describeEditorContext(
      snapshot({
        selectedItems: [{ type: "text-clip", id: "text-1", trackId: "t1" }],
      }),
    );
    expect(text).toContain('type=text-clip id="text-1"');
    expect(text).toContain('text="HELLO FROM THE USER"');
    expect(text).toContain("startSec=2.500");
    expect(text).toContain('{id="txt-fx-1" type=dropShadow enabled=true}');
  });

  it("flags a stale selection instead of silently dropping it", () => {
    const text = describeEditorContext(
      snapshot({
        selectedItems: [{ type: "clip", id: "clip-that-was-split" }],
      }),
    );
    expect(text).toContain("no longer on the timeline");
  });

  it("describes a selected track with its clip count", () => {
    const text = describeEditorContext(
      snapshot({
        selectedItems: [{ type: "track", id: "t1" }],
      }),
    );
    expect(text).toContain('type=track id="t1"');
    expect(text).toContain("trackIndex=0");
    expect(text).toContain("clipCount=1");
  });

  it("marks scrubbing state so the model can wait rather than act mid-drag", () => {
    expect(describeEditorContext(snapshot({ isScrubbing: true }))).toContain(
      "scrubbing: yes",
    );
    expect(describeEditorContext(snapshot({ isScrubbing: false }))).toContain(
      "scrubbing: no",
    );
  });

  it("escapes quotes inside text content", () => {
    const project = makeProject();
    const baseTransform = (
      project.textClips as unknown as Array<{
        transform: Record<string, unknown>;
      }>
    )[0].transform;
    const mutated = {
      ...project,
      textClips: [
        {
          id: "text-q",
          trackId: "t1",
          startTime: 0,
          duration: 1,
          text: 'say "hi" \\ now',
          style: {},
          transform: baseTransform,
          keyframes: [],
        },
      ],
    } as unknown as Project;
    const text = describeEditorContext(
      snapshot({
        project: mutated,
        selectedItems: [{ type: "text-clip", id: "text-q" }],
      }),
    );
    expect(text).toContain('text="say \\"hi\\" \\\\ now"');
  });
});

describe("buildSystemPrompt with editorContext", () => {
  it("appends the live UI block when provided", () => {
    const project = makeProject();
    const host = {
      getProject: () => project,
    } as unknown as EditingHost;
    const context = describeEditorContext(
      snapshot({
        selectedItems: [{ type: "clip", id: "clip-2", trackId: "t1" }],
      }),
    );
    const prompt = buildSystemPrompt(host, undefined, context);
    expect(prompt).toContain("## Editor context");
    expect(prompt).toContain("playheadSec: 2.500");
    expect(prompt).toContain('type=clip id="clip-2"');
  });

  it("omits the block entirely for headless callers", () => {
    const project = makeProject();
    const host = {
      getProject: () => project,
    } as unknown as EditingHost;
    const prompt = buildSystemPrompt(host);
    expect(prompt).not.toContain("## Editor context");
  });
});
