// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { WebCodecsBackend } from "./webcodecs-backend";
import type { VideoExportSettings } from "./types";
import type { Project } from "../types/project";

const { mockVideoSourceAdd, captured } = vi.hoisted(() => {
  return {
    mockVideoSourceAdd: vi.fn(),
    captured: {
      chunkWriterStream: null as WritableStream<{ data: Uint8Array; position: number }> | null,
      encodingConfig: null as Record<string, unknown> | null,
    },
  };
});

vi.mock("mediabunny", () => {
  class MockMp4OutputFormat {
    getSupportedVideoCodecs() {
      return ["avc"];
    }

    getSupportedAudioCodecs() {
      return ["aac"];
    }
  }

  class MockOutput {
    constructor(_options: { format: unknown; target: unknown }) {}
    addVideoTrack = vi.fn();
    addAudioTrack = vi.fn();
    setMetadataTags = vi.fn();
    start = vi.fn().mockResolvedValue(undefined);
    finalize = vi.fn().mockResolvedValue(undefined);
    cancel = vi.fn();
  }

  class MockStreamTarget {
    writable: WritableStream<{ data: Uint8Array; position: number }>;

    constructor(writable: WritableStream<{ data: Uint8Array; position: number }>, _options?: Record<string, unknown>) {
      this.writable = writable;
      captured.chunkWriterStream = writable;
    }
  }

  class MockVideoSampleSource {
    add = mockVideoSourceAdd;

    constructor(_config: Record<string, unknown>) {
      captured.encodingConfig = _config;
    }
  }

  class MockVideoSample {
    close = vi.fn();

    constructor(_data: unknown, _init: { timestamp: number; duration: number }) {}
  }

  class MockAudioBufferSource {
    add = vi.fn().mockResolvedValue(undefined);

    constructor(_config: Record<string, unknown>) {}
  }

  return {
    Output: MockOutput,
    StreamTarget: MockStreamTarget,
    Mp4OutputFormat: MockMp4OutputFormat,
    WebMOutputFormat: MockMp4OutputFormat,
    MovOutputFormat: MockMp4OutputFormat,
    OutputTarget: MockStreamTarget,
    VideoSampleSource: MockVideoSampleSource,
    AudioBufferSource: MockAudioBufferSource,
    VideoSample: MockVideoSample,
    QUALITY_MEDIUM: 2_000_000,
    getFirstEncodableVideoCodec: vi.fn(async (codecs: string[]) => codecs[0] ?? null),
    getFirstEncodableAudioCodec: vi.fn(async (codecs: string[]) => codecs[0] ?? null),
  };
});

// The mock namespace is structurally unrelated to the real MediaBunnyModule
// surface, but the backend only touches the handful of symbols stubbed above.
const mediabunny = (await import("mediabunny")) as unknown as ConstructorParameters<typeof WebCodecsBackend>[0];

function fakeBitmap(): ImageBitmap {
  return { width: 640, height: 360, close: vi.fn() } as unknown as ImageBitmap;
}

function fakeWritable(behavior: "ok" | "stall" = "ok"): FileSystemWritableFileStream {
  return {
    seek: vi.fn().mockResolvedValue(undefined),
    write:
      behavior === "ok"
        ? vi.fn((_chunk: FileSystemWriteChunkType) => Promise.resolve(undefined))
        : vi.fn((_chunk: FileSystemWriteChunkType) => new Promise<undefined>(() => {})),
    close: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    truncate: vi.fn().mockResolvedValue(undefined),
  } as unknown as FileSystemWritableFileStream;
}

const project = {
  name: "Diagnostics",
  settings: { width: 640, height: 360, frameRate: 30 },
  timeline: { tracks: [] },
} as unknown as Project;

const videoSettings: Partial<VideoExportSettings> = {
  format: "mp4",
  codec: "h264",
  width: 640,
  height: 360,
  frameRate: 30,
  bitrate: 8000,
  keyframeInterval: 60,
};

describe("WebCodecsBackend pipeline diagnostics", () => {
  let consoleError: MockInstance;

  beforeEach(() => {
    vi.useFakeTimers();
    mockVideoSourceAdd.mockReset();
    mockVideoSourceAdd.mockResolvedValue(undefined);
    captured.chunkWriterStream = null;
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("records adds, writer traffic, and codec selection in getDiagnostics", async () => {
    const backend = new WebCodecsBackend(mediabunny);
    await backend.start(videoSettings as VideoExportSettings, project, fakeWritable());

    // Our StreamTarget mock never flushes on its own; drive the writer the way
    // the real muxer would.
    const writer = captured.chunkWriterStream!.getWriter();
    await writer.write({ data: new Uint8Array(5), position: 0 });
    writer.releaseLock();

    await backend.addVideoFrame(fakeBitmap(), 0, 1 / 30);
    await backend.addVideoFrame(fakeBitmap(), 1 / 30, 1 / 30);

    const diagnostics = backend.getDiagnostics();
    expect(diagnostics).toMatchObject({
      videoAdds: 2,
      codec: "avc",
      hardwareAcceleration: "prefer-hardware",
      bytesWritten: 5,
      pendingWriterOps: 0,
    });
    expect((diagnostics.writerOps as number) >= 1).toBe(true);
  });

  it("logs pipeline diagnostics when a video add stalls", async () => {
    mockVideoSourceAdd.mockImplementation(() => new Promise<void>(() => {}));
    const backend = new WebCodecsBackend(mediabunny, { hardwareAcceleration: "prefer-software" });
    await backend.start(videoSettings as VideoExportSettings, project, fakeWritable());

    void backend.addVideoFrame(fakeBitmap(), 0, 1 / 30);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("video sample add #1 has been pending"));
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('"hardwareAcceleration":"prefer-software"'));
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('"videoAdds":1'));
  });

  it("logs pipeline diagnostics when the file writer stalls", async () => {
    const backend = new WebCodecsBackend(mediabunny);
    await backend.start(videoSettings as VideoExportSettings, project, fakeWritable("stall"));

    const writer = captured.chunkWriterStream!.getWriter();
    const flush = writer.write({ data: new Uint8Array(5), position: 0 });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("file writer stalled"));
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('"pendingWriterOps":1'));

    writer.releaseLock();
    await Promise.resolve().catch(() => undefined);
    void flush;
  });
});

describe("WebCodecsBackend AVC codec string", () => {
  const originalVideoEncoder = (globalThis as { VideoEncoder?: unknown }).VideoEncoder;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    mockVideoSourceAdd.mockReset();
    mockVideoSourceAdd.mockResolvedValue(undefined);
    captured.encodingConfig = null;
  });

  afterEach(() => {
    (globalThis as { VideoEncoder?: unknown }).VideoEncoder = originalVideoEncoder;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function stubEncoderSupport(supportedLevel: number): { codec: string }[] {
    const probed: { codec: string }[] = [];
    (globalThis as { VideoEncoder: unknown }).VideoEncoder = {
      isConfigSupported: async (config: { codec: string }) => {
        probed.push(config);
        const hex = /avc1\.42c0([0-9a-fA-F]{2})/.exec(config.codec)?.[1] ?? "";
        return { supported: /^avc1\.42c0/.test(config.codec) && parseInt(hex, 16) === supportedLevel };
      },
    };
    return probed;
  }

  it("hands a Constrained Baseline fullCodecString to the sample source for h264", async () => {
    stubEncoderSupport(0x1f);
    const backend = new WebCodecsBackend(mediabunny);
    await backend.start(videoSettings as VideoExportSettings, project, fakeWritable());

    expect(captured.encodingConfig?.fullCodecString).toBe("avc1.42c01f");
  });

  it("walks levels upward until one is supported", async () => {
    stubEncoderSupport(0x28);
    const backend = new WebCodecsBackend(mediabunny);
    await backend.start(videoSettings as VideoExportSettings, project, fakeWritable());

    expect(captured.encodingConfig?.fullCodecString).toBe("avc1.42c028");
  });

  it("falls back to mediabunny's default string when no level is supported", async () => {
    stubEncoderSupport(-1);
    const backend = new WebCodecsBackend(mediabunny);
    await backend.start(videoSettings as VideoExportSettings, project, fakeWritable());

    expect(captured.encodingConfig?.fullCodecString).toBeUndefined();
  });
});

describe("WebCodecsBackend encoder output stall guard", () => {
  let consoleError: MockInstance;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    mockVideoSourceAdd.mockReset();
    captured.encodingConfig = null;
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    (globalThis as { VideoEncoder: unknown }).VideoEncoder = {
      isConfigSupported: async () => ({ supported: true }),
    };
  });

  afterEach(() => {
    delete (globalThis as { VideoEncoder?: unknown }).VideoEncoder;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function startBackend(): Promise<WebCodecsBackend> {
    const backend = new WebCodecsBackend(mediabunny);
    await backend.start(videoSettings as VideoExportSettings, project, fakeWritable());
    return backend;
  }

  function emitVideoPacket(): void {
    const onEncodedPacket = captured.encodingConfig?.onEncodedPacket as
      | ((packet: unknown, meta: unknown) => void)
      | undefined;
    onEncodedPacket?.({ timestamp: 0 }, undefined);
  }

  it("rejects a queued video add with TimeoutError once no packets have been emitted", async () => {
    mockVideoSourceAdd.mockImplementation(() => new Promise<void>(() => {}));
    const backend = await startBackend();

    const rejection: unknown[] = [];
    void backend.addVideoFrame(fakeBitmap(), 0, 1 / 30).catch((error) => rejection.push(error));

    await vi.advanceTimersByTimeAsync(12_000);
    await Promise.resolve();

    expect(rejection.length).toBe(1);
    const error = rejection[0] as Error;
    expect(error.name).toBe("TimeoutError");
    expect(error.message).toContain("produced no output for 10s");
    expect(error.message).toContain('"videoAdds":1');
  });

  it("stays quiet while the encoder keeps emitting packets", async () => {
    mockVideoSourceAdd.mockImplementation(() => new Promise<void>(() => {}));
    const backend = await startBackend();

    void backend.addVideoFrame(fakeBitmap(), 0, 1 / 30).catch(() => undefined);
    for (let second = 0; second < 12; second++) {
      emitVideoPacket();
      await vi.advanceTimersByTimeAsync(1_000);
    }

    expect(consoleError).not.toHaveBeenCalled();
  });
});
