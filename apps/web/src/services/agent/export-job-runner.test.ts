import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(), exportVideo: vi.fn(), exportAudio: vi.fn(),
  browserWritable: vi.fn(), desktopWritable: vi.fn(), writeBlob: vi.fn(),
  backendOptions: vi.fn(), nativeBackend: vi.fn(),
  project: { name: "Agent project", settings: { width: 320, height: 180, frameRate: 4 }, timeline: { duration: 1 }, mediaLibrary: { items: [] } },
}));
vi.mock("@kove-advanced/core", () => ({
  getExportEngine: () => ({ initialize: mocks.initialize, exportVideo: mocks.exportVideo, exportAudio: mocks.exportAudio }),
  WebCodecsBackend: class { constructor(_media: unknown, options: unknown) { mocks.backendOptions(options); } },
}));
vi.mock("../native-ffmpeg-backend", () => ({
  NativeFFmpegBackend: class {
    constructor(resolveOutputPath: () => string) { mocks.nativeBackend(resolveOutputPath); }
  },
}));
vi.mock("../../stores/project-store", () => ({ useProjectStore: { getState: () => ({ project: mocks.project }) } }));
vi.mock("../export-runner", () => ({
  createDownloadWritable: mocks.browserWritable,
  createDesktopStreamWritable: mocks.desktopWritable,
  writeBlobToWritable: mocks.writeBlob,
}));
vi.mock("../../motion/export-motion-frame", () => ({ renderMotionCompositionFrameToDataUrl: vi.fn() }));
vi.mock("../../bridges/media-bridge", () => ({ getMediaBridge: vi.fn(), initializeMediaBridge: vi.fn() }));
vi.mock("../media-storage", () => ({ loadMediaBlob: vi.fn() }));

import { createExportJobRunner } from "./export-job-runner";

describe("agent export jobs", () => {
  let writable: { abort: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    vi.clearAllMocks();
    writable = { abort: vi.fn().mockResolvedValue(undefined) };
    mocks.initialize.mockResolvedValue(undefined);
    mocks.browserWritable.mockResolvedValue(writable);
    mocks.desktopWritable.mockResolvedValue(writable);
    mocks.writeBlob.mockResolvedValue(undefined);
    delete (window as unknown as Record<string, unknown>)["kove-advanced"];
  });
  afterEach(() => { delete (window as unknown as Record<string, unknown>)["kove-advanced"]; });

  it("initializes the engine and streams browser video without mutating the global backend", async () => {
    mocks.exportVideo.mockImplementation(async function* (_project, _settings, stream, factory) {
      expect(stream).toBe(writable);
      factory({});
      yield { phase: "rendering", progress: 0.5 };
      return { success: true, stats: { fileSize: 1234 } };
    });
    const result = await createExportJobRunner()("exportVideo", { format: "webm" });
    expect(result).toMatchObject({ ok: true, data: { bytes: 1234, format: "webm", storage: "browser-download" } });
    expect(mocks.initialize).toHaveBeenCalledOnce();
    expect(mocks.exportVideo.mock.calls[0][1]).toMatchObject({ format: "webm", codec: "vp9" });
    expect(mocks.backendOptions).toHaveBeenCalledWith(expect.objectContaining({ videoCodecs: ["vp9"], clampResolution: true }));
    expect(mocks.browserWritable).toHaveBeenCalledWith(expect.stringMatching(/\.webm$/), "video/webm");
  });

  it("streams desktop video to a temporary file rather than buffering it in memory", async () => {
    (window as unknown as Record<string, unknown>)["kove-advanced"] = { fs: { tempFilePath: vi.fn().mockResolvedValue("/tmp/agent.mp4") } };
    mocks.exportVideo.mockImplementation(async function* (_project, _settings, _stream, factory) {
      factory({});
      yield { phase: "preparing", progress: 0 };
      return { success: true, stats: { fileSize: 4321 } };
    });
    const result = await createExportJobRunner()("exportVideo", { format: "mp4" });
    expect(result).toMatchObject({ ok: true, data: { path: "/tmp/agent.mp4", bytes: 4321, storage: "local" } });
    expect(mocks.desktopWritable).toHaveBeenCalledWith("/tmp/agent.mp4");
    expect(mocks.browserWritable).not.toHaveBeenCalled();
    expect(mocks.backendOptions).toHaveBeenCalledWith(expect.objectContaining({ videoCodecs: ["avc"], clampResolution: false }));
  });

  it("saves audio in a browser download with bitrate expressed in kbps", async () => {
    const blob = new Blob(["audio"], { type: "audio/ogg" });
    mocks.exportAudio.mockImplementation(async function* () {
      yield { phase: "encoding", progress: 0.5 };
      return { success: true, blob };
    });
    const result = await createExportJobRunner()("exportAudio", { format: "ogg" });
    expect(result).toMatchObject({ ok: true, data: { format: "ogg", storage: "browser-download", bytes: 5 } });
    expect(mocks.exportAudio.mock.calls[0][1]).toMatchObject({ format: "ogg", sampleRate: 48000, channels: 2, bitrate: 192 });
    expect(mocks.writeBlob).toHaveBeenCalledWith(blob, writable);
  });

  it("reports initialization and encoder errors without producing a successful file", async () => {
    mocks.initialize.mockRejectedValueOnce(new Error("engine failed"));
    await expect(createExportJobRunner()("exportVideo", {})).resolves.toMatchObject({ ok: false, error: "engine failed" });
    expect(mocks.browserWritable).not.toHaveBeenCalled();
    mocks.exportVideo.mockImplementation(async function* () {
      yield { phase: "encoding", progress: 0.5 };
      throw new Error("encoder failed");
    });
    const failure = await createExportJobRunner()("exportVideo", {});
    expect(failure).toMatchObject({ ok: false, error: "encoder failed" });
    expect(mocks.browserWritable).toHaveBeenCalledTimes(2);
    expect(writable.abort).toHaveBeenCalledTimes(2);
  });

  it("falls back from hardware to software WebCodecs when the encoder stalls", async () => {
    const accelerations: string[] = [];
    mocks.exportVideo.mockImplementation(async function* (_project, _settings, stream, factory) {
      factory({});
      accelerations.push((mocks.backendOptions.mock.calls.at(-1)?.[0] as { hardwareAcceleration: string }).hardwareAcceleration);
      expect(stream).toBe(writable);
      yield { phase: "rendering", progress: 0.5 };
      if (accelerations.length === 1) {
        return { success: false, error: { code: "TIMEOUT", message: "stalled", phase: "rendering", recoverable: true } };
      }
      return { success: true, stats: { fileSize: 999 } };
    });
    const result = await createExportJobRunner()("exportVideo", { format: "mp4" });
    expect(result).toMatchObject({ ok: true, data: { bytes: 999, format: "mp4" } });
    expect(accelerations).toEqual(["prefer-hardware", "prefer-software"]);
    expect(mocks.backendOptions).toHaveBeenLastCalledWith(expect.objectContaining({ hardwareAcceleration: "prefer-software" }));
  });

  it("does not retry a user cancellation", async () => {
    let calls = 0;
    mocks.exportVideo.mockImplementation(async function* () {
      calls += 1;
      yield { phase: "rendering", progress: 0.5 };
      return { success: false, error: { code: "CANCELLED", message: "cancelled", phase: "rendering", recoverable: false } };
    });
    const result = await createExportJobRunner()("exportVideo", { format: "mp4" });
    expect(result).toMatchObject({ ok: false, error: "cancelled" });
    expect(calls).toBe(1);
  });

  it("falls back to the native FFmpeg backend on desktop after WebCodecs fails twice", async () => {
    (window as unknown as Record<string, unknown>)["kove-advanced"] = { fs: { tempFilePath: vi.fn().mockResolvedValue("/tmp/agent.mp4") } };
    const usedBackends: string[] = [];
    mocks.exportVideo.mockImplementation(async function* (_project, _settings, _stream, factory) {
      factory({});
      usedBackends.push(mocks.nativeBackend.mock.calls.length > 0 ? "native" : "webcodecs");
      yield { phase: "rendering", progress: 0.5 };
      return { success: false, error: { code: "TIMEOUT", message: "stalled", phase: "rendering", recoverable: true } };
    });
    const result = await createExportJobRunner()("exportVideo", { format: "mp4" });
    expect(result).toMatchObject({ ok: false, error: "stalled" });
    expect(usedBackends).toEqual(["webcodecs", "webcodecs", "native"]);
    expect(mocks.nativeBackend).toHaveBeenCalledWith(expect.any(Function));
    expect(mocks.desktopWritable).toHaveBeenCalledTimes(3);
  });

  it("does not use the native backend in the browser", async () => {
    mocks.exportVideo.mockImplementation(async function* () {
      yield { phase: "rendering", progress: 0.5 };
      return { success: false, error: { code: "TIMEOUT", message: "stalled", phase: "rendering", recoverable: true } };
    });
    const result = await createExportJobRunner()("exportVideo", { format: "mp4" });
    expect(result).toMatchObject({ ok: false, error: "stalled" });
    expect(mocks.nativeBackend).not.toHaveBeenCalled();
    expect(mocks.browserWritable).toHaveBeenCalledTimes(2);
  });
});
