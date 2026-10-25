import { describe, expect, it, vi, afterEach } from "vitest";
import { frameRate, createReferenceProfile, type ReferenceProfile } from "@kove-advanced/core";

vi.mock("../multicam-transcription", () => ({
  transcribeWithWordTimestamps: vi.fn(),
}));
vi.mock("@kove-advanced/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@kove-advanced/core")>();
  return {
    ...original,
    getBeatDetectionEngine: vi.fn(() => ({
      analyzeAudioBuffer: vi.fn(async () => ({
        bpm: 120,
        confidence: 0.9,
        beats: [{ time: 0.5, strength: 1, index: 0 }, { time: 1.0, strength: 1, index: 1 }],
        duration: 10,
        downbeats: [],
      })),
    })),
  };
});

import { enrichReferenceWithAudio } from "./enrich-reference-audio";
import { transcribeWithWordTimestamps } from "../multicam-transcription";

const transcribeMock = vi.mocked(transcribeWithWordTimestamps);

function measuredProfile(): ReferenceProfile {
  return createReferenceProfile({
    fps: frameRate(30, 1),
    fpsSource: "ffprobe",
    durationFrames: 300,
    aspectRatio: { width: 1920, height: 1080 },
    shots: [{ startFrame: 0, endFrame: 300, captionWindows: [] }],
    beatGridMs: [],
  });
}

/** Minimal AudioBuffer stand-in for the decode stub. */
function fakeAudioBuffer(duration = 10): AudioBuffer {
  return {
    duration,
    sampleRate: 48_000,
    length: Math.round(duration * 48_000),
    numberOfChannels: 1,
    getChannelData: () => new Float32Array(0),
  } as unknown as AudioBuffer;
}

function stubAudioContext(options: { decodeFails?: boolean } = {}): void {
  // The global test setup installs a writable (non-configurable) AudioContext
  // mock, so direct assignment is the supported override path here.
  window.AudioContext = class {
    async decodeAudioData(): Promise<AudioBuffer> {
      if (options.decodeFails) throw new Error("no audio track");
      return fakeAudioBuffer();
    }
    async close(): Promise<void> {}
  } as unknown as typeof AudioContext;
}

const originalAudioContext = window.AudioContext;

// jsdom's Blob predates Blob.arrayBuffer; production browsers all have it.
if (typeof Blob.prototype.arrayBuffer !== "function") {
  Object.defineProperty(Blob.prototype, "arrayBuffer", {
    configurable: true,
    value(this: Blob): Promise<ArrayBuffer> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(this);
      });
    },
  });
}

afterEach(() => {
  window.AudioContext = originalAudioContext;
  vi.clearAllMocks();
});

describe("enrichReferenceWithAudio", () => {
  it("attaches caption windows and the beat grid from local analysis", async () => {
    stubAudioContext();
    transcribeMock.mockResolvedValue([{ text: "hello", start: 1.0, end: 1.4 }]);
    const enriched = await enrichReferenceWithAudio(new Blob([new Uint8Array([1])]), measuredProfile());
    expect(enriched.shots[0]!.captionWindows).toEqual([{ startFrame: 30, endFrame: 42, text: "hello" }]);
    expect(enriched.beatGridMs).toEqual([500, 1000]);
    expect(enriched.warnings ?? []).toHaveLength(0);
    expect(transcribeMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the measured profile and warns when audio cannot be decoded", async () => {
    stubAudioContext({ decodeFails: true });
    const enriched = await enrichReferenceWithAudio(new Blob([new Uint8Array([1])]), measuredProfile());
    expect(enriched.beatGridMs).toEqual([]);
    expect(enriched.shots[0]!.captionWindows).toEqual([]);
    expect(enriched.warnings?.join(" ")).toMatch(/audio could not be decoded/i);
    expect(transcribeMock).not.toHaveBeenCalled();
  });

  it("still attaches the beat grid when transcription fails", async () => {
    stubAudioContext();
    transcribeMock.mockRejectedValue(new Error("model unavailable"));
    const enriched = await enrichReferenceWithAudio(new Blob([new Uint8Array([1])]), measuredProfile());
    expect(enriched.beatGridMs).toEqual([500, 1000]);
    expect(enriched.shots[0]!.captionWindows).toEqual([]);
    expect(enriched.warnings?.join(" ")).toMatch(/transcription failed/i);
  });

  it("stops instead of warning when the turn is cancelled mid-transcription", async () => {
    stubAudioContext();
    transcribeMock.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const enrichment = enrichReferenceWithAudio(
      new Blob([new Uint8Array([1])]),
      measuredProfile(),
      { transcriptionTimeoutMs: 5_000, signal: controller.signal },
    );
    controller.abort();

    const error = await enrichment.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
  });

  it("gives up on a transcription that never answers instead of blocking the turn", async () => {
    stubAudioContext();
    // A model host that accepts the connection but never responds: the promise
    // stays pending forever, so the stage has to have a ceiling of its own.
    transcribeMock.mockImplementation(() => new Promise(() => {}));
    const enriched = await enrichReferenceWithAudio(
      new Blob([new Uint8Array([1])]),
      measuredProfile(),
      { transcriptionTimeoutMs: 20 },
    );
    expect(enriched.beatGridMs).toEqual([500, 1000]);
    expect(enriched.shots[0]!.captionWindows).toEqual([]);
    expect(enriched.warnings?.join(" ")).toMatch(/transcription failed/i);
    expect(transcribeMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeoutMs: 20 }),
    );
  });
});
