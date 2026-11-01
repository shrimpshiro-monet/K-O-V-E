import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockRenderFrame,
  mockVideoEngine,
  mockRenderAudio,
  mockAudioEngine,
  mockMediaEngine,
  mockVideoSourceAdd,
  mockAudioSourceAdd,
  mockVideoSourceConfigs,
  mockAudioSourceConfigs,
  mockOutputFormats,
  mockGetFirstEncodableVideoCodec,
  mockGetFirstEncodableAudioCodec,
  mockOutputStart,
  mockOutputFinalize,
  mockOutputCancel,
} = vi.hoisted(() => {
  const mockRenderFrame = vi.fn().mockResolvedValue({
    image: { close: vi.fn() },
    width: 1920,
    height: 1080,
  });

  const mockVideoEngine = {
    isInitialized: vi.fn().mockReturnValue(false),
    initialize: vi.fn().mockResolvedValue(undefined),
    initializeGPUCompositor: vi.fn().mockResolvedValue(undefined),
    getGPUCompositor: vi.fn().mockReturnValue(null),
    renderFrame: mockRenderFrame,
    resetExportState: vi.fn(),
    clearVideoElementCache: vi.fn(),
    clearCache: vi.fn(),
  };

  const mockRenderAudio = vi.fn().mockResolvedValue({ buffer: null });
  const mockAudioEngine = {
    isInitialized: vi.fn().mockReturnValue(false),
    initialize: vi.fn().mockResolvedValue(undefined),
    renderAudio: mockRenderAudio,
    clearCache: vi.fn(),
  };

  const mockMediaEngine = {
    isAvailable: vi.fn().mockReturnValue(true),
    initialize: vi.fn().mockResolvedValue(undefined),
    getExportDecoder: vi.fn().mockReturnValue(null),
    createExportDecoder: vi.fn().mockResolvedValue(null),
    disposeAllExportDecoders: vi.fn(),
    clearFrameCache: vi.fn(),
  };

  return {
    mockRenderFrame,
    mockVideoEngine,
    mockRenderAudio,
    mockAudioEngine,
    mockMediaEngine,
    mockVideoSourceAdd: vi.fn().mockResolvedValue(undefined),
    mockAudioSourceAdd: vi.fn().mockResolvedValue(undefined),
    mockVideoSourceConfigs: [] as Record<string, unknown>[],
    mockAudioSourceConfigs: [] as Record<string, unknown>[],
    mockOutputFormats: [] as string[],
    mockGetFirstEncodableVideoCodec: vi.fn().mockResolvedValue("avc"),
    mockGetFirstEncodableAudioCodec: vi.fn().mockResolvedValue("aac"),
    mockOutputStart: vi.fn().mockResolvedValue(undefined),
    mockOutputFinalize: vi.fn().mockResolvedValue(undefined),
    mockOutputCancel: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../video/video-engine", () => ({
  VideoEngine: vi.fn(),
  getVideoEngine: vi.fn().mockReturnValue(mockVideoEngine),
}));

vi.mock("../audio/audio-engine", () => ({
  AudioEngine: vi.fn(),
  getAudioEngine: vi.fn().mockReturnValue(mockAudioEngine),
}));

vi.mock("../text/title-engine", () => ({
  titleEngine: {
    getAllTextClips: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../graphics/graphics-engine", () => ({
  graphicsEngine: {
    getAllShapeClips: vi.fn().mockReturnValue([]),
    getAllSVGClips: vi.fn().mockReturnValue([]),
    getAllStickerClips: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../media/mediabunny-engine", () => ({
  getMediaEngine: vi.fn().mockReturnValue(mockMediaEngine),
}));

vi.mock("mediabunny", () => {
  class MockMp4OutputFormat {
    getSupportedVideoCodecs() {
      return ["avc", "hevc"];
    }

    getSupportedAudioCodecs() {
      return ["aac"];
    }
  }

  class MockWebMOutputFormat extends MockMp4OutputFormat {}
  class MockMovOutputFormat extends MockMp4OutputFormat {}
  class MockMp3OutputFormat { getSupportedAudioCodecs() { return ["mp3"]; } }
  class MockAdtsOutputFormat { getSupportedAudioCodecs() { return ["aac"]; } }
  class MockFlacOutputFormat { getSupportedAudioCodecs() { return ["flac"]; } }
  class MockOggOutputFormat { getSupportedAudioCodecs() { return ["opus"]; } }
  class MockBufferTarget { buffer = new Uint8Array([1, 2, 3]).buffer; }

  class MockOutput {
    constructor(options: { format: object }) { mockOutputFormats.push(options.format.constructor.name); }
    addVideoTrack = vi.fn();
    addAudioTrack = vi.fn();
    setMetadataTags = vi.fn();
    start = mockOutputStart;
    finalize = mockOutputFinalize;
    cancel = mockOutputCancel;
  }

  class MockStreamTarget {
    constructor(
      _writable: WritableStream<{ data: Uint8Array; position: number }>,
      _options?: Record<string, unknown>,
    ) {}
  }

  class MockVideoSampleSource {
    add = mockVideoSourceAdd;
    close = vi.fn();

    constructor(config: Record<string, unknown>) {
      mockVideoSourceConfigs.push(config);
    }
  }

  class MockAudioBufferSource {
    add = mockAudioSourceAdd;
    close = vi.fn();

    constructor(config: Record<string, unknown>) { mockAudioSourceConfigs.push(config); }
  }

  class MockVideoSample {
    close = vi.fn();

    constructor(
      _data: unknown,
      _init: { timestamp: number; duration: number },
    ) {}
  }

  return {
    Output: MockOutput,
    StreamTarget: MockStreamTarget,
    Mp4OutputFormat: MockMp4OutputFormat,
    Mp3OutputFormat: MockMp3OutputFormat,
    AdtsOutputFormat: MockAdtsOutputFormat,
    FlacOutputFormat: MockFlacOutputFormat,
    OggOutputFormat: MockOggOutputFormat,
    BufferTarget: MockBufferTarget,
    WebMOutputFormat: MockWebMOutputFormat,
    MovOutputFormat: MockMovOutputFormat,
    VideoSampleSource: MockVideoSampleSource,
    AudioBufferSource: MockAudioBufferSource,
    VideoSample: MockVideoSample,
    getFirstEncodableVideoCodec: mockGetFirstEncodableVideoCodec,
    getFirstEncodableAudioCodec: mockGetFirstEncodableAudioCodec,
    QUALITY_MEDIUM: 1_000_000,
  };
});

import { ExportEngine, getExportEngine } from "./export-engine";
import { getWavEncoder } from "../wasm/wav";
import {
  DEFAULT_VIDEO_SETTINGS,
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_IMAGE_SETTINGS,
  VIDEO_QUALITY_PRESETS,
} from "./types";
import type { Project, Timeline, Track, Clip } from "../types";

const createMockProject = (overrides?: Partial<Project>): Project => ({
  id: "test-project-id",
  name: "Test Project",
  createdAt: Date.now(),
  modifiedAt: Date.now(),
  settings: {
    width: 1920,
    height: 1080,
    frameRate: 30,
    sampleRate: 48000,
    channels: 2,
  },
  mediaLibrary: {
    items: [
      {
        id: "media-1",
        name: "Mock video",
        type: "video",
        fileHandle: null,
        blob: null,
        metadata: {
          duration: 40,
          width: 1920,
          height: 1080,
          frameRate: 30,
          codec: "h264",
          sampleRate: 48_000,
          channels: 2,
          fileSize: 0,
          hasVideo: true,
          hasAudio: true,
        },
        thumbnailUrl: null,
        waveformData: null,
      },
    ],
  },
  timeline: {
    tracks: [],
    subtitles: [],
    duration: 0,
    markers: [],
  },
  ...overrides,
});

const createMockClip = (overrides?: Partial<Clip>): Clip => ({
  id: "clip-1",
  mediaId: "media-1",
  trackId: "track-1",
  startTime: 0,
  duration: 5,
  inPoint: 0,
  outPoint: 5,
  effects: [],
  audioEffects: [],
  transform: {
    position: { x: 0.5, y: 0.5 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    anchor: { x: 0.5, y: 0.5 },
    opacity: 1,
  },
  volume: 1,
  keyframes: [],
  ...overrides,
});

const createMockTrack = (overrides?: Partial<Track>): Track => ({
  id: "track-1",
  type: "video",
  name: "Video 1",
  clips: [createMockClip()],
  transitions: [],
  locked: false,
  hidden: false,
  muted: false,
  solo: false,
  ...overrides,
});

const createMockTimeline = (overrides?: Partial<Timeline>): Timeline => ({
  tracks: [createMockTrack()],
  subtitles: [],
  duration: 5,
  markers: [],
  ...overrides,
});

describe("ExportEngine", () => {
  let exportEngine: ExportEngine;

  beforeEach(() => {
    exportEngine = new ExportEngine();
    vi.clearAllMocks();
    mockVideoEngine.isInitialized.mockReturnValue(false);
    mockAudioEngine.isInitialized.mockReturnValue(false);
    mockMediaEngine.isAvailable.mockReturnValue(true);
    mockMediaEngine.getExportDecoder.mockReturnValue(null);
    mockVideoSourceConfigs.length = 0;
    mockAudioSourceConfigs.length = 0;
    mockOutputFormats.length = 0;
    mockGetFirstEncodableVideoCodec.mockResolvedValue("avc");
    mockGetFirstEncodableAudioCodec.mockResolvedValue("aac");
    mockOutputStart.mockResolvedValue(undefined);
    mockOutputFinalize.mockResolvedValue(undefined);
    mockRenderFrame.mockResolvedValue({
      image: { close: vi.fn() },
      width: 1920,
      height: 1080,
    });
    mockRenderAudio.mockResolvedValue({ buffer: null });
  });

  afterEach(() => {
    exportEngine.dispose();
    vi.unstubAllGlobals();
  });

  describe("initialization", () => {
    it("should start uninitialized", () => {
      expect(exportEngine.isInitialized()).toBe(false);
    });

    it("should report MediaBunny unavailable before init", () => {
      expect(exportEngine.isMediaBunnyAvailable()).toBe(false);
    });
  });

  describe("singleton pattern", () => {
    it("should return same instance from getExportEngine", () => {
      const engine1 = getExportEngine();
      const engine2 = getExportEngine();
      expect(engine1).toBe(engine2);
    });
  });

  describe("presets", () => {
    it("should return export presets", () => {
      const presets = exportEngine.getPresets();
      expect(presets.length).toBeGreaterThan(0);
    });

    it("should have presets for all categories", () => {
      const presets = exportEngine.getPresets();
      const categories = new Set(presets.map((p) => p.category));
      expect(categories.has("social")).toBe(true);
      expect(categories.has("broadcast")).toBe(true);
      expect(categories.has("web")).toBe(true);
      expect(categories.has("archive")).toBe(true);
    });

    it("should have YouTube preset", () => {
      const presets = exportEngine.getPresets();
      const youtubePreset = presets.find((p) => p.id === "youtube-1080p");
      expect(youtubePreset).toBeDefined();
      expect(youtubePreset?.settings).toHaveProperty("codec", "h264");
    });

    it("should have TikTok preset with vertical dimensions", () => {
      const presets = exportEngine.getPresets();
      const tiktokPreset = presets.find((p) => p.id === "tiktok-1080p");
      expect(tiktokPreset).toBeDefined();
      if ("width" in tiktokPreset!.settings) {
        expect(tiktokPreset!.settings.width).toBe(1080);
        expect(tiktokPreset!.settings.height).toBe(1920);
      }
    });

    it("should create custom preset", () => {
      const customPreset = exportEngine.createPreset("My Preset", {
        ...DEFAULT_VIDEO_SETTINGS,
        bitrate: 15000,
      });
      expect(customPreset.name).toBe("My Preset");
      expect(customPreset.category).toBe("custom");
      expect(customPreset.id).toMatch(/^custom-/);
    });
  });

  describe("file size estimation", () => {
    it("should estimate video file size", () => {
      const project = createMockProject({
        timeline: createMockTimeline({ duration: 60 }),
      });

      const settings = { ...DEFAULT_VIDEO_SETTINGS, bitrate: 8000 };
      const estimatedSize = exportEngine.estimateFileSize(project, settings);

      const expectedSize = ((8000 * 1000 + 192 * 1000) * 60) / 8;
      expect(estimatedSize).toBe(Math.ceil(expectedSize));
    });

    it("should estimate audio file size for WAV", () => {
      const project = createMockProject({
        timeline: createMockTimeline({ duration: 60 }),
      });

      const settings = { ...DEFAULT_AUDIO_SETTINGS, format: "wav" as const };
      const estimatedSize = exportEngine.estimateFileSize(project, settings);

      const expectedSize = 60 * 48000 * 2 * (16 / 8);
      expect(estimatedSize).toBe(Math.ceil(expectedSize));
    });

    it("should estimate audio file size for MP3", () => {
      const project = createMockProject({
        timeline: createMockTimeline({ duration: 60 }),
      });

      const settings = { ...DEFAULT_AUDIO_SETTINGS, bitrate: 320 };
      const estimatedSize = exportEngine.estimateFileSize(project, settings);

      const expectedSize = (320 * 1000 * 60) / 8;
      expect(estimatedSize).toBe(Math.ceil(expectedSize));
    });
  });

  describe("export time estimation", () => {
    it("should estimate video export time", () => {
      const project = createMockProject({
        timeline: createMockTimeline({ duration: 60 }),
      });

      const settings = DEFAULT_VIDEO_SETTINGS;
      const estimatedTime = exportEngine.estimateExportTime(project, settings);

      expect(estimatedTime).toBeGreaterThan(0);
    });

    it("should estimate longer time for H.265", () => {
      const project = createMockProject({
        timeline: createMockTimeline({ duration: 60 }),
      });

      const h264Settings = {
        ...DEFAULT_VIDEO_SETTINGS,
        codec: "h264" as const,
      };
      const h265Settings = {
        ...DEFAULT_VIDEO_SETTINGS,
        codec: "h265" as const,
      };

      const h264Time = exportEngine.estimateExportTime(project, h264Settings);
      const h265Time = exportEngine.estimateExportTime(project, h265Settings);

      expect(h265Time).toBeGreaterThan(h264Time);
    });

    it("should estimate longer time for 4K", () => {
      const project = createMockProject({
        timeline: createMockTimeline({ duration: 60 }),
      });

      const hd = { ...DEFAULT_VIDEO_SETTINGS, width: 1920, height: 1080 };
      const fourK = { ...DEFAULT_VIDEO_SETTINGS, width: 3840, height: 2160 };

      const hdTime = exportEngine.estimateExportTime(project, hd);
      const fourKTime = exportEngine.estimateExportTime(project, fourK);

      expect(fourKTime).toBeGreaterThan(hdTime);
    });
  });

  describe("cancel", () => {
    it("should not throw when canceling without active export", () => {
      expect(() => exportEngine.cancel()).not.toThrow();
    });
  });

  describe("video export", () => {
    const writableStream = {
      seek: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    } as unknown as FileSystemWritableFileStream;

    async function drainVideoExport(
      settings = { ...DEFAULT_VIDEO_SETTINGS, frameRate: 1, width: 640, height: 360 },
    ): Promise<void> {
      const project = createMockProject({
        timeline: createMockTimeline({
          tracks: [
            createMockTrack({
              clips: [createMockClip({ duration: 1, outPoint: 1 })],
            }),
          ],
          duration: 1,
        }),
      });

      await exportEngine.initialize();
      const generator = exportEngine.exportVideo(project, settings, writableStream);

      while (true) {
        const { done } = await generator.next();
        if (done) break;
      }
    }

    function singleFrameProject(hasAudio = true): Project {
      const project = createMockProject({
        timeline: createMockTimeline({
          tracks: [createMockTrack({ clips: [createMockClip({ duration: 1, outPoint: 1 })] })],
          duration: 1,
        }),
      });
      const media = project.mediaLibrary.items[0];
      project.mediaLibrary.items[0] = { ...media, metadata: { ...media.metadata, hasAudio } };
      return project;
    }

    async function resultOf(generator: ReturnType<ExportEngine["exportVideo"]>) {
      for (;;) {
        const result = await generator.next();
        if (result.done) return result.value;
      }
    }

    it("rejects an empty timeline before starting codecs or GPU work", async () => {
      await exportEngine.initialize();
      const project = createMockProject();
      const result = await resultOf(exportEngine.exportVideo(project, {}, writableStream));
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/timeline is empty/i);
      expect(writableStream.abort).toHaveBeenCalled();
      expect(mockOutputStart).not.toHaveBeenCalled();
      expect(mockVideoEngine.initializeGPUCompositor).not.toHaveBeenCalled();
    });

    it("allows a scoped native backend when MediaBunny is unavailable", async () => {
      await exportEngine.initialize();
      (exportEngine as unknown as { mediabunny: unknown }).mediabunny = null;
      const backend = {
        requiresWebCodecsClamping: false, needsFrameThrottling: false, normalizesProResToH264: false, audioBeforeVideo: false,
        start: vi.fn().mockResolvedValue(undefined), addVideoFrame: vi.fn().mockResolvedValue(undefined),
        addAudioBuffer: vi.fn(), closeAudio: vi.fn(), getBytesWritten: vi.fn().mockReturnValue(100),
        finalize: vi.fn().mockResolvedValue(undefined), abort: vi.fn().mockResolvedValue(undefined),
      };
      const factory = vi.fn().mockReturnValue(backend);
      const result = await resultOf(exportEngine.exportVideo(singleFrameProject(false), {
        ...DEFAULT_VIDEO_SETTINGS, frameRate: 1, width: 640, height: 360,
      }, writableStream, factory));
      expect(result.success).toBe(true);
      expect(factory).toHaveBeenCalledWith(null);
      expect(backend.finalize).toHaveBeenCalledOnce();
    });

    it("discards the destination if a scoped backend cannot be created", async () => {
      await exportEngine.initialize();
      const factory = vi.fn(() => { throw new Error("backend unavailable"); });
      const result = await resultOf(exportEngine.exportVideo(singleFrameProject(false), {
        ...DEFAULT_VIDEO_SETTINGS, frameRate: 1, width: 640, height: 360,
      }, writableStream, factory));
      expect(result.error?.message).toBe("backend unavailable");
      expect(writableStream.abort).toHaveBeenCalled();
    });

    it("exports silent timelines without requiring any audio encoder", async () => {
      mockGetFirstEncodableAudioCodec.mockResolvedValue(null);
      await exportEngine.initialize();
      const result = await resultOf(exportEngine.exportVideo(singleFrameProject(false), {
        ...DEFAULT_VIDEO_SETTINGS, frameRate: 1, width: 640, height: 360,
      }, writableStream));
      expect(result.success).toBe(true);
      expect(mockGetFirstEncodableAudioCodec).not.toHaveBeenCalled();
      expect(mockRenderAudio).not.toHaveBeenCalled();
      expect(mockOutputFinalize).toHaveBeenCalledTimes(1);
    });

    it("fails visibly rather than dropping audio when the browser has no supported audio codec", async () => {
      mockGetFirstEncodableAudioCodec.mockResolvedValue(null);
      vi.stubGlobal("AudioEncoder", { isConfigSupported: vi.fn().mockResolvedValue({ supported: false }) });
      await exportEngine.initialize();
      const result = await resultOf(exportEngine.exportVideo(singleFrameProject(), {
        ...DEFAULT_VIDEO_SETTINGS, frameRate: 1, width: 640, height: 360,
      }, writableStream));
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/no supported audio encoder/i);
      expect(mockOutputStart).not.toHaveBeenCalled();
      expect(writableStream.abort).toHaveBeenCalled();
    });

    it("cancels a stuck encoder startup and aborts its file and muxer", async () => {
      mockOutputStart.mockImplementationOnce(() => new Promise(() => {}));
      await exportEngine.initialize();
      const generator = exportEngine.exportVideo(singleFrameProject(), {
        ...DEFAULT_VIDEO_SETTINGS, frameRate: 1, width: 640, height: 360,
      }, writableStream);
      expect((await generator.next()).value).toMatchObject({ phase: "preparing" });
      const pending = generator.next();
      await vi.waitFor(() => expect(mockOutputStart).toHaveBeenCalled());
      exportEngine.cancel();
      const result = await pending;
      expect(result.done).toBe(true);
      if (result.done) expect(result.value.error?.code).toBe("CANCELLED");
      expect(mockOutputCancel).toHaveBeenCalled();
      expect(writableStream.abort).toHaveBeenCalled();
      expect(mockVideoEngine.clearCache).toHaveBeenCalled();
    });

    it("releases a frame if encoding fails", async () => {
      const close = vi.fn();
      mockRenderFrame.mockResolvedValue({ image: { close }, width: 640, height: 360 });
      mockVideoSourceAdd.mockRejectedValueOnce(new Error("encoder failed"));
      await exportEngine.initialize();
      const result = await resultOf(exportEngine.exportVideo(singleFrameProject(false), {
        ...DEFAULT_VIDEO_SETTINGS, frameRate: 1, width: 640, height: 360,
      }, writableStream));
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/encoder failed/);
      expect(close).toHaveBeenCalled();
      expect(writableStream.abort).toHaveBeenCalled();
    });

    it.each([
      { format: "mp3", output: "MockMp3OutputFormat", codec: "mp3", mime: "audio/mpeg" },
      { format: "aac", output: "MockAdtsOutputFormat", codec: "aac", mime: "audio/aac" },
      { format: "flac", output: "MockFlacOutputFormat", codec: "flac", mime: "audio/flac" },
      { format: "ogg", output: "MockOggOutputFormat", codec: "opus", mime: "audio/ogg" },
    ] as const)("uses the real $format muxer and codec instead of returning WAV", async ({ format, output, codec, mime }) => {
      const buffer = { sampleRate: 48000, numberOfChannels: 2, length: 48000 };
      mockRenderAudio.mockResolvedValueOnce({ buffer });
      mockGetFirstEncodableAudioCodec.mockImplementationOnce(async (codecs) => codecs[0]);
      await exportEngine.initialize();
      const generator = exportEngine.exportAudio(singleFrameProject(), { format, sampleRate: 48000, channels: 2, bitrate: 192 });
      let result;
      do { result = await generator.next(); } while (!result.done);
      expect(result.value.success).toBe(true);
      expect(result.value.blob?.type).toBe(mime);
      expect(mockRenderAudio).toHaveBeenCalledWith(expect.anything(), 0, 1, { requireDecodableAudio: true, sampleRate: 48000, channels: 2 });
      expect(mockOutputFormats).toContain(output);
      expect(mockAudioSourceConfigs.at(-1)).toMatchObject({ codec, bitrate: 192000 });
    });

    it("reports unsupported compressed audio rather than returning a mislabeled WAV", async () => {
      mockRenderAudio.mockResolvedValueOnce({ buffer: { sampleRate: 48000, numberOfChannels: 2, length: 48000 } });
      mockGetFirstEncodableAudioCodec.mockResolvedValueOnce(null);
      await exportEngine.initialize();
      const generator = exportEngine.exportAudio(singleFrameProject(), { format: "flac" });
      let result;
      do { result = await generator.next(); } while (!result.done);
      expect(result.value.success).toBe(false);
      expect(result.value.error?.message).toMatch(/cannot encode FLAC/i);
      expect(result.value.blob).toBeUndefined();
    });

    it("writes WAV headers using the rendered buffer's actual sample rate", async () => {
      const samples = new Float32Array([0, 0.5, -0.5, 0]);
      mockRenderAudio.mockResolvedValueOnce({ buffer: { sampleRate: 44100, numberOfChannels: 1, length: samples.length, getChannelData: () => samples } });
      await exportEngine.initialize();
      const generator = exportEngine.exportAudio(singleFrameProject(), { format: "wav", sampleRate: 48000, channels: 2, bitDepth: 32 });
      let result;
      do { result = await generator.next(); } while (!result.done);
      expect(result.value.success).toBe(true);
      const bytes = await result.value.blob!.arrayBuffer();
      expect(new DataView(bytes).getUint32(24, true)).toBe(44100);
    });

    it("rejects a 32-bit float WAV beyond the RIFF size limit before allocating it", async () => {
      mockRenderAudio.mockResolvedValueOnce({ buffer: { sampleRate: 48000, numberOfChannels: 1, length: 0x40000000, getChannelData: () => { throw new Error("should not read samples"); } } });
      await exportEngine.initialize();
      const audio = exportEngine.exportAudio(singleFrameProject(), { format: "wav", bitDepth: 32 });
      let result;
      do { result = await audio.next(); } while (!result.done);
      expect(result.value.success).toBe(false);
      expect(result.value.error?.message).toMatch(/4 GiB RIFF/);
    });

    it("falls back to JavaScript if WAV acceleration does not load promptly", async () => {
      const samples = Float32Array.of(0, 0.5, -0.5, 0);
      mockRenderAudio.mockResolvedValueOnce({ buffer: { sampleRate: 48000, numberOfChannels: 1, length: samples.length, getChannelData: () => samples } });
      const load = vi.spyOn(getWavEncoder(), "ensureWasm").mockReturnValue(new Promise(() => {}));
      try {
        await exportEngine.initialize();
        const audio = exportEngine.exportAudio(singleFrameProject(), { format: "wav", bitDepth: 16 });
        expect((await audio.next()).value).toMatchObject({ phase: "preparing" });
        expect((await audio.next()).value).toMatchObject({ phase: "encoding" });
        vi.useFakeTimers();
        const pending = audio.next();
        await vi.advanceTimersByTimeAsync(3000);
        expect((await pending).value).toMatchObject({ phase: "complete" });
        const result = await audio.next();
        expect(result.done && result.value.success).toBe(true);
        if (result.done) {
          const bytes = await result.value.blob!.arrayBuffer();
          expect(new DataView(bytes).getInt16(46, true)).toBe(16384);
        }
        expect(load).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
        load.mockRestore();
      }
    });

    it("cancels while WAV acceleration is loading", async () => {
      const samples = Float32Array.of(0.5);
      mockRenderAudio.mockResolvedValueOnce({ buffer: { sampleRate: 48000, numberOfChannels: 1, length: samples.length, getChannelData: () => samples } });
      const load = vi.spyOn(getWavEncoder(), "ensureWasm").mockReturnValue(new Promise(() => {}));
      try {
        await exportEngine.initialize();
        const audio = exportEngine.exportAudio(singleFrameProject(), { format: "wav", bitDepth: 16 });
        await audio.next();
        await audio.next();
        const pending = audio.next();
        expect(load).toHaveBeenCalledOnce();
        exportEngine.cancel();
        const result = await pending;
        expect(result.done && result.value.error?.code).toBe("CANCELLED");
      } finally {
        load.mockRestore();
      }
    });

    it("does not leave the video-export lock held after an empty audio export", async () => {
      await exportEngine.initialize();
      const audio = await exportEngine.exportAudio(createMockProject(), { format: "wav" }).next();
      expect(audio.done).toBe(true);
      if (audio.done) expect(audio.value.error?.message).toMatch(/timeline is empty/i);
      const video = await resultOf(exportEngine.exportVideo(singleFrameProject(false), {
        ...DEFAULT_VIDEO_SETTINGS, frameRate: 1, width: 640, height: 360,
      }, writableStream));
      expect(video.success).toBe(true);
    });

    it("cancels a stalled audio-only render and releases the export lock", async () => {
      mockRenderAudio.mockReturnValueOnce(new Promise(() => {}));
      await exportEngine.initialize();
      const audio = exportEngine.exportAudio(singleFrameProject(), { format: "wav" });
      expect((await audio.next()).value).toMatchObject({ phase: "preparing" });
      const pending = audio.next();
      await vi.waitFor(() => expect(mockRenderAudio).toHaveBeenCalled());
      exportEngine.cancel();
      const result = await pending;
      expect(result.done).toBe(true);
      if (result.done) expect(result.value.error?.code).toBe("CANCELLED");
      const video = await resultOf(exportEngine.exportVideo(singleFrameProject(false), {
        ...DEFAULT_VIDEO_SETTINGS, frameRate: 1, width: 640, height: 360,
      }, writableStream));
      expect(video.success).toBe(true);
    });

    it("does not let audio or image-sequence exports replace an active video export", async () => {
      await exportEngine.initialize();
      const video = exportEngine.exportVideo(singleFrameProject(false), {
        ...DEFAULT_VIDEO_SETTINGS, frameRate: 1, width: 640, height: 360,
      }, writableStream);
      await video.next();
      const audio = await exportEngine.exportAudio(singleFrameProject(), { format: "wav" }).next();
      const sequence = await exportEngine.exportImageSequence(singleFrameProject()).next();
      expect(audio.done && audio.value.error?.code).toBe("ENCODER_INIT_FAILED");
      expect(sequence.done && sequence.value.error?.code).toBe("ENCODER_INIT_FAILED");
      await video.return({ success: false });
      expect(writableStream.abort).toHaveBeenCalled();
    });

    it("should render long export audio in chunks and clear cached audio", async () => {
      const project = createMockProject({
        timeline: createMockTimeline({
          tracks: [
            createMockTrack({
              clips: [createMockClip({ duration: 40, outPoint: 40 })],
            }),
          ],
          duration: 40,
        }),
      });

      mockRenderAudio.mockResolvedValue({ buffer: { duration: 15 } });

      await exportEngine.initialize();

      const writableStream = {
        seek: vi.fn().mockResolvedValue(undefined),
        write: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        abort: vi.fn().mockResolvedValue(undefined),
      } as unknown as FileSystemWritableFileStream;

      const generator = exportEngine.exportVideo(
        project,
        { ...DEFAULT_VIDEO_SETTINGS, frameRate: 1, width: 640, height: 360 },
        writableStream,
      );

      while (true) {
        const { done } = await generator.next();
        if (done) break;
      }

      expect(mockRenderAudio).toHaveBeenCalledTimes(3);
      expect(mockRenderAudio).toHaveBeenNthCalledWith(1, project, 0, 15, { requireDecodableAudio: true });
      expect(mockRenderAudio).toHaveBeenNthCalledWith(2, project, 15, 15, { requireDecodableAudio: true });
      expect(mockRenderAudio).toHaveBeenNthCalledWith(3, project, 30, 10, { requireDecodableAudio: true });
      expect(mockAudioSourceAdd).toHaveBeenCalledTimes(3);
      expect(mockAudioEngine.clearCache).toHaveBeenCalled();
    });

    it("prefers hardware WebCodecs for the default browser backend", async () => {
      mockGetFirstEncodableVideoCodec.mockImplementation(async (codecs) => codecs[0]);

      await drainVideoExport();

      expect(mockGetFirstEncodableVideoCodec).toHaveBeenCalledWith(
        ["avc"],
        expect.objectContaining({ hardwareAcceleration: "prefer-hardware" }),
      );
      expect(mockVideoSourceConfigs[0]).toMatchObject({
        codec: "avc",
        hardwareAcceleration: "prefer-hardware",
      });
    });

    it("keeps decoder caches warm while throttling browser exports", async () => {
      await drainVideoExport({
        ...DEFAULT_VIDEO_SETTINGS,
        frameRate: 5,
        width: 640,
        height: 360,
      });

      // Caches are released once before muxing and once by the final safety
      // cleanup, but never in the middle of the five-frame render loop.
      expect(mockVideoEngine.clearVideoElementCache).toHaveBeenCalledTimes(2);
      expect(mockVideoEngine.clearCache).toHaveBeenCalledTimes(2);
      expect(mockMediaEngine.clearFrameCache).toHaveBeenCalledTimes(2);
    });

    it("falls back to no-preference when hardware WebCodecs is unavailable", async () => {
      mockGetFirstEncodableVideoCodec.mockImplementation(async (_codecs, options) =>
        options.hardwareAcceleration === "prefer-hardware" ? null : "avc",
      );

      await drainVideoExport();

      expect(mockGetFirstEncodableVideoCodec).toHaveBeenNthCalledWith(
        1,
        ["avc"],
        expect.objectContaining({ hardwareAcceleration: "prefer-hardware" }),
      );
      expect(mockGetFirstEncodableVideoCodec).toHaveBeenNthCalledWith(
        2,
        ["avc"],
        expect.objectContaining({ hardwareAcceleration: "no-preference" }),
      );
      expect(mockVideoSourceConfigs[0]).toMatchObject({
        codec: "avc",
        hardwareAcceleration: "no-preference",
      });
    });

    it("fails visibly if the requested codec is unavailable instead of using another", async () => {
      mockGetFirstEncodableVideoCodec.mockResolvedValue(null);
      await exportEngine.initialize();
      const result = await resultOf(exportEngine.exportVideo(singleFrameProject(false), {
        ...DEFAULT_VIDEO_SETTINGS, codec: "h265", frameRate: 1, width: 640, height: 360,
      }, writableStream));
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/cannot encode H265/i);
      expect(mockGetFirstEncodableVideoCodec).toHaveBeenCalledWith(["hevc"], expect.anything());
      expect(mockOutputStart).not.toHaveBeenCalled();
    });

    it("rejects an incompatible codec and container", async () => {
      await exportEngine.initialize();
      const result = await resultOf(exportEngine.exportVideo(singleFrameProject(false), {
        ...DEFAULT_VIDEO_SETTINGS, codec: "vp9", format: "mp4", frameRate: 1, width: 640, height: 360,
      }, writableStream));
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/VP9 cannot be stored in MP4/i);
      expect(mockOutputStart).not.toHaveBeenCalled();
    });

    it("encodes only the requested codec instead of silently changing it", async () => {
      mockGetFirstEncodableVideoCodec.mockImplementation(async (codecs) => codecs[0]);

      await drainVideoExport({
        ...DEFAULT_VIDEO_SETTINGS,
        codec: "h265",
        frameRate: 1,
        width: 640,
        height: 360,
      });

      expect(mockGetFirstEncodableVideoCodec).toHaveBeenCalledWith(
        ["hevc"],
        expect.objectContaining({ hardwareAcceleration: "prefer-hardware" }),
      );
      expect(mockVideoSourceConfigs[0]).toMatchObject({
        codec: "hevc",
      });
    });
  });

  describe("dispose", () => {
    it("should reset state on dispose", () => {
      exportEngine.dispose();
      expect(exportEngine.isInitialized()).toBe(false);
      expect(exportEngine.isMediaBunnyAvailable()).toBe(false);
    });
  });
});

describe("Export Types and Defaults", () => {
  describe("DEFAULT_VIDEO_SETTINGS", () => {
    it("should have correct default format", () => {
      expect(DEFAULT_VIDEO_SETTINGS.format).toBe("mp4");
    });

    it("should have correct default codec", () => {
      expect(DEFAULT_VIDEO_SETTINGS.codec).toBe("h264");
    });

    it("should have correct default resolution", () => {
      expect(DEFAULT_VIDEO_SETTINGS.width).toBe(1920);
      expect(DEFAULT_VIDEO_SETTINGS.height).toBe(1080);
    });

    it("should have correct default frame rate", () => {
      expect(DEFAULT_VIDEO_SETTINGS.frameRate).toBe(30);
    });

    it("should have audio settings", () => {
      expect(DEFAULT_VIDEO_SETTINGS.audioSettings).toBeDefined();
      expect(DEFAULT_VIDEO_SETTINGS.audioSettings.sampleRate).toBe(48000);
    });
  });

  describe("DEFAULT_AUDIO_SETTINGS", () => {
    it("should have correct defaults", () => {
      expect(DEFAULT_AUDIO_SETTINGS.format).toBe("mp3");
      expect(DEFAULT_AUDIO_SETTINGS.sampleRate).toBe(48000);
      expect(DEFAULT_AUDIO_SETTINGS.bitrate).toBe(320);
      expect(DEFAULT_AUDIO_SETTINGS.channels).toBe(2);
    });
  });

  describe("DEFAULT_IMAGE_SETTINGS", () => {
    it("should have correct defaults", () => {
      expect(DEFAULT_IMAGE_SETTINGS.format).toBe("jpg");
      expect(DEFAULT_IMAGE_SETTINGS.quality).toBe(90);
      expect(DEFAULT_IMAGE_SETTINGS.width).toBe(1920);
      expect(DEFAULT_IMAGE_SETTINGS.height).toBe(1080);
    });
  });

  describe("VIDEO_QUALITY_PRESETS", () => {
    it("should have 4K preset", () => {
      expect(VIDEO_QUALITY_PRESETS["4k"]).toBeDefined();
      expect(VIDEO_QUALITY_PRESETS["4k"].width).toBe(3840);
      expect(VIDEO_QUALITY_PRESETS["4k"].height).toBe(2160);
    });

    it("should have 1080p preset", () => {
      expect(VIDEO_QUALITY_PRESETS["1080p"]).toBeDefined();
      expect(VIDEO_QUALITY_PRESETS["1080p"].width).toBe(1920);
      expect(VIDEO_QUALITY_PRESETS["1080p"].height).toBe(1080);
    });

    it("should have 720p preset", () => {
      expect(VIDEO_QUALITY_PRESETS["720p"]).toBeDefined();
      expect(VIDEO_QUALITY_PRESETS["720p"].width).toBe(1280);
      expect(VIDEO_QUALITY_PRESETS["720p"].height).toBe(720);
    });

    it("should have higher bitrate for 4K than 1080p", () => {
      expect(VIDEO_QUALITY_PRESETS["4k"].bitrate).toBeGreaterThan(
        VIDEO_QUALITY_PRESETS["1080p"].bitrate,
      );
    });
  });
});
