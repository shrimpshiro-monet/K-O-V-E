import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("../src/main/sidecar/ffmpeg-path", () => ({ resolveFfmpegPath: () => process.env.KOVE_TEST_FFMPEG! }));
import { ExportJob, type ExportArgs } from "../src/main/sidecar/export-job";

const ffmpeg = process.env.KOVE_TEST_FFMPEG;
const ffprobe = process.env.KOVE_TEST_FFPROBE;
const run = promisify(execFile);

describe.skipIf(!ffmpeg || !ffprobe)("native FFmpeg output formats", () => {
  let dir: string;
  let wav: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "kove-native-codecs-"));
    wav = path.join(dir, "tone.wav");
    await run(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1", wav]);
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it.each([
    { format: "mp4", codec: "h264", encoder: "libx264", audio: "aac" },
    { format: "webm", codec: "vp9", encoder: "libvpx-vp9", audio: "opus" },
  ] as const)("encodes and probes real $codec/$audio $format output", async ({ format, codec, encoder, audio }) => {
    const outputPath = path.join(dir, `output.${format}`);
    const args: ExportArgs = {
      width: 160, height: 90, frameRate: 5, codec, encoder, mode: "balanced", quality: 80,
      bitrateKbps: 2000, outputPath, audioWavPath: wav, format,
    };
    await new Promise<void>((resolve, reject) => {
      const job = new ExportJob(args, () => {}, resolve, (message) => reject(new Error(message)));
      job.start();
      void (async () => {
        for (let index = 0; index < 5; index++) {
          const frame = new Uint8Array(160 * 90 * 4);
          for (let pixel = 0; pixel < frame.length; pixel += 4) {
            frame[pixel] = 40 + index * 30;
            frame[pixel + 1] = 90;
            frame[pixel + 2] = 180;
            frame[pixel + 3] = 255;
          }
          await job.writeFrame(frame);
        }
        job.endInput();
      })().catch(reject);
    });
    expect((await readFile(outputPath)).byteLength).toBeGreaterThan(1000);
    const { stdout } = await run(ffprobe!, ["-v", "error", "-show_entries", "stream=codec_type,codec_name:format=duration", "-of", "json", outputPath]);
    const media = JSON.parse(stdout) as { streams: Array<{ codec_type: string; codec_name: string }>; format: { duration: string } };
    expect(media.streams.find((stream) => stream.codec_type === "video")?.codec_name).toBe(codec);
    expect(media.streams.find((stream) => stream.codec_type === "audio")?.codec_name).toBe(audio);
    expect(Number(media.format.duration)).toBeGreaterThanOrEqual(0.95);
    expect(Number(media.format.duration)).toBeLessThan(1.2);
  }, 60_000);
});
