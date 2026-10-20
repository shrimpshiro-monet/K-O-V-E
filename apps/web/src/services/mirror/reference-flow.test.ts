import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReferenceProfile } from "@kove-advanced/core/mirror/reference-profile";

const h = vi.hoisted(() => ({
  executeTool: vi.fn(),
  sampleVideoStats: vi.fn(),
  allocateSourceRanges: vi.fn(),
}));

vi.mock("@kove-advanced/agent", () => ({ executeTool: h.executeTool }));
vi.mock("../agent/host-singleton", () => ({
  getLiveEditorHost: () => ({ id: "host" }),
  runExclusive: (fn: () => unknown) => fn(),
}));
vi.mock("./extract-reference", () => ({
  extractReference: vi.fn(),
  sampleVideoStats: h.sampleVideoStats,
}));
vi.mock("./enrich-reference-audio", () => ({ enrichReferenceWithAudio: vi.fn() }));
vi.mock("@kove-advanced/core/mirror/allocate-shots", () => ({
  allocateSourceRanges: h.allocateSourceRanges,
}));

import { applyReferenceStructure, attachReferenceProfile } from "./reference-flow";

const profile = {
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
} as unknown as ReferenceProfile;

describe("reference flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.allocateSourceRanges.mockReturnValue([
      { mediaId: "m1", inPoint: 0, outPoint: 2 },
      { mediaId: "m1", inPoint: 2, outPoint: 4 },
    ]);
    h.sampleVideoStats.mockResolvedValue({ l: 50, a: 2, b: -3 });
  });

  it("rebuilds the source footage with the measured structure", async () => {
    h.executeTool.mockResolvedValue({
      ok: true,
      summary: "Applied 2 shots",
      data: { shotItemIds: ["clip-1", "clip-2"] },
    });

    const result = await applyReferenceStructure(profile, [
      { id: "m1", name: "source.mp4", duration: 12, blob: new Blob(["x"]) },
    ]);

    expect(h.executeTool).toHaveBeenCalledTimes(1);
    const [tool, args] = h.executeTool.mock.calls[0] as [
      string,
      { userMediaIds: string[]; targetStats: unknown[] },
    ];
    expect(tool).toBe("mirror_reference_1to1");
    expect(args.userMediaIds).toEqual(["m1"]);
    expect(args.targetStats).toHaveLength(2);
    expect(result.shotItemIds).toEqual(["clip-1", "clip-2"]);
  });

  it("fails loudly when the source footage is not available locally", async () => {
    await expect(
      applyReferenceStructure(profile, [
        { id: "m1", name: "source.mp4", duration: 12, blob: null },
      ]),
    ).rejects.toThrow(/not available locally/);
    expect(h.executeTool).not.toHaveBeenCalled();
  });

  it("attaches the EditDNA without touching the timeline", async () => {
    h.executeTool.mockResolvedValue({ ok: true, summary: "ok" });

    await attachReferenceProfile(profile);

    expect(h.executeTool).toHaveBeenCalledWith(
      "execute_action",
      { type: "project/setMirrorProfile", params: { profile } },
      expect.anything(),
    );
  });
});
