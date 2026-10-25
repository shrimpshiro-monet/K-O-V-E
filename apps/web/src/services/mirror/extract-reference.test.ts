import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  openIndexedVideoFrames: vi.fn(),
}));

vi.mock("@kove-advanced/core/mirror/decoded-frames", () => ({
  openIndexedVideoFrames: h.openIndexedVideoFrames,
}));
vi.mock("@kove-advanced/core/vision/opencv-camera-motion", () => ({
  loadOpenCv: async () => { throw new Error("Optional OpenCV unavailable"); },
  extractFrameMotion: vi.fn(),
}));

import { extractReference, type ExtractReferenceOptions } from "./extract-reference";
import {
  REFERENCE_ANALYSIS_MAX_DIMENSION,
  REFERENCE_FRAME_BUDGET_MS,
  REFERENCE_MAX_FRAMES_PER_SLICE,
  isAbortError,
} from "./reference-measurement";

const originals = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
afterEach(() => {
  vi.restoreAllMocks();
  if (originals.createObjectURL) URL.createObjectURL = originals.createObjectURL;
  else delete (URL as { createObjectURL?: typeof URL.createObjectURL }).createObjectURL;
  if (originals.revokeObjectURL) URL.revokeObjectURL = originals.revokeObjectURL;
  else delete (URL as { revokeObjectURL?: typeof URL.revokeObjectURL }).revokeObjectURL;
});

beforeEach(() => {
  h.openIndexedVideoFrames.mockReset();
  h.openIndexedVideoFrames.mockResolvedValue(null);
});

function valueAt(frame: number): number {
  if (frame < 2) return 0;
  if (frame < 4) return 71; // earlier crossing: 71/255 > 0.23
  if (frame <= 16) return 224; // stronger jump at frame 4
  return Math.round(224 - (frame - 16) * 18); // gradual fade from frames 17..24
}

interface FixtureOptions {
  invalidAt?: number;
  decoderFailsAt?: number;
  /** Source frame size — the analysis buffer must not follow it. */
  sourceWidth?: number;
  sourceHeight?: number;
  /** Length of the synthetic clip; the default is the 32-frame cut fixture. */
  durationFrames?: number;
}

interface FixtureRecord {
  canvasSizes: Array<{ width: number; height: number }>;
  getImageDataSizes: Array<{ width: number; height: number }>;
}

/** An HTML-video fallback fixture; do not mistake these mocked pixels for
 * proof of accurate browser seeking on real footage. */
async function extractFixture(
  fixture: FixtureOptions = {},
  extractOptions: ExtractReferenceOptions = {},
  record: FixtureRecord = { canvasSizes: [], getImageDataSizes: [] },
) {
  URL.createObjectURL = vi.fn(() => "blob:synthetic");
  URL.revokeObjectURL = vi.fn();
  let currentTime = 0;
  const video = {
    duration: (fixture.durationFrames ?? 32) / 30, videoWidth: fixture.sourceWidth ?? 160, videoHeight: fixture.sourceHeight ?? 160, readyState: 2,
    preload: "", muted: false, src: "", onseeked: null as (() => void) | null,
    set onloadedmetadata(handler: (() => void) | null) { if (handler) queueMicrotask(handler); },
    set onloadeddata(_handler: (() => void) | null) {},
    set onerror(_handler: (() => void) | null) {},
    get currentTime() { return currentTime; },
    set currentTime(value: number) { currentTime = value; queueMicrotask(() => video.onseeked?.()); },
    removeAttribute: vi.fn(), load: vi.fn(),
  };
  const context = {
    drawImage: vi.fn(),
    getImageData: (_x: number, _y: number, width: number, height: number) => {
      record.getImageDataSizes.push({ width, height });
      const frame = Math.floor(currentTime * 30);
      if (frame === fixture.decoderFailsAt) throw new Error("Decoder failed");
      // An empty pixel buffer makes the existing sampled-RGB difference NaN.
      if (frame === fixture.invalidAt) return { data: new Uint8ClampedArray(0) };
      const intensity = valueAt(frame);
      const data = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = intensity; data[i + 1] = intensity; data[i + 2] = intensity; data[i + 3] = 255;
      }
      return { data };
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => {
      record.canvasSizes.push({ width: canvas.width, height: canvas.height });
      return context;
    },
  };
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) =>
    tag === "video" ? video : tag === "canvas" ? canvas : createElement(tag)) as typeof document.createElement);
  return extractReference(new Blob(["synthetic"]), { fps: { num: 30, den: 1 }, fpsSource: "user" }, extractOptions);
}

const intervals = (profile: Awaited<ReturnType<typeof extractReference>>) =>
  profile.shots.map(({ startFrame, endFrame }) => [startFrame, endFrame]);

/** A wall clock that only advances when the sampler reads it, so throttling and
 * work-budget behaviour are deterministic under Vitest's real timers. */
function steppingClock(stepMs: number): () => number {
  let elapsed = 0;
  return () => (elapsed += stepMs);
}

describe("extractReference peak boundary wiring", () => {
  it("selects the exact stronger cut, tiles half-open shots, and warns about a gradual transition", async () => {
    const profile = await extractFixture();
    expect(intervals(profile)).toEqual([[0, 4], [4, 17], [17, 32]]);
    expect(profile.warnings).toContain("Indexed WebCodecs decoder unavailable: HTML video seeks may not decode exact requested frames. Verify critical cuts manually.");
    expect(profile.warnings).toEqual(expect.arrayContaining([expect.stringContaining("gradual transition")]));
  });

  it("falls back to the first VERIFIED crossing with a lower-confidence warning on a malformed peak measurement", async () => {
    const profile = await extractFixture({ invalidAt: 4 });
    expect(intervals(profile)).toEqual([[0, 2], [2, 17], [17, 32]]);
    expect(profile.warnings).toEqual(expect.arrayContaining([expect.stringContaining("using first threshold crossing at frame 2 (lower-confidence)")]));
  });

  it("omits an unmeasurable cut instead of inventing a boundary when both strategies see invalid data", async () => {
    const profile = await extractFixture({ invalidAt: 1 });
    expect(intervals(profile)).toEqual([[0, 17], [17, 32]]);
    expect(profile.warnings).toEqual(expect.arrayContaining([expect.stringContaining("persistently invalid differences; no boundary inferred")]));
  });

  it("does not swallow a real decoder failure", async () => {
    await expect(extractFixture({ decoderFailsAt: 4 })).rejects.toThrow("Decoder failed");
  });

  it("reports monotonically increasing sample progress and finishes at the total", async () => {
    const progress: Array<[number, number]> = [];
    await extractFixture({}, { onProgress: (done, total) => progress.push([done, total]) });

    expect(progress.length).toBeGreaterThan(1);
    const firstTotal = progress[0]![1];
    expect(firstTotal).toBeGreaterThan(1);
    expect(progress[0]![0]).toBeGreaterThan(0);
    for (let i = 0; i < progress.length; i++) {
      const [done, total] = progress[i]!;
      expect(total).toBe(firstTotal);
      if (i > 0) expect(done).toBeGreaterThan(progress[i - 1]![0]);
    }
    expect(progress.at(-1)![0]).toBe(firstTotal);
  });

  it("coalesces progress notices instead of repainting once per decoded frame", async () => {
    const progress: number[] = [];
    // A 60s reference: 225 sampled positions, far more than a chat panel can
    // usefully repaint. The real clock is used on purpose: even when every
    // sample completes in the same quarter second, the notices must coalesce.
    await extractFixture({ durationFrames: 60 * 30 }, { onProgress: (done) => progress.push(done) });

    const total = progress.at(-1)!;
    expect(total).toBeGreaterThan(100);
    // Previously one notice per two samples (~112). Now: the start, a few
    // throttled updates and the total.
    expect(progress.length).toBeLessThanOrEqual(8);
    expect(progress.length).toBeGreaterThan(1);
  });

  it("yields to the macrotask queue while measuring instead of starving the tab", async () => {
    let queuedTaskRan = false;
    let extractionFinished = false;
    const queuedTask = new Promise<void>((resolve) => {
      setTimeout(() => { queuedTaskRan = true; resolve(); }, 0);
    });
    const extraction = extractFixture().then(() => { extractionFinished = true; });

    await queuedTask;
    expect(queuedTaskRan).toBe(true);
    // Without a yield the fixture resolves entirely on microtasks, so this
    // task only gets a turn after extraction has already finished.
    expect(extractionFinished).toBe(false);
    await extraction;
  });
});

describe("extractReference analysis budget", () => {
  it("analyses a 4K source at the bounded analysis size, never at native resolution", async () => {
    const record: FixtureRecord = { canvasSizes: [], getImageDataSizes: [] };
    await extractFixture({ sourceWidth: 3840, sourceHeight: 2160 }, {}, record);

    expect(record.canvasSizes).toEqual([{ width: REFERENCE_ANALYSIS_MAX_DIMENSION, height: 90 }]);
    // Every read stays on the bounded buffer: the analysis cost cannot grow
    // with the source resolution.
    for (const size of record.getImageDataSizes) {
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(REFERENCE_ANALYSIS_MAX_DIMENSION);
    }
  });

  it("asks the indexed decoder for the bounded analysis size", async () => {
    h.openIndexedVideoFrames.mockResolvedValue(null);
    await expect(extractFixture({ sourceWidth: 4096, sourceHeight: 2160 })).resolves.toBeDefined();
    expect(h.openIndexedVideoFrames).toHaveBeenCalledWith(expect.anything(), 160, 84);
  });

  it("keeps the documented slicing policy small enough to leave the tab responsive", () => {
    // Regression guard on the policy numbers themselves.
    expect(REFERENCE_FRAME_BUDGET_MS).toBeLessThanOrEqual(8);
    expect(REFERENCE_MAX_FRAMES_PER_SLICE).toBeLessThanOrEqual(8);
    expect(REFERENCE_ANALYSIS_MAX_DIMENSION).toBeLessThanOrEqual(192);
  });
});

describe("extractReference cancellation", () => {
  it("cancels between samples and releases the decoder without a zombie loop", async () => {
    const close = vi.fn();
    const controller = new AbortController();
    const indexedRead = vi.fn(async (frame: number) => {
      const data = new Uint8ClampedArray(160 * 160 * 4);
      data.fill(valueAt(frame));
      return { data } as ImageData;
    });
    h.openIndexedVideoFrames.mockResolvedValue({ read: indexedRead, close });

    const progress: number[] = [];
    const extraction = extractFixture(
      {},
      {
        now: steppingClock(300),
        signal: controller.signal,
        onProgress: (done) => {
          progress.push(done);
          if (done >= 3) controller.abort();
        },
      },
    );

    const error = await extraction.catch((reason: unknown) => reason);
    expect(isAbortError(error)).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    // The sampler stopped where it was cancelled: it never walked the file.
    expect(indexedRead.mock.calls.length).toBeLessThan(32);
    expect(progress.at(-1)).toBeLessThan(32);
  });

  it("rejects promptly when a decode never settles after the cancel", async () => {
    const close = vi.fn();
    h.openIndexedVideoFrames.mockResolvedValue({
      read: () => new Promise<ImageData>(() => {}),
      close,
    });
    const controller = new AbortController();
    const extraction = extractFixture({}, { signal: controller.signal });
    // Let the sampler reach its first (never-settling) decode, then cancel.
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    const error = await extraction.catch((reason: unknown) => reason);
    expect(isAbortError(error)).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await extractFixture({}, { signal: controller.signal }).catch((reason: unknown) => reason);
    expect(isAbortError(error)).toBe(true);
  });
});
