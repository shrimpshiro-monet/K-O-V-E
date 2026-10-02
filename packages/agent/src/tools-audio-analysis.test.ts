import { describe, expect, it, vi } from "vitest";
import { executeTool } from "./executor";
import { HeadlessHost } from "./headless-host";
import { makeProjectWithClip } from "./test-fixtures";
import { getTool } from "./registry";
import { getSchemaMismatches, resetSchemaMismatches } from "./schema-validate";
import type { AudioSamples } from "./host";
import type { Project } from "@kove-advanced/core/types/project";

const FS = 48_000;
const sine = (seconds: number, dbfs: number, freq = 1000): Float32Array => {
  const a = Math.pow(10, dbfs / 20);
  const x = new Float32Array(Math.round(seconds * FS));
  for (let i = 0; i < x.length; i++) x[i] = a * Math.sin((2 * Math.PI * freq * i) / FS);
  return x;
};
const cat = (...p: Float32Array[]): Float32Array => {
  const out = new Float32Array(p.reduce((s, x) => s + x.length, 0));
  let o = 0;
  for (const x of p) { out.set(x, o); o += x.length; }
  return out;
};

function projectWithMedia(): Project {
  const p = makeProjectWithClip();
  const hasM1 = p.mediaLibrary.items.some((m) => m.id === "m1");
  if (hasM1) return p;
  return {
    ...p,
    mediaLibrary: {
      ...p.mediaLibrary,
      items: [
        ...p.mediaLibrary.items,
        { id: "m1", name: "a.wav", type: "audio", fileHandle: null, blob: null, thumbnailUrl: null, waveformData: null, metadata: { duration: 60 } } as never,
      ],
    },
  };
}

const hostWith = (samples: AudioSamples | null, project = projectWithMedia()) => {
  const audioSource = vi.fn(async () => samples);
  return { host: new HeadlessHost(project, { audioSource }), audioSource };
};

describe("measure_loudness", () => {
  it("is a strict, read-only audio tool", () => {
    const t = getTool("measure_loudness")!;
    expect(t.strict).toBe(true);
    expect(t.readOnly).toBe(true);
    expect(t.domain).toBe("audio");
    expect(t.inputSchema.additionalProperties).toBe(false);
  });

  it("measures a media item: -23 dBFS stereo 1 kHz → -23.0 LUFS, no fabricated range", async () => {
    const x = sine(20, -23);
    const { host, audioSource } = hostWith({ channels: [x, x], sampleRate: FS });
    const r = await executeTool("measure_loudness", { mediaId: "m1" }, host);
    expect(r.ok).toBe(true);
    expect(audioSource).toHaveBeenCalledWith("m1", 0);
    const d = r.data as { loudness: { integratedLufs: number; loudnessRangeLu: number; truePeakDbtp: number }; source: { scope: string; kind: string } };
    expect(d.loudness.integratedLufs).toBeCloseTo(-23, 1);
    expect(d.loudness.loudnessRangeLu).toBeLessThan(0.5);
    expect(d.loudness.truePeakDbtp).toBeCloseTo(-23, 0);
    expect(d.source.kind).toBe("media");
    expect(d.source.scope).toMatch(/before clip effects/);
    expect(r.summary).toMatch(/-23\.0 LUFS/);
  });

  it("clipId measures only the clip's inPoint..outPoint of the source", async () => {
    // 0-5 s loud (-20), 5-10 s quiet (-40). The clip uses source 5..10.
    const x = cat(sine(5, -20), sine(5, -40));
    const project = projectWithMedia();
    const clipped = {
      ...project,
      timeline: { ...project.timeline, tracks: project.timeline.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c, inPoint: 5, outPoint: 10 })) })) },
    } as Project;
    const { host } = hostWith({ channels: [x, x], sampleRate: FS }, clipped);
    const r = await executeTool("measure_loudness", { clipId: "c1" }, host);
    expect(r.ok).toBe(true);
    const d = r.data as { loudness: { integratedLufs: number }; source: { startTime: number; endTime: number; clipId: string } };
    expect(d.source).toMatchObject({ startTime: 5, endTime: 10, clipId: "c1" });
    expect(d.loudness.integratedLufs).toBeCloseTo(-40, 1);
  });

  it("an explicit startTime/endTime range is honoured", async () => {
    const x = cat(sine(10, -20), sine(10, -40));
    const { host } = hostWith({ channels: [x, x], sampleRate: FS });
    const r = await executeTool("measure_loudness", { mediaId: "m1", startTime: 10, endTime: 20 }, host);
    expect((r.data as { loudness: { integratedLufs: number } }).loudness.integratedLufs).toBeCloseTo(-40, 1);
  });

  it("targetLufs returns the gain needed and flags true-peak overs against -1 dBTP", async () => {
    // -23 LUFS tone with a loud isolated peak → needs positive gain to reach -14 but would exceed -1 dBTP? use -30 tone
    const x = sine(10, -30);
    const { host } = hostWith({ channels: [x, x], sampleRate: FS });
    const r = await executeTool("measure_loudness", { mediaId: "m1", targetLufs: -14 }, host);
    const t = (r.data as { target: { gainToTargetDb: number; truePeakAfterGainDbtp: number; exceedsMinus1Dbtp: boolean } }).target;
    expect(t.gainToTargetDb).toBeCloseTo(16, 1);
    expect(t.truePeakAfterGainDbtp).toBeCloseTo(-14, 0);
    expect(t.exceedsMinus1Dbtp).toBe(false);
    const hot = await executeTool("measure_loudness", { mediaId: "m1", targetLufs: -0.5 }, host);
    expect((hot.data as { target: { exceedsMinus1Dbtp: boolean } }).target.exceedsMinus1Dbtp).toBe(true);
  });

  it("silence: values are null (not estimated) and there is no gain target", async () => {
    const z = new Float32Array(FS * 5);
    const { host } = hostWith({ channels: [z, z], sampleRate: FS });
    const r = await executeTool("measure_loudness", { mediaId: "m1", targetLufs: -23 }, host);
    expect(r.ok).toBe(true);
    const d = r.data as { loudness: { integratedLufs: number | null; truePeakDbtp: number | null }; target: unknown };
    expect(d.loudness.integratedLufs).toBeNull();
    expect(d.loudness.truePeakDbtp).toBeNull();
    expect(d.target).toBeNull();
    expect(r.warnings?.join()).toMatch(/not measurable/);
    expect(r.summary).toMatch(/n\/a/);
  });

  it("warns that clip speed/reverse are not applied", async () => {
    const x = sine(6, -23);
    const p = projectWithMedia();
    const fast = { ...p, timeline: { ...p.timeline, tracks: p.timeline.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c, speed: 2 })) })) } } as Project;
    const { host } = hostWith({ channels: [x, x], sampleRate: FS }, fast);
    const r = await executeTool("measure_loudness", { clipId: "c1" }, host);
    expect(r.warnings?.join()).toMatch(/speed\/reverse are not applied/);
  });

  describe("errors carry {code, message, suggestedFix}", () => {
    const check = (r: Awaited<ReturnType<typeof executeTool>>, code: string) => {
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe(code);
      expect(r.error?.suggestedFix).toBeTruthy();
    };
    it("needs exactly one of clipId / mediaId", async () => {
      const { host } = hostWith({ channels: [sine(1, -20)], sampleRate: FS });
      check(await executeTool("measure_loudness", {}, host), "INVALID_PARAMS");
      check(await executeTool("measure_loudness", { clipId: "c1", mediaId: "m1" }, host), "INVALID_PARAMS");
    });
    it("rejects unknown keys and wrong types at the schema gate (strict)", async () => {
      const { host, audioSource } = hostWith({ channels: [sine(1, -20)], sampleRate: FS });
      const typo = await executeTool("measure_loudness", { mediaId: "m1", targetLUFS: -23 }, host);
      check(typo, "INVALID_PARAMS");
      expect(typo.error?.suggestedFix).toMatch(/targetLufs/);
      check(await executeTool("measure_loudness", { mediaId: "m1", startTime: "x" }, host), "INVALID_PARAMS");
      check(await executeTool("measure_loudness", { mediaId: "m1", targetLufs: 5 }, host), "INVALID_PARAMS");
      expect(audioSource).not.toHaveBeenCalled();
    });
    it("coerces a numeric string for a number parameter and says so", async () => {
      const x = sine(10, -23);
      const { host } = hostWith({ channels: [x, x], sampleRate: FS });
      const r = await executeTool("measure_loudness", { mediaId: "m1", startTime: "2" }, host);
      expect(r.ok).toBe(true);
      expect(r.warnings?.join()).toMatch(/coerced string "2" to number 2/);
    });
    it("unknown media / clip", async () => {
      const { host } = hostWith({ channels: [sine(1, -20)], sampleRate: FS });
      check(await executeTool("measure_loudness", { mediaId: "nope" }, host), "NOT_FOUND");
      check(await executeTool("measure_loudness", { clipId: "nope" }, host), "NOT_FOUND");
    });
    it("endTime <= startTime, and a range past the end of the audio", async () => {
      const { host } = hostWith({ channels: [sine(2, -20)], sampleRate: FS });
      check(await executeTool("measure_loudness", { mediaId: "m1", startTime: 2, endTime: 1 }, host), "INVALID_PARAMS");
      check(await executeTool("measure_loudness", { mediaId: "m1", startTime: 50, endTime: 60 }, host), "INVALID_PARAMS");
    });
    it("no decodable audio", async () => {
      const { host } = hostWith(null);
      check(await executeTool("measure_loudness", { mediaId: "m1" }, host), "NO_AUDIO");
    });
    it("a host without audio decoding says UNSUPPORTED_HOST and get_capabilities reports it", async () => {
      const host = new HeadlessHost(projectWithMedia());
      check(await executeTool("measure_loudness", { mediaId: "m1" }, host), "UNSUPPORTED_HOST");
      const caps = await executeTool("get_capabilities", {}, host);
      expect((caps.data as { host: { analyzeAudio: boolean } }).host.analyzeAudio).toBe(false);
      const withSrc = hostWith({ channels: [sine(1, -20)], sampleRate: FS }).host;
      const caps2 = await executeTool("get_capabilities", {}, withSrc);
      expect((caps2.data as { host: { analyzeAudio: boolean } }).host.analyzeAudio).toBe(true);
    });
  });

  it("valid calls log no schema mismatches (strict tool, shadow log untouched)", async () => {
    resetSchemaMismatches();
    const x = sine(5, -23);
    const { host } = hostWith({ channels: [x, x], sampleRate: FS });
    await executeTool("measure_loudness", { mediaId: "m1" }, host);
    expect(getSchemaMismatches().filter((m) => m.tool === "measure_loudness")).toEqual([]);
  });
});
