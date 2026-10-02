import { describe, it, expect } from "vitest";
import type { Action } from "@kove-advanced/core";
import { describeHistoryContract } from "@kove-advanced/agent/host-history-contract";
import { useProjectStore } from "../../stores/project-store";
import { LiveEditorHost } from "./live-host";

let id = 0;

// The exact suite HeadlessHost runs (packages/agent/src/host-history.headless.test.ts).
describeHistoryContract("LiveEditorHost", () => {
  useProjectStore.getState().createNewProject();
  const host = new LiveEditorHost();
  return {
    host,
    trackCount: () => useProjectStore.getState().project.timeline.tracks.length,
    // Straight to the store, bypassing the host: this is "the user clicked".
    humanAddTrack: async () => {
      const r = await useProjectStore.getState().executeAction({
        type: "track/add",
        id: `human-${++id}`,
        timestamp: Date.now(),
        params: { trackType: "video" },
      } as Action);
      expect(r.success).toBe(true);
    },
  };
});

describe("LiveEditorHost history specifics", () => {
  it("restores a checkpoint through the live store undo path", async () => {
    useProjectStore.getState().createNewProject();
    const host = new LiveEditorHost();
    const hc = host.historyControl;
    const cp = hc.createCheckpoint("before overlay");
    const before = useProjectStore.getState().project.timeline.tracks.length;

    await host.applyAction({
      type: "track/add",
      id: "live-t",
      timestamp: Date.now(),
      params: { trackType: "video" },
    } as Action);
    const res = await hc.restoreCheckpoint(cp.id);
    expect(res.ok).toBe(true);
    expect(useProjectStore.getState().project.timeline.tracks.length).toBe(before);
  });

  it("a new project invalidates checkpoints", async () => {
    useProjectStore.getState().createNewProject();
    const host = new LiveEditorHost();
    const cp = host.historyControl.createCheckpoint();
    await host.createProject({ name: "other" });
    expect(host.historyControl.listCheckpoints()).toHaveLength(0);
    const res = await host.historyControl.restoreCheckpoint(cp.id);
    expect(res.ok).toBe(false);
    expect(res.code).toBe("CHECKPOINT_NOT_FOUND");
  });
});
