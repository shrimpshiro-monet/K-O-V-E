import { describe, it, expect, beforeEach } from "vitest";
import type { Action } from "@kove-advanced/core/types/actions";
import type { EditingHost } from "./host";
import { executeTool } from "./executor";

/**
 * Shared contract for EditingHost.historyControl. Every host runs this exact
 * suite (HeadlessHost in packages/agent, LiveEditorHost in apps/web), so the
 * two cannot drift apart.
 */
export interface HistoryContractHarness {
  readonly host: EditingHost;
  /** Apply an edit the way the human UI would (NOT through the agent host path). */
  humanAddTrack(): Promise<void>;
  trackCount(): number;
}

let n = 0;
const addTrack = (host: EditingHost): Promise<{ success: boolean }> =>
  host.applyAction({
    type: "track/add",
    id: `contract-${++n}`,
    timestamp: Date.now(),
    params: { trackType: "video" },
  } as Action);

export function describeHistoryContract(
  label: string,
  makeHarness: () => Promise<HistoryContractHarness> | HistoryContractHarness,
): void {
  describe(`${label}: historyControl contract`, () => {
    let h: HistoryContractHarness;
    let base: number;
    beforeEach(async () => {
      h = await makeHarness();
      base = h.trackCount();
    });

    it("restores a checkpoint, undoing every agent edit after it", async () => {
      const hc = h.host.historyControl;
      await addTrack(h.host);
      const cp = hc.createCheckpoint("after one track");
      await addTrack(h.host);
      await addTrack(h.host);
      expect(h.trackCount()).toBe(base + 3);

      const res = await hc.restoreCheckpoint(cp.id);
      expect(res.ok).toBe(true);
      expect(res.verified).toBe(true);
      expect(h.trackCount()).toBe(base + 1);
    });

    it("stops exactly at the checkpoint even inside an open transaction group", async () => {
      const hc = h.host.historyControl;
      const txn = h.host.beginTransaction("turn");
      await addTrack(h.host);
      const cp = hc.createCheckpoint("mid-turn");
      await addTrack(h.host);
      await addTrack(h.host);
      const res = await hc.restoreCheckpoint(cp.id);
      expect(res.ok).toBe(true);
      expect(h.trackCount()).toBe(base + 1); // the pre-checkpoint edit of the same turn survives
      h.host.commitTransaction(txn, "turn");
    });

    it("lists checkpoints and drops those newer than a restored one", async () => {
      const hc = h.host.historyControl;
      const a = hc.createCheckpoint("a");
      await addTrack(h.host);
      const b = hc.createCheckpoint("b");
      await addTrack(h.host);
      expect(hc.listCheckpoints().map((c) => c.id)).toEqual([a.id, b.id]);

      expect((await hc.restoreCheckpoint(a.id)).ok).toBe(true);
      expect(hc.listCheckpoints().map((c) => c.id)).toEqual([a.id]);
      const gone = await hc.restoreCheckpoint(b.id);
      expect(gone.ok).toBe(false);
      expect(gone.code).toBe("CHECKPOINT_NOT_FOUND");
      expect(gone.suggestedFix).toMatch(/list_checkpoints/);
    });

    it("redo re-applies a restore, and a new edit invalidates redo", async () => {
      const hc = h.host.historyControl;
      const cp = hc.createCheckpoint();
      await addTrack(h.host);
      await hc.restoreCheckpoint(cp.id);
      expect(h.trackCount()).toBe(base);

      expect((await hc.redo()).ok).toBe(true);
      expect(h.trackCount()).toBe(base + 1);

      await hc.undo();
      await addTrack(h.host);
      const r = await hc.redo();
      expect(r.ok).toBe(false);
      expect(r.code).toBe("NOTHING_TO_REDO");
    });

    it("refuses to restore over user edits and leaves the project untouched", async () => {
      const hc = h.host.historyControl;
      const cp = hc.createCheckpoint("before");
      await addTrack(h.host); // agent
      await h.humanAddTrack(); // user
      expect(h.trackCount()).toBe(base + 2);

      const res = await hc.restoreCheckpoint(cp.id);
      expect(res.ok).toBe(false);
      expect(res.code).toBe("HUMAN_EDITS_PRESENT");
      expect(res.suggestedFix).toBeTruthy();
      expect(h.trackCount()).toBe(base + 2);

      const forced = await hc.restoreCheckpoint(cp.id, { force: true });
      expect(forced.ok).toBe(true);
      expect(forced.warnings.join(" ")).toMatch(/user edits/);
      expect(h.trackCount()).toBe(base);
    });

    it("detects a user edit even when it happened before the agent's next edit", async () => {
      const hc = h.host.historyControl;
      const cp = hc.createCheckpoint();
      await h.humanAddTrack();
      await addTrack(h.host); // agent edits again afterwards
      const res = await hc.restoreCheckpoint(cp.id);
      expect(res.ok).toBe(false);
      expect(res.code).toBe("HUMAN_EDITS_PRESENT");
    });

    it("agent undo reverts only the agent's own step", async () => {
      const hc = h.host.historyControl;
      await addTrack(h.host);
      expect(h.trackCount()).toBe(base + 1);
      expect((await hc.undo()).ok).toBe(true);
      expect(h.trackCount()).toBe(base);
    });

    it("agent undo refuses to revert a user edit", async () => {
      const hc = h.host.historyControl;
      await addTrack(h.host);
      await h.humanAddTrack();
      const res = await hc.undo();
      expect(res.ok).toBe(false);
      expect(res.code).toBe("HUMAN_EDITS_PRESENT");
      expect(h.trackCount()).toBe(base + 2);
      expect((await hc.undo({ force: true })).ok).toBe(true);
      expect(h.trackCount()).toBe(base + 1);
    });

    it("agent undo refuses when the only history is the user's", async () => {
      await h.humanAddTrack();
      const res = await h.host.historyControl.undo();
      expect(res.ok).toBe(false);
      expect(res.code).toBe("HUMAN_EDITS_PRESENT");
      expect(h.trackCount()).toBe(base + 1);
    });

    it("agent undo does not walk past its own work into earlier user edits", async () => {
      const hc = h.host.historyControl;
      await h.humanAddTrack();
      await addTrack(h.host);
      expect((await hc.undo()).ok).toBe(true);
      const again = await hc.undo();
      expect(again.ok).toBe(false);
      expect(again.code).toBe("HUMAN_EDITS_PRESENT");
      expect(h.trackCount()).toBe(base + 1);
    });

    it("reports nothing to undo / redo on a clean history", async () => {
      const hc = h.host.historyControl;
      expect((await hc.undo()).code).toBe("NOTHING_TO_UNDO");
      expect((await hc.redo()).code).toBe("NOTHING_TO_REDO");
    });

    it("revision changes when state changes and is stable otherwise", async () => {
      const hc = h.host.historyControl;
      const r0 = hc.revision();
      expect(hc.revision()).toBe(r0);
      await addTrack(h.host);
      const r1 = hc.revision();
      expect(r1).toBeGreaterThan(r0);
      expect(hc.revision()).toBe(r1);
      await h.humanAddTrack();
      expect(hc.revision()).toBeGreaterThan(r1);
    });

    describe("tools", () => {
      it("create_checkpoint → restore_checkpoint round-trips through executeTool", async () => {
        const created = await executeTool("create_checkpoint", { label: "t" }, h.host);
        expect(created.ok).toBe(true);
        const id = (created.data as { checkpoint: { id: string } }).checkpoint.id;
        await addTrack(h.host);

        const listed = await executeTool("list_checkpoints", {}, h.host);
        expect((listed.data as { checkpoints: unknown[] }).checkpoints).toHaveLength(1);

        const restored = await executeTool("restore_checkpoint", { checkpointId: id }, h.host);
        expect(restored.ok).toBe(true);
        expect(h.trackCount()).toBe(base);
      });

      it("rejects unknown params with a suggestedFix (no force for the agent)", async () => {
        const created = await executeTool("create_checkpoint", {}, h.host);
        const id = (created.data as { checkpoint: { id: string } }).checkpoint.id;
        const res = await executeTool("restore_checkpoint", { checkpointId: id, force: true }, h.host);
        expect(res.ok).toBe(false);
        expect(res.error?.code).toBe("INVALID_PARAMS");
        expect(res.error?.suggestedFix).toMatch(/Remove 'force'/);

        const missing = await executeTool("restore_checkpoint", {}, h.host);
        expect(missing.error?.code).toBe("INVALID_PARAMS");
      });

      it("surfaces HUMAN_EDITS_PRESENT with suggestedFix from restore_checkpoint", async () => {
        const created = await executeTool("create_checkpoint", {}, h.host);
        const id = (created.data as { checkpoint: { id: string } }).checkpoint.id;
        await h.humanAddTrack();
        const res = await executeTool("restore_checkpoint", { checkpointId: id }, h.host);
        expect(res.ok).toBe(false);
        expect(res.error?.code).toBe("HUMAN_EDITS_PRESENT");
        expect(res.error?.suggestedFix).toBeTruthy();
      });
    });
  });
}
