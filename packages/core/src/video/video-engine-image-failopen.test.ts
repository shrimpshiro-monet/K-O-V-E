import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../types/project";
import type { VideoEngine as VideoEngineType } from "./video-engine";

function projectWithImageClip(): Project {
  return {
    settings: { width: 64, height: 64, frameRate: 30 },
    mediaLibrary: {
      items: [
        {
          id: "image",
          name: "undecodable",
          type: "image",
          blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }),
          metadata: { width: 64, height: 64 },
        },
      ],
    },
    timeline: {
      duration: 1,
      tracks: [
        {
          id: "track",
          name: "V1",
          type: "video",
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
          transitions: [],
          clips: [
            {
              id: "clip",
              mediaId: "image",
              trackId: "track",
              startTime: 0,
              duration: 1,
              inPoint: 0,
              outPoint: 1,
              effects: [],
              audioEffects: [],
              transform: {
                position: { x: 0, y: 0 },
                scale: { x: 1, y: 1 },
                rotation: 0,
                opacity: 1,
                anchor: { x: 0.5, y: 0.5 },
              },
              volume: 1,
              keyframes: [],
            },
          ],
        },
      ],
    },
  } as unknown as Project;
}

function stubCanvasEnvironment(): void {
  const ctx = {
    fillStyle: "",
    filter: "",
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4) })),
    putImageData: vi.fn(),
    measureText: vi.fn(() => ({ width: 0 })),
    fillText: vi.fn(),
  };
  class FakeCanvas {
    width = 0;
    height = 0;
    getContext() {
      return ctx;
    }
    close() {}
  }
  vi.stubGlobal("OffscreenCanvas", FakeCanvas);
  vi.stubGlobal("ImageBitmap", class ImageBitmapStub {
    close() {}
  });
  vi.stubGlobal("self", {
    onmessage: null,
    postMessage: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("Worker", class WorkerStub {
    onmessage = null;
    postMessage() {}
    addEventListener() {}
    removeEventListener() {}
    terminate() {}
  });
}

describe("VideoEngine.renderFrame undecodable-image contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function renderWith(exportMode: boolean) {
    stubCanvasEnvironment();
    vi.stubGlobal("createImageBitmap", vi.fn().mockImplementation(async (arg: unknown) => {
      // Only the undecodable image Blob fails. Canvas/other args (the final
      // composite) must succeed, else we test our mock, not the product.
      if (arg instanceof Blob) {
        throw new Error("decode failed");
      }
      return { width: 64, height: 64, close() {} };
    }));
    const { VideoEngine } = await import("./video-engine");
    const engine = new VideoEngine() as VideoEngineType;
    engine.exportMode = exportMode;
    await engine.initialize();
    return engine.renderFrame(projectWithImageClip(), 0, 64, 64);
  }

  it("rejects in export mode instead of returning the black background", async () => {
    await expect(renderWith(true)).rejects.toThrow(/ImageBitmap for image image during export/);
  }, 20000);

  it("keeps the best-effort black fallback in preview mode", async () => {
    await expect(renderWith(false)).resolves.toBeTruthy();
  }, 20000);
});
