import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "@playwright/test";
import { describe, it, expect } from "vitest";
import type { Project } from "@kove-advanced/core/types/project";
import { ssim } from "@kove-advanced/agent/director/mirror/ssim";
import { mirrorRefine } from "@kove-advanced/agent/director/mirror/mirror-refine-tool";
import { HeadlessHost } from "@kove-advanced/agent/headless-host";
import { createEmptyProject } from "./project-io";
import { createMirrorSnapshot, MirrorCompositor } from "./mirror-compositor";
import { createCompositorMirrorFrameRunner, decodeMirrorFrame } from "./mirror-frame-runner";

const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const browserPath = process.env.CHROMIUM_EXECUTABLE_PATH ?? chromium.executablePath();
const ffmpegProbe = spawnSync(ffmpeg, ["-version"], { encoding: "utf8" });
const ffmpegAbsent = (ffmpegProbe.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
const chromiumAbsent = !existsSync(browserPath);
const skipReason = ffmpegAbsent ? " (skipped: FFmpeg executable absent)" : chromiumAbsent ? " (skipped: Playwright Chromium executable absent)" : "";

function projectForImage(): Project {
  const base = createEmptyProject("FFmpeg mirror trial", { width: 64, height: 64, frameRate: 30000 / 1001 });
  return {
    ...base,
    mediaLibrary: { items: [{ id: "image", name: "Generated FFmpeg frame", type: "image", blob: null, fileHandle: null,
      thumbnailUrl: null, waveformData: null, metadata: { width: 64, height: 64, duration: 1, frameRate: 30000 / 1001, codec: "png", sampleRate: 0, channels: 0, fileSize: 0 } }] },
    timeline: { ...base.timeline, duration: 1, tracks: [{ id: "track", name: "Picture", type: "video", locked: false,
      hidden: false, muted: false, solo: false, transitions: [], clips: [{ id: "clip", mediaId: "image", trackId: "track",
        startTime: 0, duration: 1, inPoint: 0, outPoint: 1, effects: [], audioEffects: [],
        transform: { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotation: 0,
          opacity: 1, anchor: { x: 0.5, y: 0.5 } }, volume: 1, keyframes: [] }] }] },
  } as Project;
}

function runFfmpeg(args: string[]): void {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`FFmpeg fixture generation failed: ${result.stderr || result.error}`);
}

describe("Mirror Chromium VideoEngine compositor trial", () => {
  it.skipIf(ffmpegAbsent || chromiumAbsent)(`measures an FFmpeg ground-truth frame against a serialized timeline snapshot at rational FPS${skipReason}`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kove-mirror-"));
    const video = path.join(dir, "reference.mp4");
    const image = path.join(dir, "image.png");
    const compositor = new MirrorCompositor(process.env.CHROMIUM_EXECUTABLE_PATH);
    try {
      runFfmpeg(["-f", "lavfi", "-i", "testsrc2=s=64x64:r=30000/1001", "-frames:v", "3", "-pix_fmt", "yuv420p", video]);
      runFfmpeg(["-i", video, "-frames:v", "1", image]);
      const original = projectForImage();
      const snapshot = await createMirrorSnapshot(original, { image });
      expect(JSON.parse(snapshot.json).version).toBeTruthy();
      expect(JSON.parse(snapshot.json).project.mediaLibrary.items[0].blob).toBeNull();
      const frameIndex = 1;
      const timeSeconds = frameIndex * 1001 / 30000;
      const candidate = await compositor.sample(snapshot, timeSeconds);
      const repeated = await compositor.sample(snapshot, timeSeconds);
      expect(repeated.data).toEqual(candidate.data);
      expect(new Set(candidate.data).size).toBeGreaterThan(8); // not an empty/black fallback
      const runner = createCompositorMirrorFrameRunner({ referencePath: video, getProject: () => original,
        mediaPaths: { image }, ffmpegPath: ffmpeg, chromiumExecutablePath: process.env.CHROMIUM_EXECUTABLE_PATH });
      try {
        const fps = { num: 30000, den: 1001 };
        const reference = await runner.sample({ kind: "reference", frame: 0, fps });
        const rendered = await runner.sample({ kind: "timeline", frame: frameIndex, fps });
        const scoreHistory = [ssim(reference, rendered)];
        expect(scoreHistory[0]).toBeGreaterThan(0.8);
        expect(rendered.data).toEqual(candidate.data);
        const changed = { ...original, timeline: { ...original.timeline, backgroundFillMode: "color" as const,
          layoutBackgroundColor: "#ff0000", tracks: [] } };
        const changedSnapshot = await createMirrorSnapshot(changed, { image });
        expect(changedSnapshot.hash).not.toBe(snapshot.hash);
        const after = await compositor.sample(changedSnapshot, timeSeconds);
        scoreHistory.push(ssim(reference, after));
        expect(scoreHistory[1]).toBeLessThan(scoreHistory[0]!);
        // The first snapshot was not mutated by subsequent project changes.
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.mediaIds)).toBe(true);
        console.info("Mirror compositor measured trial", { frameIndices: [0, frameIndex], fps, scoreHistory });
      } finally {
        await runner.close();
      }
    } finally {
      await compositor.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it.skipIf(ffmpegAbsent || chromiumAbsent)(`runs mirror_refine trials on successive immutable compositor snapshots${skipReason}`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kove-mirror-refine-"));
    const video = path.join(dir, "reference.mp4");
    const image = path.join(dir, "image.png");
    let host: HeadlessHost;
    const hashes: string[] = [];
    try {
      runFfmpeg(["-f", "lavfi", "-i", "testsrc2=s=64x64:r=30000/1001", "-frames:v", "30", "-pix_fmt", "yuv420p", video]);
      runFfmpeg(["-i", video, "-frames:v", "1", image]);
      const base = projectForImage();
      const clips = base.timeline.tracks[0]!.clips;
      const keyed: Project = { ...base, timeline: { ...base.timeline, tracks: [{ ...base.timeline.tracks[0]!, clips: [{
        ...clips[0]!, keyframes: [
          { id: "zoom-start", property: "scale.x", time: 0, value: 1, easing: "linear" },
          { id: "zoom-end", property: "scale.x", time: 0.9, value: 1.2, easing: "linear" },
        ],
      }] }] }, mirrorProfile: { version: "kove.mirror.v2", aspectRatio: { width: 64, height: 64 },
        fps: { num: 30000, den: 1001 }, fpsSource: "user", durationFrames: 30,
        shots: [{ startFrame: 0, endFrame: 30, captionWindows: [] }], beatGridMs: [], rhythmCurve: [30] } };
      const runner = createCompositorMirrorFrameRunner({ referencePath: video, getProject: () => host.getProject(),
        mediaPaths: { image }, ffmpegPath: ffmpeg, chromiumExecutablePath: process.env.CHROMIUM_EXECUTABLE_PATH });
      host = new HeadlessHost(keyed, { mirrorFrameRunner: async (request) => {
        if (request.kind === "timeline") hashes.push((await createMirrorSnapshot(host.getProject(), { image })).hash);
        return runner.sample(request);
      } });
      try {
        const result = await mirrorRefine(host, ["clip"], { sampleCount: 1, iterations: 1, targetScore: 1, seed: 7 });
        expect(result.trials).toBe(2);
        expect(result.history).toHaveLength(2);
        expect(result.history.every((score) => Number.isFinite(score) && score >= 0 && score <= 1)).toBe(true);
        expect(hashes).toHaveLength(2);
        expect(hashes[0]).not.toBe(hashes[1]);
        console.info("Measured mirror_refine", { frameIndices: result.sampleFrames, fps: result.fps, scoreHistory: result.history, snapshotHashes: hashes });
      } finally {
        await runner.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it.skipIf(ffmpegAbsent || chromiumAbsent)(`decodes a synthetic video clip through the real timeline compositor or fails explicitly${skipReason}`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kove-mirror-video-"));
    const video = path.join(dir, "source.webm");
    const compositor = new MirrorCompositor(process.env.CHROMIUM_EXECUTABLE_PATH);
    try {
      runFfmpeg(["-f", "lavfi", "-i", "testsrc2=s=64x64:r=30000/1001", "-frames:v", "3", "-c:v", "libvpx", video]);
      const imageProject = projectForImage();
      const project: Project = { ...imageProject, mediaLibrary: { items: imageProject.mediaLibrary.items.map((item) => ({
        ...item, type: "video" as const, metadata: { ...item.metadata, codec: "vp8" },
      })) } };
      const snapshot = await createMirrorSnapshot(project, { image: video });
      const frame = await compositor.sample(snapshot, 1001 / 30000);
      expect(new Set(frame.data).size).toBeGreaterThan(8);
      const reference = await decodeMirrorFrame(video, 1, ffmpeg);
      expect(ssim(reference, frame)).toBeGreaterThan(0.8);
    } finally {
      await compositor.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
