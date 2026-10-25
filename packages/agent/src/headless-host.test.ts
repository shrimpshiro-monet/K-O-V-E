import { describe, it, expect } from "vitest";
import type { Action } from "@kove-advanced/core/types/actions";
import { HeadlessHost } from "./headless-host";
import { makeEmptyProject, makeProjectWithClip } from "./test-fixtures";

const act = (type: string, params: Record<string, unknown>): Action => ({
  type,
  id: `a-${type}`,
  timestamp: Date.now(),
  params,
});

describe("HeadlessHost", () => {
  it("applies an action to the open project", async () => {
    const host = new HeadlessHost(makeEmptyProject());
    const result = await host.applyAction(act("track/add", { trackType: "video" }));
    expect(result.success).toBe(true);
    expect(host.getProject().timeline.tracks).toHaveLength(1);
  });

  it("creates renderable text on a frontmost track with complete text styles", async () => {
    const host = new HeadlessHost(makeEmptyProject());
    const overlay = await host.createTextOverlay({
      text: "THE QUIET BEFORE",
      startSec: 0.2,
      durationSec: 2,
      style: {
        fontFamily: "Arial",
        fontSize: 38,
        fontWeight: 800,
        color: "#F7F3EA",
        align: "center",
      },
    });

    const project = host.getProject();
    const track = project.timeline.tracks[0];
    const clip = project.textClips?.find((item) => item.id === overlay.id);
    expect(track).toMatchObject({ id: overlay.trackId, type: "text", hidden: false });
    expect(clip?.style).toMatchObject({
      fontFamily: "Arial",
      fontSize: 38,
      lineHeight: 1.2,
      letterSpacing: 0,
      textAlign: "center",
    });
  });

  it("exposes the capability manifest", () => {
    const host = new HeadlessHost(makeEmptyProject());
    expect(host.capabilities().blendModes.length).toBeGreaterThan(0);
  });

  it("throws on mutation when no project is open", async () => {
    const host = new HeadlessHost(null);
    await expect(
      host.applyAction(act("track/add", { trackType: "video" })),
    ).rejects.toThrow(/No project is open/);
  });

  it("rolls a transaction back to its start, preserving prior edits", async () => {
    const host = new HeadlessHost(makeProjectWithClip());
    // a committed edit before the transaction
    await host.applyAction(act("clip/setSpeed", { clipId: "c1", speed: 2 }));
    expect(host.getProject().timeline.tracks[0].clips[0].speed).toBe(2);

    const txn = host.beginTransaction("turn");
    await host.applyAction(act("track/add", { trackType: "text" }));
    await host.applyAction(act("clip/setReverse", { clipId: "c1", reversed: true }));
    expect(host.getProject().timeline.tracks).toHaveLength(2);
    expect(host.getProject().timeline.tracks[0].clips[0].reversed).toBe(true);

    await host.rollbackTransaction(txn);

    // transaction edits reverted; the pre-transaction edit survives
    expect(host.getProject().timeline.tracks).toHaveLength(1);
    expect(host.getProject().timeline.tracks[0].clips[0].reversed ?? false).toBe(false);
    expect(host.getProject().timeline.tracks[0].clips[0].speed).toBe(2);
  });

  it("commits a transaction (edits persist)", async () => {
    const host = new HeadlessHost(makeProjectWithClip());
    const txn = host.beginTransaction("turn");
    await host.applyAction(act("clip/setSpeed", { clipId: "c1", speed: 3 }));
    host.commitTransaction(txn, "set speed");
    expect(host.getProject().timeline.tracks[0].clips[0].speed).toBe(3);
  });

  it("returns a typed failure from runJob with no job runner", async () => {
    const host = new HeadlessHost(makeEmptyProject());
    const res = await host.runJob("exportVideo", {});
    expect(res.ok).toBe(false);
  });
});
