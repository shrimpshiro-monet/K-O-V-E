import { describe, it, expect } from "vitest";
import { ActionHistory } from "./action-history";
import type { Action } from "../types/actions";

const act = (id: string, type = "transform/update"): Action => ({
  type,
  id,
  timestamp: 0,
  params: { clipId: "c1" },
});

describe("ActionHistory revision + sealGroup", () => {
  it("revision is monotonic across push/undo/redo/clear", () => {
    const h = new ActionHistory();
    const seen = [h.getRevision()];
    h.push(act("a"), act("ia"));
    seen.push(h.getRevision());
    h.undo();
    seen.push(h.getRevision());
    h.redo();
    seen.push(h.getRevision());
    h.clear();
    seen.push(h.getRevision());
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]!);
  });

  it("sealGroup prevents rapid same-target actions from sharing an auto group", () => {
    const h = new ActionHistory();
    h.push(act("a"), act("ia"));
    h.sealGroup();
    h.push(act("b"), act("ib"));
    const [first, second] = h.getHistoryEntries();
    expect(first!.groupId).toBeUndefined();
    expect(second!.groupId).toBeUndefined();
  });

  it("without sealGroup the same pair would coalesce (control)", () => {
    const h = new ActionHistory();
    h.push(act("a"), act("ia"));
    h.push(act("b"), act("ib"));
    const [first, second] = h.getHistoryEntries();
    expect(first!.groupId).toBeDefined();
    expect(first!.groupId).toBe(second!.groupId);
  });

  it("sealGroup splits an open beginGroup so undoGroup stops at the boundary", () => {
    const h = new ActionHistory();
    h.beginGroup("turn");
    h.push(act("a", "track/add"), act("ia", "track/remove"));
    h.sealGroup();
    h.push(act("b", "track/add"), act("ib", "track/remove"));
    h.endGroup();
    const undone = h.undoGroup();
    expect(undone.map((x) => x.id)).toEqual(["ib"]);
    expect(h.getUndoStackSize()).toBe(1);
  });
});
