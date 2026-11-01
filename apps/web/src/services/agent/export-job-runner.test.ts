import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(), exportVideo: vi.fn(), exportAudio: vi.fn(),
  browserWritable: vi.fn(), desktopWritable: vi.fn(), writeBlob: vi.fn(),
  backendOptions: vi.fn(),
  project: { name: "Agent project", settings: { width: 320, height: 180, frameRate: 4 }, timeline: { duration: 1 }, mediaLibrary: { items: [] } },
}));
vi.mock("@kove-advanced/core", () => ({
  getExportEngine: () => ({ initialize: mocks.initialize, exportVideo: mocks.exportVideo, exportAudio: mocks.exportAudio }),
  WebCodecsBackend: class { constructor(_media: unknown, options: unknown) { mocks.backendOptions(options); } },
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
    mocks.exportAudio.mockImplementation(async function* () { return { success: true, blob }; });
    const result = await createExportJobRunner()("exportAudio", { format: "ogg" });
    expect(result).toMatchObject({ ok: true, data: { format: "ogg", storage: "browser-download", bytes: 5 } });
    expect(mocks.exportAudio.mock.calls[0][1]).toMatchObject({ format: "ogg", sampleRate: 48000, channels: 2, bitrate: 192 });
    expect(mocks.writeBlob).toHaveBeenCalledWith(blob, writable);
  });

  it("reports initialization and encoder errors without producing a successful file", async () => {
    mocks.initialize.mockRejectedValueOnce(new Error("engine failed"));
    await expect(createExportJobRunner()("exportVideo", {})).resolves.toMatchObject({ ok: false, error: "engine failed" });
    expect(mocks.browserWritable).not.toHaveBeenCalled();
    mocks.exportVideo.mockImplementation(async function* () { throw new Error("encoder failed"); });
    await expect(createExportJobRunner()("exportVideo", {})).resolves.toMatchObject({ ok: false, error: "encoder failed" });
    expect(writable.abort).toHaveBeenCalledOnce();
  });
});
