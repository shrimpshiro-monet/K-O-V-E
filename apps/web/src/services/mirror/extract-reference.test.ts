import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@kove-advanced/core/mirror/decoded-frames", () => ({ openIndexedVideoFrames: async () => null }));
vi.mock("@kove-advanced/core/vision/opencv-camera-motion", () => ({
  loadOpenCv: async () => { throw new Error("Optional OpenCV unavailable"); },
  extractFrameMotion: vi.fn(),
}));

import { extractReference } from "./extract-reference";

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

describe("extractReference peak boundary wiring", () => {
  it("selects the stronger cut, tiles half-open shots, and warns about a gradual transition", async () => {
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
        const intensity = valueAt(Math.floor(currentTime * 30));
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

    const profile = await extractReference(new Blob(["synthetic"]), { fps: { num: 30, den: 1 }, fpsSource: "user" });
    expect(profile.shots.map(({ startFrame, endFrame }) => [startFrame, endFrame])).toEqual([
      [0, 4], [4, expect.any(Number)], [expect.any(Number), 32],
    ]);
    const fadeFrame = profile.shots[1]!.endFrame;
    expect(fadeFrame).toBeGreaterThanOrEqual(17);
    expect(fadeFrame).toBeLessThanOrEqual(24);
    expect(profile.shots[2]!.startFrame).toBe(fadeFrame);
    expect(profile.warnings).toContain("Indexed WebCodecs decoder unavailable: HTML video seeks may not decode exact requested frames. Verify critical cuts manually.");
    expect(profile.warnings).toEqual(expect.arrayContaining([expect.stringContaining("gradual transition")]));
  });
});
