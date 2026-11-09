import { afterEach, describe, expect, it, vi } from "vitest";

const { mediaEngine } = vi.hoisted(() => ({
  mediaEngine: {
    isAvailable: vi.fn().mockReturnValue(true),
    initialize: vi.fn(),
    getExportDecoder: vi.fn(),
    createExportDecoder: vi.fn(),
    disposeExportDecoder: vi.fn(),
    getFrameAtTime: vi.fn(),
  },
}));

vi.mock("../media/mediabunny-engine", () => ({
  getMediaEngine: () => mediaEngine,
}));

describe("VideoEngine export decoder fallback", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mediaEngine.isAvailable.mockReturnValue(true);
  });

  it("creates export decoders lazily and falls back when a decoder stalls", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("self", {
      onmessage: null,
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const decoder = { getFrame: vi.fn(() => new Promise(() => {})) };
    mediaEngine.getExportDecoder.mockReturnValue(null);
    mediaEngine.createExportDecoder.mockResolvedValue(decoder);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { VideoEngine } = await import("./video-engine");
    const engine = new VideoEngine();
    engine.exportMode = true;

    const pending = engine.decodeFrameWithMediaBunny(
      new Blob(["video"]),
      0,
      320,
      180,
      "source-1",
    );
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(pending).resolves.toBeNull();
    expect(mediaEngine.createExportDecoder).toHaveBeenCalledWith(
      "source-1",
      expect.any(Blob),
      320,
    );
    expect(mediaEngine.disposeExportDecoder).toHaveBeenCalledWith("source-1");
    expect(mediaEngine.getFrameAtTime).not.toHaveBeenCalled();
  });
});
