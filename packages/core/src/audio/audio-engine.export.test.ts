import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../types/project";
import type { AudioClipRenderInfo } from "./types";

const { extractAudioWav } = vi.hoisted(() => ({ extractAudioWav: vi.fn() }));
vi.mock("../media/extract-audio", () => ({ extractAudioWav }));

import { AudioEngine } from "./audio-engine";

type AudioInternals = {
  getAudioBuffer(media: MediaItem, context: BaseAudioContext, track?: number): Promise<AudioBuffer | null>;
  shouldUseSegmentedAudioDecoding(media: MediaItem, clip: AudioClipRenderInfo): boolean;
  renderClipToContext(context: OfflineAudioContext, media: MediaItem, clip: AudioClipRenderInfo, start: number, strict: boolean): Promise<void>;
  renderClipToContextFromSegments(context: OfflineAudioContext, media: MediaItem, clip: AudioClipRenderInfo, start: number): Promise<boolean>;
  getSegmentedAudioDecoder(media: MediaItem, track: number): Promise<unknown>;
  createClipOutputNodes(context: OfflineAudioContext, clip: AudioClipRenderInfo): { volumeGainNode: GainNode; fadeGainNode: GainNode; pannerNode: StereoPannerNode };
  applyVolumeAutomation(node: GainNode, clip: AudioClipRenderInfo, start: number): void;
  applyFades(node: GainNode, clip: AudioClipRenderInfo, start: number): void;
  processClipBuffer(buffer: AudioBuffer, clip: AudioClipRenderInfo): Promise<{ buffer: AudioBuffer; startOffset: number; renderDuration: number }>;
};

function video(): MediaItem {
  return {
    id: "video", name: "short-video.mp4", type: "video", blob: new Blob(["video"]),
    metadata: { duration: 3, hasAudio: true },
  } as MediaItem;
}
function clip(overrides: Partial<AudioClipRenderInfo> = {}): AudioClipRenderInfo {
  return { mediaId: "video", effects: [], speed: 1, reversed: false, sourceTime: 0, duration: 1, timelineStartTime: 0, ...overrides } as AudioClipRenderInfo;
}

describe("export audio decoding", () => {
  let engine: AudioEngine;
  let internal: AudioInternals;
  beforeEach(() => {
    engine = new AudioEngine();
    internal = engine as unknown as AudioInternals;
    vi.clearAllMocks();
  });

  it("uses segmented decoding for short simple clips, but preserves effects, speed and reverse paths", () => {
    expect(internal.shouldUseSegmentedAudioDecoding(video(), clip())).toBe(true);
    expect(internal.shouldUseSegmentedAudioDecoding(video(), clip({ speed: 2 }))).toBe(false);
    expect(internal.shouldUseSegmentedAudioDecoding(video(), clip({ reversed: true }))).toBe(false);
    expect(internal.shouldUseSegmentedAudioDecoding(video(), clip({ effects: [{ enabled: true }] as AudioClipRenderInfo["effects"] }))).toBe(false);
  });

  it("decodes the primary video audio in the browser before attempting FFmpeg", async () => {
    const decoded = { duration: 3 } as AudioBuffer;
    const decodeAudioData = vi.fn().mockResolvedValue(decoded);
    expect(await internal.getAudioBuffer(video(), { decodeAudioData } as unknown as BaseAudioContext)).toBe(decoded);
    expect(decodeAudioData).toHaveBeenCalledTimes(1);
    expect(extractAudioWav).not.toHaveBeenCalled();
  });

  it("falls back to FFmpeg when browser decoding cannot handle the container", async () => {
    const decoded = { duration: 3 } as AudioBuffer;
    const decodeAudioData = vi.fn().mockRejectedValueOnce(new Error("unsupported")).mockResolvedValueOnce(decoded);
    extractAudioWav.mockResolvedValue(new Blob(["wav"]));
    expect(await internal.getAudioBuffer(video(), { decodeAudioData } as unknown as BaseAudioContext)).toBe(decoded);
    expect(extractAudioWav).toHaveBeenCalledWith(expect.any(Blob), 0);
    expect(decodeAudioData).toHaveBeenCalledTimes(2);
  });

  it("uses explicit extraction for a non-primary audio stream", async () => {
    const decoded = { duration: 3 } as AudioBuffer;
    const decodeAudioData = vi.fn().mockResolvedValue(decoded);
    extractAudioWav.mockResolvedValue(new Blob(["wav"]));
    expect(await internal.getAudioBuffer(video(), { decodeAudioData } as unknown as BaseAudioContext, 1)).toBe(decoded);
    expect(extractAudioWav).toHaveBeenCalledWith(expect.any(Blob), 1);
    expect(decodeAudioData).toHaveBeenCalledTimes(1);
  });

  it("does not silently export when a source that should have audio cannot be decoded", async () => {
    const getBuffer = vi.spyOn(internal, "getAudioBuffer").mockResolvedValue(null);
    const context = {} as OfflineAudioContext;
    const unsupported = clip({ speed: 2 });
    await expect(internal.renderClipToContext(context, video(), unsupported, 0, true)).rejects.toThrow('Could not decode audio from "short-video.mp4"');
    await expect(internal.renderClipToContext(context, video(), unsupported, 0, false)).resolves.toBeUndefined();
    getBuffer.mockRestore();
  });

  it("reports an error if both segmented and fallback decoders fail", async () => {
    vi.spyOn(console, "warn").mockImplementationOnce(() => {});
    vi.spyOn(internal, "renderClipToContextFromSegments").mockRejectedValue(new Error("decoder failed"));
    const fallback = vi.spyOn(internal, "getAudioBuffer").mockResolvedValue(null);
    await expect(internal.renderClipToContext({} as OfflineAudioContext, video(), clip(), 0, true)).rejects.toThrow('Could not decode audio from "short-video.mp4"');
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("uses the full decoder if segmented decoding fails but the source is playable", async () => {
    vi.spyOn(console, "warn").mockImplementationOnce(() => {});
    vi.spyOn(internal, "renderClipToContextFromSegments").mockRejectedValue(new Error("segmented decoder unsupported"));
    const buffer = { duration: 3 } as AudioBuffer;
    vi.spyOn(internal, "getAudioBuffer").mockResolvedValue(buffer);
    vi.spyOn(internal, "createClipOutputNodes").mockReturnValue({ volumeGainNode: {}, fadeGainNode: {}, pannerNode: {} } as never);
    vi.spyOn(internal, "applyVolumeAutomation").mockImplementation(() => {});
    vi.spyOn(internal, "applyFades").mockImplementation(() => {});
    vi.spyOn(internal, "processClipBuffer").mockResolvedValue({ buffer, startOffset: 0, renderDuration: 1 });
    const source = { playbackRate: { value: 1 }, connect: vi.fn(), start: vi.fn(), buffer: null };
    const context = { createBufferSource: () => source } as unknown as OfflineAudioContext;
    await expect(internal.renderClipToContext(context, video(), clip(), 0, true)).resolves.toBeUndefined();
    expect(source.start).toHaveBeenCalledOnce();
  });

  it("disconnects partially scheduled segments before a decoder fallback", async () => {
    const decoder = {
      async *buffers() {
        yield { timestamp: 0, duration: 0.5, buffer: {} as AudioBuffer };
        throw new Error("decoder stopped mid-clip");
      },
    };
    vi.spyOn(internal, "getSegmentedAudioDecoder").mockResolvedValue(decoder);
    vi.spyOn(internal, "createClipOutputNodes").mockReturnValue({ volumeGainNode: {}, fadeGainNode: {}, pannerNode: {} } as never);
    vi.spyOn(internal, "applyVolumeAutomation").mockImplementation(() => {});
    vi.spyOn(internal, "applyFades").mockImplementation(() => {});
    const source = { connect: vi.fn(), start: vi.fn(), disconnect: vi.fn(), buffer: null };
    const context = { createBufferSource: () => source } as unknown as OfflineAudioContext;
    await expect(internal.renderClipToContextFromSegments(context, video(), clip(), 0)).rejects.toThrow("decoder stopped mid-clip");
    expect(source.start).toHaveBeenCalledOnce();
    expect(source.disconnect).toHaveBeenCalledOnce();
  });
});
