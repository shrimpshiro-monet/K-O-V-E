import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MockLLMClient, FnLLMClient } from "@kove-advanced/agent";
import type { LLMResponse, LoopMessage } from "@kove-advanced/agent";
import type { Project } from "@kove-advanced/core/types/project";
import { runHeadlessEdit, runHeadlessEditFile } from "./run";
import { createEmptyProject, loadProjectFile, saveProjectFile } from "./project-io";

const tempFiles: string[] = [];
function tmpFile(): string {
  const file = path.join(tmpdir(), `kove-advanced-run-${randomUUID()}.json`);
  tempFiles.push(file);
  return file;
}
afterEach(async () => {
  await Promise.all(tempFiles.splice(0).map((f) => rm(f, { force: true })));
});

function script(...responses: LLMResponse[]): MockLLMClient {
  return new MockLLMClient(responses);
}

describe("runHeadlessEdit", () => {
  it("performs a multi-tool editing turn against an in-memory project", async () => {
    const llm = script(
      {
        text: "Renaming and adding a track.",
        stopReason: "tool_use",
        toolUses: [
          { id: "t1", name: "rename_project", input: { name: "Edited" } },
          { id: "t2", name: "add_track", input: { trackType: "video" } },
        ],
      },
      { text: "Done.", stopReason: "end_turn", toolUses: [] },
    );

    const { project, result } = await runHeadlessEdit({
      project: createEmptyProject("Original"),
      prompt: "Rename to Edited and add a video track",
      provider: "anthropic",
      model: "mock",
      apiKey: "unused",
      llm,
    });

    expect(result.stoppedReason).toBe("end_turn");
    expect(result.committed).toBe(true);
    expect(result.toolCalls).toBe(2);
    expect(project.name).toBe("Edited");
    expect(project.timeline.tracks).toHaveLength(1);
  });

  it("rolls the project back atomically when a turn errors", async () => {
    const llm: { complete: () => Promise<LLMResponse> } = {
      complete: async () => {
        throw new Error("LLM exploded");
      },
    };
    const project = createEmptyProject("KeepMe");
    const { project: after, result } = await runHeadlessEdit({
      project,
      prompt: "do something",
      provider: "anthropic",
      model: "mock",
      apiKey: "unused",
      llm,
    });
    expect(result.stoppedReason).toBe("error");
    expect(result.committed).toBe(false);
    expect(after.name).toBe("KeepMe");
  });

  it("rebuilds the footage from the reference and tells the model to add craft on top", async () => {
    const llm = new FnLLMClient(async () => ({
      text: "Done.",
      toolUses: [],
      stopReason: "end_turn",
    }));
    const { project: after } = await runHeadlessEdit({
      project: mirrorProject(),
      prompt: "/mirror make the cuts punchier",
      provider: "anthropic",
      model: "mock",
      apiKey: "unused",
      llm,
    });

    // The structure is on the timeline before the model does anything.
    const clips = after.timeline.tracks.flatMap((track) => track.clips);
    expect(clips).toHaveLength(2);
    expect(clips.every((clip) => clip.mediaId === "video-1")).toBe(true);
    const content = userMessage(llm.calls[0]?.messages ?? []);
    expect(content).toContain("Do NOT call plan_edit");
    expect(content).toContain("REPLICATE");
  });

  it("keeps the reference as guidance only for the reference intent", async () => {
    const llm = new FnLLMClient(async () => ({
      text: "Done.",
      toolUses: [],
      stopReason: "end_turn",
    }));
    const { project: after } = await runHeadlessEdit({
      project: mirrorProject(),
      prompt: "/reference keep the vibe",
      provider: "anthropic",
      model: "mock",
      apiKey: "unused",
      llm,
    });

    expect(after.timeline.tracks.flatMap((track) => track.clips)).toHaveLength(0);
    const content = userMessage(llm.calls[0]?.messages ?? []);
    expect(content).toContain("REFERENCE");
    expect(content).toContain("plan_edit");
  });
});

/** The user message the model received. The conversation array is live, so it
 * is searched instead of read by index. */
function userMessage(messages: readonly LoopMessage[]): string {
  const message = messages.find((entry) => entry.role === "user");
  return message && "content" in message ? String(message.content) : "";
}

/** A project with source footage, a tagged reference and a measured EditDNA. */
function mirrorProject(): Project {
  const metadata = {
    duration: 12,
    width: 576,
    height: 640,
    frameRate: 30,
    codec: "vp8",
    sampleRate: 48000,
    channels: 2,
    fileSize: 1024,
    hasVideo: true,
    hasAudio: false,
  };
  return {
    ...createEmptyProject("Mirror"),
    mediaLibrary: {
      items: [
        {
          id: "video-1",
          name: "source.mp4",
          type: "video",
          fileHandle: null,
          blob: null,
          metadata,
          thumbnailUrl: null,
          waveformData: null,
        },
        {
          id: "reference-1",
          name: "reference.mp4",
          type: "video",
          analysisRole: "reference",
          fileHandle: null,
          blob: null,
          metadata,
          thumbnailUrl: null,
          waveformData: null,
        },
      ],
    },
    mirrorProfile: {
      version: "kove.mirror.v2",
      fps: { num: 30, den: 1 },
      fpsSource: "web-metadata",
      durationFrames: 60,
      aspectRatio: { width: 576, height: 640 },
      shots: [
        { startFrame: 0, endFrame: 30, captionWindows: [] },
        { startFrame: 30, endFrame: 60, captionWindows: [] },
      ],
      rhythmCurve: [30, 30],
      beatGridMs: [],
    },
  } as unknown as Project;
}

describe("runHeadlessEditFile", () => {
  it("loads a stored project, edits it, and saves the result — no app", async () => {
    const inPath = tmpFile();
    const outPath = tmpFile();
    await saveProjectFile(inPath, createEmptyProject("Stored"));

    const llm = script(
      {
        text: "Adding a track.",
        stopReason: "tool_use",
        toolUses: [{ id: "t1", name: "add_track", input: { trackType: "audio" } }],
      },
      { text: "Done.", stopReason: "end_turn", toolUses: [] },
    );

    const { result } = await runHeadlessEditFile({
      projectPath: inPath,
      outPath,
      prompt: "add an audio track",
      provider: "anthropic",
      model: "mock",
      apiKey: "unused",
      llm,
    });

    expect(result.toolCalls).toBe(1);
    const saved = await loadProjectFile(outPath);
    expect(saved.timeline.tracks).toHaveLength(1);
    expect(saved.timeline.tracks[0].type).toBe("audio");
  });

  it("does not save when the turn errors", async () => {
    const inPath = tmpFile();
    const outPath = tmpFile();
    await saveProjectFile(inPath, createEmptyProject("Errored"));
    const llm = { complete: async () => { throw new Error("boom"); } };

    const { result, saved } = await runHeadlessEditFile({
      projectPath: inPath,
      outPath,
      prompt: "do something",
      provider: "anthropic",
      model: "mock",
      apiKey: "unused",
      llm,
    });
    expect(result.stoppedReason).toBe("error");
    expect(saved).toBe(false);
    await expect(loadProjectFile(outPath)).rejects.toThrow();
  });

  it("does not save on a dry-run", async () => {
    const inPath = tmpFile();
    const outPath = tmpFile();
    await saveProjectFile(inPath, createEmptyProject("DryRun"));
    const llm = script(
      {
        text: "",
        stopReason: "tool_use",
        toolUses: [{ id: "t1", name: "add_track", input: { trackType: "video" } }],
      },
      { text: "planned", stopReason: "end_turn", toolUses: [] },
    );

    const { saved } = await runHeadlessEditFile({
      projectPath: inPath,
      outPath,
      prompt: "add a track",
      provider: "anthropic",
      model: "mock",
      apiKey: "unused",
      llm,
      dryRun: true,
    });
    expect(saved).toBe(false);
    await expect(loadProjectFile(outPath)).rejects.toThrow();
  });
});
