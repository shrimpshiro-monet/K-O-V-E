import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Action } from "@kove-advanced/core";
import { executeTool } from "@kove-advanced/agent";
import type { EditorStateView } from "@kove-advanced/agent";
import type { MediaItem } from "@kove-advanced/core/types/project";
import { useProjectStore } from "../../stores/project-store";
import { LiveEditorHost } from "./live-host";
import { transcribeSamplesWithWordTimestamps } from "../multicam-transcription";

vi.mock("../multicam-transcription", () => ({
  transcribeSamplesWithWordTimestamps: vi.fn(),
}));

const act = (type: string, params: Record<string, unknown>): Action => ({
  type,
  id: `a-${type}`,
  timestamp: Date.now(),
  params,
});

describe("LiveEditorHost", () => {
  beforeEach(() => {
    useProjectStore.getState().createNewProject();
    vi.clearAllMocks();
  });

  it("drives the live store through the agent executor", async () => {
    const host = new LiveEditorHost();
    const before = useProjectStore.getState().project.timeline.tracks.length;

    const res = await executeTool("add_track", { trackType: "video" }, host);
    expect(res.ok).toBe(true);
    expect(useProjectStore.getState().project.timeline.tracks.length).toBe(before + 1);

    const state = (await executeTool("get_editor_state", {}, host)).data as EditorStateView;
    expect(state.trackCount).toBe(before + 1);
  });

  it("requireOpenProject throws when no project is open", () => {
    useProjectStore.setState({ hasOpenProject: false });
    const host = new LiveEditorHost();
    expect(() => host.getProject()).toThrow(/No project is open/);
  });

  it("rolls a transaction back as one unit", async () => {
    const host = new LiveEditorHost();
    const before = useProjectStore.getState().project.timeline.tracks.length;

    const txn = host.beginTransaction("turn");
    await host.applyAction(act("track/add", { trackType: "text" }));
    await host.applyAction(act("track/add", { trackType: "graphics" }));
    expect(useProjectStore.getState().project.timeline.tracks.length).toBe(before + 2);

    await host.rollbackTransaction(txn);
    expect(useProjectStore.getState().project.timeline.tracks.length).toBe(before);
  });

  it("exposes the capability manifest", () => {
    const host = new LiveEditorHost();
    expect(host.capabilities().blendModes.length).toBeGreaterThan(0);
  });

  it("transcribes only the bounded initial source window and reports truncation", async () => {
    const project = useProjectStore.getState().project;
    const media: MediaItem = {
      id: "speech-source",
      name: "speech.mp4",
      type: "video",
      fileHandle: null,
      blob: null,
      metadata: {
        duration: 120,
        width: 1920,
        height: 1080,
        frameRate: 30,
        codec: "h264",
        sampleRate: 10,
        channels: 1,
        fileSize: 1,
      },
      thumbnailUrl: null,
      waveformData: null,
    };
    useProjectStore.setState({
      project: {
        ...project,
        mediaLibrary: { ...project.mediaLibrary, items: [...project.mediaLibrary.items, media] },
      },
    });
    expect(useProjectStore.getState().getMediaItem("speech-source")).toEqual(media);
    vi.mocked(transcribeSamplesWithWordTimestamps).mockResolvedValue([
      { text: "hello", start: 0.1, end: 0.3 },
    ]);
    const audioSource = vi.fn().mockResolvedValue({
      channels: [new Float32Array(1_210).fill(0.5)],
      sampleRate: 10,
    });
    const result = await new LiveEditorHost({ audioSource }).transcribeMediaAudio("speech-source", {
      maxDurationSeconds: 120,
      timeoutMs: 1_000,
    });

    expect(audioSource).toHaveBeenCalledWith("speech-source", 0);
    expect(transcribeSamplesWithWordTimestamps).toHaveBeenCalledWith(
      expect.any(Float32Array),
      expect.objectContaining({ model: "fast", timeoutMs: 1_000 }),
    );
    const samples = vi.mocked(transcribeSamplesWithWordTimestamps).mock.calls.at(-1)?.[0];
    expect(samples).toHaveLength(1_920_000);
    expect(result).toMatchObject({
      status: "complete",
      warning: "Only the first 120s were transcribed to stay within the browser audio budget.",
    });
  });
});
