import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildWavHeader,
  encodeAudioBufferToPcm16,
  initialNativeFrameCredits,
  NativeFFmpegBackend,
} from "./native-ffmpeg-backend";

function fakeAudioBuffer(
  channels: number[][],
  sampleRate = 48000,
): AudioBuffer {
  return {
    length: channels[0]?.length ?? 0,
    numberOfChannels: channels.length,
    sampleRate,
    getChannelData: (index: number) =>
      new Float32Array(channels[Math.min(index, channels.length - 1)] ?? []),
  } as AudioBuffer;
}

function ascii(buffer: ArrayBuffer, start: number, end: number): string {
  return String.fromCharCode(...new Uint8Array(buffer.slice(start, end)));
}

describe("native ffmpeg backend helpers", () => {
  it("keeps sequential frame decoder caches warm", () => {
    expect(new NativeFFmpegBackend(() => "/tmp/export.mp4").needsFrameThrottling).toBe(false);
  });

  it("caps in-flight raw frame credits by memory size", () => {
    expect(initialNativeFrameCredits(1920, 1080)).toBe(10);
    expect(initialNativeFrameCredits(3840, 2160)).toBe(4);
    expect(initialNativeFrameCredits(7680, 4320)).toBe(1);
  });

  it("builds a valid PCM WAV header for the final data length", () => {
    const header = buildWavHeader(48000, 2, 48000);
    const view = new DataView(header);

    expect(header.byteLength).toBe(44);
    expect(ascii(header, 0, 4)).toBe("RIFF");
    expect(ascii(header, 8, 12)).toBe("WAVE");
    expect(ascii(header, 36, 40)).toBe("data");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint32(40, true)).toBe(48000 * 2 * 2);
    expect(view.getUint32(4, true)).toBe(36 + 48000 * 2 * 2);
  });

  it("encodes audio chunks directly to interleaved PCM16", () => {
    const buffer = fakeAudioBuffer([
      [-1, 0, 1],
      [0.5, -0.5, 0],
    ]);
    const pcm = encodeAudioBufferToPcm16(buffer, 2);
    const view = new DataView(pcm);

    expect(pcm.byteLength).toBe(12);
    expect(view.getInt16(0, true)).toBe(-32768);
    expect(view.getInt16(2, true)).toBe(16384);
    expect(view.getInt16(4, true)).toBe(0);
    expect(view.getInt16(6, true)).toBe(-16384);
    expect(view.getInt16(8, true)).toBe(32767);
    expect(view.getInt16(10, true)).toBe(0);
  });

  it("duplicates mono audio into requested output channels", () => {
    const buffer = fakeAudioBuffer([[0.25, -0.25]]);
    const pcm = encodeAudioBufferToPcm16(buffer, 2);
    const view = new DataView(pcm);

    expect(view.getInt16(0, true)).toBe(8192);
    expect(view.getInt16(2, true)).toBe(8192);
    expect(view.getInt16(4, true)).toBe(-8192);
    expect(view.getInt16(6, true)).toBe(-8192);
  });
});


describe("native export channel lifecycle", () => {
  const settings = { width: 16, height: 16, frameRate: 1, codec: "h264", format: "mp4", bitrate: 1000,
    audioSettings: { sampleRate: 48000, channels: 2 } } as never;
  const project = { timeline: { duration: 1 } } as never;
  const start = vi.fn();
  const cancel = vi.fn();
  const makePort = () => ({ start: vi.fn(), close: vi.fn(), postMessage: vi.fn(), onmessage: null }) as unknown as MessagePort;
  const sendPort = (jobId: string, port: MessagePort) => {
    const event = new MessageEvent("message", { data: { "__kove-advancedExportPort": true, jobId }, ports: [port] });
    window.dispatchEvent(event);
  };
  beforeEach(() => {
    vi.clearAllMocks();
    cancel.mockResolvedValue(undefined);
    (window as unknown as Record<string, unknown>)["kove-advanced"] = { export: { start, cancel } };
  });
  afterEach(() => { delete (window as unknown as Record<string, unknown>)["kove-advanced"]; });

  it("cleans the port listener when IPC startup fails", async () => {
    start.mockRejectedValueOnce(new Error("unsupported encoder"));
    const remove = vi.spyOn(window, "removeEventListener");
    const backend = new NativeFFmpegBackend(() => "/tmp/out.mp4");
    await expect(backend.start(settings, project)).rejects.toThrow("unsupported encoder");
    expect(remove).toHaveBeenCalledWith("message", expect.any(Function));
    remove.mockRestore();
  });

  it("matches out-of-order ports to their jobs without closing the other job's port", async () => {
    let resolveFirst!: (value: { jobId: string }) => void;
    let resolveSecond!: (value: { jobId: string }) => void;
    start.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve; }));
    const one = new NativeFFmpegBackend(() => "/tmp/one.mp4");
    const two = new NativeFFmpegBackend(() => "/tmp/two.mp4");
    const pendingOne = one.start(settings, project);
    const pendingTwo = two.start(settings, project);
    const portOne = makePort(), portTwo = makePort();
    sendPort("one", portOne);
    sendPort("two", portTwo);
    resolveSecond({ jobId: "two" });
    resolveFirst({ jobId: "one" });
    await Promise.all([pendingOne, pendingTwo]);
    expect(portOne.start).toHaveBeenCalledOnce();
    expect(portTwo.start).toHaveBeenCalledOnce();
    expect(portOne.close).not.toHaveBeenCalled();
    expect(portTwo.close).not.toHaveBeenCalled();
    await Promise.all([one.abort(), two.abort()]);
    expect(cancel).toHaveBeenCalledWith("one");
    expect(cancel).toHaveBeenCalledWith("two");
  });

  it("cancels a late-starting job after the caller already aborted", async () => {
    let resolveStart!: (value: { jobId: string }) => void;
    start.mockReturnValueOnce(new Promise((resolve) => { resolveStart = resolve; }));
    const backend = new NativeFFmpegBackend(() => "/tmp/out.mp4");
    const pending = backend.start(settings, project);
    const assertion = expect(pending).rejects.toThrow(/cancelled/i);
    await backend.abort();
    resolveStart({ jobId: "late" });
    await assertion;
    expect(cancel).toHaveBeenCalledWith("late");
  });

  it("closes a frame even when the backend has not started", async () => {
    const close = vi.fn();
    const backend = new NativeFFmpegBackend(() => "/tmp/out.mp4");
    await expect(backend.addVideoFrame({ close } as unknown as ImageBitmap, 0)).rejects.toThrow(/not started/i);
    expect(close).toHaveBeenCalledOnce();
  });
});
