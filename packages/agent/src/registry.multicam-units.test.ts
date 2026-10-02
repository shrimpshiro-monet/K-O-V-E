import { describe, expect, it, vi } from "vitest";
import type { EditingHost, MulticamHostBridge } from "./host";
import { executeTool } from "./executor";
import { HeadlessHost } from "./headless-host";
import { makeEmptyProject } from "./test-fixtures";
import { resolveMs, resolveRange, withSecondFields } from "./multicam-units";

function bridge(overrides: Partial<MulticamHostBridge> = {}): MulticamHostBridge {
  return {
    getManifest: vi.fn(),
    getActivityMap: vi.fn(async () => ({ windowMs: 50, duration: 10, points: [{ startTime: 0, endTime: 0.05 }] })),
    getTranscript: vi.fn(async () => ({ p1: [{ startMs: 1500, endMs: 2500, text: "hi" }] })),
    setEditPolicy: vi.fn(async (_g, policy) => ({ policy, summary: { minShotMs: 1800 } })),
    annotateSegment: vi.fn(async (input) => ({ annotation: input })),
    getEditSummary: vi.fn(async () => ({ policy: { minShotMs: 1800, cutLeadMs: 120 } })),
    overrideCut: vi.fn(async () => ({ cuts: 2 })),
    previewFrame: vi.fn(async () => ({ ok: true, data: { dataUrl: "data:image/png;base64,AA==" } })),
    ...overrides,
  } as MulticamHostBridge;
}
const asHost = (multicam: MulticamHostBridge, extra: Partial<EditingHost> = {}) =>
  ({ multicam, ...extra }) as unknown as EditingHost;

describe("resolveMs / resolveRange", () => {
  it("converts seconds to ms without float drift", () => {
    expect(resolveMs({ startTime: 1.005 }, { sec: "startTime", ms: "startMs" }).ms).toBe(1005);
    expect(resolveMs({ startTime: 0.35 }, { sec: "startTime", ms: "startMs" }).ms).toBe(350);
  });
  it("warns on the deprecated alias and still honours it", () => {
    const r = resolveMs({ startMs: 250 }, { sec: "startTime", ms: "startMs" });
    expect(r.ms).toBe(250);
    expect(r.warnings[0]).toMatch(/'startMs' is deprecated.*'startTime'/);
  });
  it("accepts both when they agree and rejects when they conflict", () => {
    const agree = resolveMs({ startTime: 1.5, startMs: 1500 }, { sec: "startTime", ms: "startMs" });
    expect(agree.error).toBeUndefined();
    const clash = resolveMs({ startTime: 1.5, startMs: 150 }, { sec: "startTime", ms: "startMs" });
    expect(clash.error?.error?.code).toBe("INVALID_PARAMS");
    expect(clash.error?.error?.suggestedFix).toMatch(/startTime/);
  });
  it("rejects non-numbers (no string coercion yet)", () => {
    expect(resolveMs({ startTime: "5" }, { sec: "startTime", ms: "startMs" }).error).toBeDefined();
  });
  it("validates the range", () => {
    expect(resolveRange({ startTime: 5, endTime: 5 }, "X").error).toBeDefined();
    expect(resolveRange({ startTime: -1 }, "X").error).toBeDefined();
    expect(resolveRange({ startTime: 1 }, "X", { required: true }).error).toBeDefined();
    expect(resolveRange({}, "X").error).toBeUndefined();
  });
});

describe("withSecondFields", () => {
  it("adds seconds siblings, keeps Ms, never overwrites, skips non-plain objects", () => {
    const typed = new Float32Array(2);
    const out = withSecondFields({
      startMs: 1500, endMs: 2500, windowMs: 50, minShotMs: 1800, durationMs: 4000,
      time: 7, timeMs: 9000, typed, nested: [{ cutLeadMs: 120 }],
    });
    expect(out).toMatchObject({
      startMs: 1500, startTime: 1.5, endTime: 2.5, windowDuration: 0.05,
      minShotDuration: 1.8, duration: 4, time: 7, // existing sibling untouched
    });
    expect(out.nested[0]).toMatchObject({ cutLeadMs: 120, cutLeadDuration: 0.12 });
    expect(out.typed).toBe(typed);
  });
});

describe("multicam tools: seconds params, deprecated ms aliases", () => {
  it("get_transcript: startTime/endTime reach the bridge as ms, output gains seconds, no warning", async () => {
    const multicam = bridge();
    const r = await executeTool("get_transcript", { groupId: "g1", startTime: 1, endTime: 3 }, asHost(multicam));
    expect(r.ok).toBe(true);
    expect(multicam.getTranscript).toHaveBeenCalledWith("g1", { startMs: 1000, endMs: 3000 });
    expect(r.warnings).toBeUndefined();
    const seg = (r.data as { p1: Array<Record<string, number>> }).p1[0]!;
    expect(seg).toMatchObject({ startMs: 1500, endMs: 2500, startTime: 1.5, endTime: 2.5 });
  });

  it("get_transcript / get_activity_map: Ms alias still works and warns", async () => {
    const multicam = bridge();
    const t = await executeTool("get_transcript", { groupId: "g1", startMs: 1000 }, asHost(multicam));
    expect(t.ok).toBe(true);
    expect(t.warnings?.[0]).toMatch(/startMs.*deprecated/);
    const a = await executeTool("get_activity_map", { groupId: "g1", startMs: 0, endMs: 500 }, asHost(multicam));
    expect(a.warnings).toHaveLength(2);
    expect(a.data).toMatchObject({ windowMs: 50, windowDuration: 0.05 });
  });

  it("rejects conflicting old/new values before calling the host", async () => {
    const multicam = bridge();
    const r = await executeTool("get_activity_map", { groupId: "g1", startTime: 2, startMs: 200 }, asHost(multicam));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("INVALID_PARAMS");
    expect(multicam.getActivityMap).not.toHaveBeenCalled();
  });

  it("annotate_segment: seconds, ms alias, and missing range", async () => {
    const multicam = bridge();
    const host = asHost(multicam);
    const sec = await executeTool("annotate_segment", { groupId: "g1", startTime: 1, endTime: 2, note: "n" }, host);
    expect(sec.ok).toBe(true);
    expect(multicam.annotateSegment).toHaveBeenCalledWith({ groupId: "g1", startMs: 1000, endMs: 2000, note: "n" });
    const old = await executeTool("annotate_segment", { groupId: "g1", startMs: 1000, endMs: 2000, note: "n" }, host);
    expect(old.warnings).toHaveLength(2);
    const missing = await executeTool("annotate_segment", { groupId: "g1", note: "n" }, host);
    expect(missing.ok).toBe(false);
    expect(missing.error?.suggestedFix).toMatch(/startTime/);
  });

  it("set_edit_policy: seconds → ms policy, bounds in seconds, alias warns, conflict rejects", async () => {
    const multicam = bridge();
    const host = asHost(multicam);
    const ok = await executeTool(
      "set_edit_policy",
      { groupId: "g1", commitDuration: 0.4, layoutEnterDuration: 1.2, maxLayoutChangesPerMinute: 6 },
      host,
    );
    expect(ok.ok).toBe(true);
    expect(ok.warnings).toBeUndefined();
    expect(multicam.setEditPolicy).toHaveBeenCalledWith(
      "g1",
      expect.objectContaining({ commitMs: 400, layoutEnterMs: 1200, maxLayoutChangesPerMinute: 6 }),
    );
    expect(ok.data).toMatchObject({ summary: { minShotMs: 1800, minShotDuration: 1.8 } });

    const tooBig = await executeTool("set_edit_policy", { groupId: "g1", commitDuration: 9 }, host);
    expect(tooBig.ok).toBe(false);
    expect(tooBig.error?.message).toMatch(/commitDuration must be between 0 and 5 seconds/);

    const old = await executeTool("set_edit_policy", { groupId: "g1", minLayoutLifeMs: 1000 }, host);
    expect(old.ok).toBe(true);
    expect(old.warnings?.[0]).toMatch(/minLayoutLifeMs.*minLayoutLifeDuration/);

    const clash = await executeTool("set_edit_policy", { groupId: "g1", commitDuration: 1, commitMs: 400 }, host);
    expect(clash.ok).toBe(false);
    expect(clash.error?.code).toBe("INVALID_PARAMS");
  });

  it("override_cut: delta in seconds, deltaMs alias, bounds", async () => {
    const multicam = bridge();
    const host = asHost(multicam);
    const base = { groupId: "g1", switchId: "s1", operation: "nudge" };
    expect((await executeTool("override_cut", { ...base, delta: -0.25 }, host)).ok).toBe(true);
    expect(multicam.overrideCut).toHaveBeenLastCalledWith(expect.objectContaining({ deltaMs: -250 }));
    const old = await executeTool("override_cut", { ...base, deltaMs: 500 }, host);
    expect(old.warnings?.[0]).toMatch(/deltaMs.*delta/);
    const bad = await executeTool("override_cut", { ...base, delta: 3 }, host);
    expect(bad.ok).toBe(false);
    expect(bad.error?.suggestedFix).toMatch(/SECONDS/);
    expect((await executeTool("override_cut", { ...base, delta: 1, deltaMs: 5 }, host)).ok).toBe(false);
  });
});

describe("preview_frame honesty", () => {
  it("returns UNSUPPORTED_HOST when the bridge says so", async () => {
    const multicam = bridge({ previewFrame: vi.fn(async () => ({ ok: false, code: "unsupported_host" as const, error: "x" })) });
    const r = await executeTool("preview_frame", { groupId: "g1", time: 1 }, asHost(multicam));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("UNSUPPORTED_HOST");
    expect(r.error?.suggestedFix).toBeTruthy();
    expect(r.image).toBeUndefined();
  });
  it("does not call the bridge when features say it cannot render", async () => {
    const multicam = bridge();
    const host = asHost(multicam, { features: () => ({ renderMulticamPreview: false }) as never });
    const r = await executeTool("preview_frame", { groupId: "g1", time: 1 }, host);
    expect(r.error?.code).toBe("UNSUPPORTED_HOST");
    expect(multicam.previewFrame).not.toHaveBeenCalled();
  });
  it("returns UNSUPPORTED_HOST with no multicam bridge", async () => {
    const r = await executeTool("preview_frame", { groupId: "g1", time: 1 }, {} as unknown as EditingHost);
    expect(r.error?.code).toBe("UNSUPPORTED_HOST");
  });
  it("converts time (seconds) to ms for a host that can render", async () => {
    const multicam = bridge();
    const r = await executeTool("preview_frame", { groupId: "g1", time: 2.5 }, asHost(multicam));
    expect(r.ok).toBe(true);
    expect(multicam.previewFrame).toHaveBeenCalledWith("g1", 2500);
  });
});

describe("get_capabilities host features", () => {
  it("HeadlessHost declares that it cannot render timeline or multicam frames", async () => {
    const host = new HeadlessHost(makeEmptyProject());
    const r = await executeTool("get_capabilities", {}, host);
    expect(r.ok).toBe(true);
    expect((r.data as { host: Record<string, boolean> }).host).toMatchObject({
      renderTimelineFrame: false,
      renderMulticamPreview: false,
      checkpoints: true,
    });
  });
});

describe("warnings reach the model", () => {
  it("buildToolResultContent includes warnings only when present", async () => {
    const { buildToolResultContent } = await import("./loop");
    const withW = JSON.parse(buildToolResultContent({ ok: true, summary: "s", warnings: ["w"] }) as string);
    expect(withW.warnings).toEqual(["w"]);
    const without = JSON.parse(buildToolResultContent({ ok: true, summary: "s" }) as string);
    expect("warnings" in without).toBe(false);
  });
});
