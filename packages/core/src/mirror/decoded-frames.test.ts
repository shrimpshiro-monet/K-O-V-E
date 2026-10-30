import { afterEach, describe, expect, it, vi } from "vitest";
import { openIndexedVideoFrames } from "./decoded-frames";

vi.mock("mediabunny", () => ({
  ALL_FORMATS: [], BlobSource: class { constructor(_file: Blob) {} },
  Input: class {
    async getPrimaryVideoTrack() { return { canDecode: async () => true }; }
    dispose() {}
  },
  CanvasSink: class {
    async getCanvas(timestamp: number) {
      const frame = Math.floor(timestamp * 30 + 1e-8);
      return { timestamp: frame / 30, duration: 1 / 30, canvas: { frame } };
    }
    canvases(startTimestamp = 0) {
      return (async function* () {
        for (let frame = Math.max(0, Math.ceil(startTimestamp * 30 - 1e-9)); ; frame++) {
          yield { timestamp: frame / 30, duration: 1 / 30, canvas: { frame } };
        }
      })();
    }
  },
}));

afterEach(() => { vi.unstubAllGlobals(); });

describe("timestamp-checked indexed source decoder", () => {
  it("returns the exact same pixels at repeated rational frame indices and rejects a mismatched clock", async () => {
    vi.stubGlobal("document", { createElement: () => {
      let frame = 0;
      return { width: 0, height: 0, getContext: () => ({
        drawImage: (canvas: { frame: number }) => { frame = canvas.frame; },
        getImageData: () => ({ data: new Uint8ClampedArray([frame, 0, 0, 255]) }),
      }) };
    } });
    const source = await openIndexedVideoFrames(new Blob(["reference"]), 1, 1);
    try {
      expect((await source.read(15, { num: 30, den: 1 })).data[0]).toBe(15);
      expect((await source.read(15, { num: 30, den: 1 })).data[0]).toBe(15);
      expect((await source.read(16, { num: 30, den: 1 })).data[0]).toBe(16);
      await expect(source.read(15, { num: 24, den: 1 })).rejects.toThrow(/does not match selected CFR clock/);
    } finally { source.close(); }
  });
});
