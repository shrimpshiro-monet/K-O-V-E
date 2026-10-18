import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@kove-advanced/core/mirror/decoded-frames", () => ({ openIndexedVideoFrames: async () => null }));
vi.mock("@kove-advanced/core/vision/opencv-camera-motion", () => ({
  loadOpenCv: async () => { throw new Error("Optional OpenCV unavailable"); },
  extractFrameMotion: vi.fn(),
}));

import { extractReference, type ExtractReferenceOptions } from "./extract-reference";

const originals = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
afterEach(() => {
  vi.restoreAllMocks();
  if (originals.createObjectURL) URL.createObjectURL = originals.createObjectURL;
  else delete (URL as { createObjectURL?: typeof URL.createObjectURL }).createObjectURL;
  if (originals.revokeObjectURL) URL.revokeObjectURL = originals.revokeObjectURL;
  else delete (URL as { revokeObjectURL?: typeof URL.revokeObjectURL }).revokeObjectURL;
});

function valueAt(frame: number): number {
  if (frame < 2) return 0;
  if (frame < 4) return 71; // earlier crossing: 71/255 > 0.23
  if (frame <= 16) return 224; // stronger jump at frame 4
  return Math.round(224 - (frame - 16) * 18); // gradual fade from frames 17..24
}

/** An HTML-video fallback fixture; do not mistake these mocked pixels for
 * proof of accurate browser seeking on real footage. */
async function extractFixture(
  fixture: { invalidAt?: number; decoderFailsAt?: number } = {},
  extractOptions: ExtractReferenceOptions = {},
) {
  URL.createObjectURL = vi.fn(() => "blob:synthetic");
  URL.revokeObjectURL = vi.fn();
  let currentTime = 0;
  const video = {
    duration: 32 / 30, videoWidth: 160, videoHeight: 160, readyState: 2,
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
  const canvas = { width: 0, height: 0, getContext: () => context };
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) =>
    tag === "video" ? video : tag === "canvas" ? canvas : createElement(tag)) as typeof document.createElement);
  return extractReference(new Blob(["synthetic"]), { fps: { num: 30, den: 1 }, fpsSource: "user" }, extractOptions);
}

const intervals = (profile: Awaited<ReturnType<typeof extractReference>>) =>
  profile.shots.map(({ startFrame, endFrame }) => [startFrame, endFrame]);

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
