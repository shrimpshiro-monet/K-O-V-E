import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("../src/main/sidecar/ffmpeg-path", () => ({ resolveFfmpegPath: () => "ffmpeg" }));

import { ExportJob, type ExportArgs } from "../src/main/sidecar/export-job";

describe("native export destination transaction", () => {
  let dir: string;
  let outputPath: string;
  let proc: EventEmitter & { stdin: PassThrough; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
  let done: ReturnType<typeof vi.fn>;
  let error: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "kove-export-transaction-"));
    outputPath = path.join(dir, "existing.mp4");
    await writeFile(outputPath, "original user file");
    proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stderr: new EventEmitter(), kill: vi.fn() });
    spawnMock.mockReset().mockReturnValue(proc);
    done = vi.fn();
    error = vi.fn();
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function start() {
    const args: ExportArgs = {
      width: 16, height: 16, frameRate: 1, codec: "h264", encoder: "libx264",
      mode: "balanced", quality: 80, bitrateKbps: 1000, outputPath,
      audioWavPath: path.join(dir, "audio.wav"), format: "mp4",
    };
    const job = new ExportJob(args, vi.fn(), done, error);
    job.start();
    const command = spawnMock.mock.calls[0][1] as string[];
    const partial = command[command.length - 1];
    expect(partial).not.toBe(outputPath);
    expect(path.dirname(partial)).toBe(dir);
    expect(partial).toMatch(/\.partial\.mp4$/);
    return { job, partial };
  }

  it("replaces an existing file only after FFmpeg exits successfully", async () => {
    const { partial } = start();
    await writeFile(partial, "new video");
    expect(await readFile(outputPath, "utf8")).toBe("original user file");
    proc.emit("close", 0);
    expect(await readFile(outputPath, "utf8")).toBe("new video");
    expect(done).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual(["existing.mp4"]);
  });

  it("preserves the destination and removes the partial file on encoder failure", async () => {
    const { partial } = start();
    await writeFile(partial, "partial video");
    proc.stderr.emit("data", Buffer.from("codec unavailable"));
    proc.emit("close", 1);
    expect(await readFile(outputPath, "utf8")).toBe("original user file");
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0][0]).toContain("codec unavailable");
    expect(done).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual(["existing.mp4"]);
  });

  it("does not publish even if cancellation races a successful close", async () => {
    const { job, partial } = start();
    await writeFile(partial, "partial video");
    job.cancel();
    proc.emit("close", 0);
    expect(await readFile(outputPath, "utf8")).toBe("original user file");
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    expect(done).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual(["existing.mp4"]);
    await expect(job.writeFrame(new Uint8Array(4))).rejects.toThrow(/stopped accepting/i);
  });

  it("reports a spawn error only once and cleans up on close", async () => {
    const { partial } = start();
    await writeFile(partial, "partial video");
    proc.emit("error", new Error("ffmpeg missing"));
    proc.emit("close", -1);
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("ffmpeg missing");
    expect(await readFile(outputPath, "utf8")).toBe("original user file");
    expect(await readdir(dir)).toEqual(["existing.mp4"]);
  });
});
