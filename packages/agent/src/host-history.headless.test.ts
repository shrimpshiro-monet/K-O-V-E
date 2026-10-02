import { ActionExecutor } from "@kove-advanced/core/actions/action-executor";
import { ActionHistory } from "@kove-advanced/core/actions/action-history";
import type { Action } from "@kove-advanced/core/types/actions";
import { describe, it, expect } from "vitest";
import { HeadlessHost } from "./headless-host";
import { describeHistoryContract } from "./host-history-contract";
import { makeEmptyProject } from "./test-fixtures";

describeHistoryContract("HeadlessHost", () => {
  const project = makeEmptyProject();
  const history = new ActionHistory();
  const host = new HeadlessHost(project, { history });
  // A second executor over the SAME project + history stands in for the UI.
  const humanExecutor = new ActionExecutor(history);
  let id = 0;
  return {
    host,
    trackCount: () => host.getProject().timeline.tracks.length,
    humanAddTrack: async () => {
      const r = await humanExecutor.execute(
        { type: "track/add", id: `human-${++id}`, timestamp: Date.now(), params: { trackType: "video" } } as Action,
        project,
      );
      expect(r.success).toBe(true);
    },
  };
});

describe("HeadlessHost history specifics", () => {
  it("invalidates checkpoints when a transaction is rolled back (history cleared)", async () => {
    const host = new HeadlessHost(makeEmptyProject());
    const cp = host.historyControl.createCheckpoint("before turn");
    const txn = host.beginTransaction("turn");
    await host.applyAction({ type: "track/add", id: "x1", timestamp: 1, params: { trackType: "video" } } as Action);
    await host.rollbackTransaction(txn);
    const res = await host.historyControl.restoreCheckpoint(cp.id);
    expect(res.ok).toBe(false);
    expect(res.code).toBe("CHECKPOINT_NOT_FOUND");
  });
});

describe("HeadlessHost restore verification", () => {
  it("reports verified:false when something changed outside the undo history", async () => {
    const project = makeEmptyProject();
    const host = new HeadlessHost(project);
    const cp = host.historyControl.createCheckpoint();
    await host.applyAction({ type: "track/add", id: "v1", timestamp: 1, params: { trackType: "video" } } as Action);
    // A mutation that bypasses ActionHistory (e.g. a direct store write).
    (project as unknown as { name: string }).name = "sneaky rename";
    const res = await host.historyControl.restoreCheckpoint(cp.id);
    expect(res.ok).toBe(true);
    expect(res.verified).toBe(false);
    expect(res.warnings.join(" ")).toMatch(/fingerprint/);
  });
});
