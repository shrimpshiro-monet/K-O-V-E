import { describe, expect, it } from "vitest";
import { getTool } from "../../registry";
import { HeadlessHost } from "../../headless-host";
import { makeEmptyProject } from "../../test-fixtures";
import { applyEditDNA } from "./apply-editdna";
import { fixture } from "./mirror-fixture";
import { frameToSeconds } from "@kove-advanced/core/mirror/timebase";

function projectWithSource() {
  const project = makeEmptyProject();
  project.mediaLibrary.items.push({ id: "m1", name: "source", type: "video", blob: null, fileHandle: null, thumbnailUrl: null, waveformData: null,
    metadata: { duration: 5, width: 1920, height: 1080, frameRate: 30, codec: "h264", sampleRate: 0, channels: 0, fileSize: 1 } });
  return project;
}

describe("mirror_refine registered headless path", () => {
  it("requires real frame providers; never reports a score when missing", async () => {
    const host = new HeadlessHost(projectWithSource());
    const result = await getTool("mirror_refine")!.handler({ shotItemIds: ["a"] }, host);
    expect(result).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_HOST" } });
  });
  it("samples frames on the rational clock and returns reproducible measured SSIM", async () => {
    const seen: Array<{ kind: string; frame: number }> = [];
    let host: HeadlessHost;
    // Test frame backend emits actual pixel arrays; SSIM is computed from those
    // pixels by the production critic, never injected as a numerical score.
    const frameBackend: NonNullable<ConstructorParameters<typeof HeadlessHost>[1]>["mirrorFrameRunner"] = async ({ kind, frame, fps }) => {
      expect(frameToSeconds(frame, fps)).toBe(frame / 30);
      seen.push({ kind, frame });
      const first = host.getProject().timeline.tracks.flatMap((t) => t.clips)[0];
      const scale = kind === "reference" ? 1 : (first?.keyframes.find((kf) => kf.property === "scale.x" && kf.time > 0)?.value as number ?? 1);
      return { width: 2, height: 2, data: new Uint8Array([10, 40, 100, Math.round(160 * scale)]) };
    };
    host = new HeadlessHost(projectWithSource(), { mirrorFrameRunner: frameBackend });
    const ids = await applyEditDNA(host, fixture, ["m1"]);
    const args = { shotItemIds: ids, sampleCount: 2, iterations: 2, targetScore: 1, seed: 19 };
    const result = await getTool("mirror_refine")!.handler(args, host);
    expect(result.ok).toBe(true);
    const data = result.data as { bestSsim: number; rhythmScore: number; lpips: string; sampleFrames: number[]; trials: number };
    expect(data.bestSsim).toBeGreaterThan(0.9);
    expect(data.rhythmScore).toBe(1);
    expect(data.lpips).toBe("unavailable");
    expect(data.sampleFrames).toEqual([14, 59]);
    expect(seen.filter((sample) => sample.kind === "reference").map((sample) => sample.frame)).toEqual([14, 59]);
    expect(seen.filter((sample) => sample.kind === "timeline")).toHaveLength(data.trials * 2);
  });
  it("rolls back all trial edits when the renderer fails", async () => {
    const host = new HeadlessHost(projectWithSource(), { mirrorFrameRunner: async ({ kind }) => {
      if (kind === "timeline") throw new Error("compositor failed");
      return { width: 2, height: 2, data: new Uint8Array([0, 20, 30, 40]) };
    } });
    const ids = await applyEditDNA(host, fixture, ["m1"]);
    const before = structuredClone(host.getProject());
    const result = await getTool("mirror_refine")!.handler({ shotItemIds: ids }, host);
    expect(result.ok).toBe(false);
    expect(host.getProject()).toEqual(before);
  });
});
