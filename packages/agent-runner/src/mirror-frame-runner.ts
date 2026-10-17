import { spawn } from "node:child_process";
import type { GrayImage } from "@kove-advanced/agent/director/mirror/ssim";
import type { EditingHost } from "@kove-advanced/agent/host";
import type { Project } from "@kove-advanced/core/types/project";
import { MirrorCompositor, createMirrorSnapshot } from "./mirror-compositor";

/** Decode an actual numbered frame as 64x64 luma. No stand-in images or scores.
 * `select` decodes through to frame N, so this is exact for CFR streams but
 * intentionally slow on long clips; callers can supply an optimized compositor.
 */
export async function decodeMirrorFrame(path: string, frame: number, ffmpegPath = "ffmpeg"): Promise<GrayImage> {
  if (!path || !Number.isSafeInteger(frame) || frame < 0) throw new Error("Invalid mirror frame request");
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let length = 0, error = "";
    const proc = spawn(ffmpegPath, ["-v", "error", "-i", path,
      "-vf", `select=eq(n\\,${frame}),scale=64:64,format=gray`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], { windowsHide: true });
    const finish = (value?: GrayImage, cause?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (cause) reject(cause); else if (value) resolve(value);
    };
    const timer = setTimeout(() => { proc.kill(); finish(undefined, new Error("Mirror frame decode timed out")); }, 60_000);
    proc.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 4096) { proc.kill(); finish(undefined, new Error("Unexpected mirror frame size")); return; }
      chunks.push(chunk);
    });
    proc.stderr.on("data", (chunk: Buffer) => { error = (error + chunk.toString()).slice(-1000); });
    proc.on("error", (cause: Error) => finish(undefined, cause));
    proc.on("close", (code) => {
      if (settled) return;
      if (code !== 0 || length !== 4096) { finish(undefined, new Error(`No decoded frame ${frame}: ${error || code}`)); return; }
      finish({ width: 64, height: 64, data: new Uint8Array(Buffer.concat(chunks)) });
    });
  });
}

/** Adapter for HeadlessHost({mirrorFrameRunner}). The compositor must render
 * the CURRENT project state each time it is called; returning a stale video
 * invalidates the score. Its output must use the attached EditDNA frame clock.
 * Only paths are returned to the critic; no reference bytes enter EditDNA. */
export function createFfmpegMirrorFrameRunner(options: {
  referencePath: string;
  renderTimelineVideo: () => Promise<string>;
  ffmpegPath?: string;
}): NonNullable<EditingHost["sampleMirrorFrame"]> {
  return async ({ kind, frame }) => {
    const path = kind === "reference" ? options.referencePath : await options.renderTimelineVideo();
    return decodeMirrorFrame(path, frame, options.ffmpegPath);
  };
}

/** Use this runner for Mirror v2: reference samples stay FFmpeg rawvideo; each
 * timeline sample snapshots the host's latest post-action state and sends it to
 * VideoEngine in Chromium. Retains EditingHost.sampleMirrorFrame's contract. */
export function createCompositorMirrorFrameRunner(options: {
  referencePath: string;
  getProject: () => Project;
  mediaPaths?: Readonly<Record<string, string>>;
  ffmpegPath?: string;
  chromiumExecutablePath?: string;
}): { sample: NonNullable<EditingHost["sampleMirrorFrame"]>; close: () => Promise<void> } {
  const compositor = new MirrorCompositor(options.chromiumExecutablePath);
  return {
    sample: async ({ kind, frame, fps }) => {
      if (kind === "reference") return decodeMirrorFrame(options.referencePath, frame, options.ffmpegPath);
      const snapshot = await createMirrorSnapshot(options.getProject(), options.mediaPaths);
      return compositor.sample(snapshot, frame * fps.den / fps.num);
    },
    close: () => compositor.close(),
  };
}
