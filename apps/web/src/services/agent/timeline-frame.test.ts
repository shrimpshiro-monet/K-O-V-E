import { describe, expect, it, vi } from "vitest";
import type { RenderedFrame } from "@kove-advanced/core/video/types";
import {
  encodeRenderedFrame,
  fitFrameDimensions,
  type EncodeCanvas,
  type EncodeCanvasFactory,
} from "./timeline-frame";

function makeFrame(width: number, height: number): RenderedFrame {
  return {
    image: { close: vi.fn() } as unknown as ImageBitmap,
    timestamp: 1.5,
    width,
    height,
  };
}

function fakeCanvasFactory(): {
  factory: EncodeCanvasFactory;
  canvases: Array<{ width: number; height: number; drawCalls: unknown[][]; mimeTypes: string[] }>;
} {
  const canvases: Array<{
    width: number;
    height: number;
    drawCalls: unknown[][];
    mimeTypes: string[];
  }> = [];
  const factory: EncodeCanvasFactory = (width, height) => {
    const record = { width, height, drawCalls: [] as unknown[][], mimeTypes: [] as string[] };
    canvases.push(record);
    const canvas: EncodeCanvas = {
      width,
      height,
      getContext: (type) =>
        type === "2d"
          ? {
              drawImage: (...args: unknown[]) => {
                record.drawCalls.push(args);
              },
            }
          : null,
      toDataURL: (mimeType) => {
        record.mimeTypes.push(mimeType);
        return `data:${mimeType};base64,QUJD`;
      },
    };
    return canvas;
  };
  return { factory, canvases };
}

describe("fitFrameDimensions", () => {
  it("caps the longest edge at maxDimension and preserves aspect", () => {
    expect(fitFrameDimensions(1920, 1080, 768)).toEqual({ width: 768, height: 432 });
    expect(fitFrameDimensions(1080, 1920, 768)).toEqual({ width: 432, height: 768 });
  });

  it("never upscales small frames", () => {
    expect(fitFrameDimensions(320, 180, 768)).toEqual({ width: 320, height: 180 });
  });

  it("degrades to 1x1 on degenerate input instead of dividing by zero", () => {
    expect(fitFrameDimensions(0, 0, 768)).toEqual({ width: 1, height: 1 });
  });
});

describe("encodeRenderedFrame", () => {
  it("draws the scaled frame and emits a PNG data URL", () => {
    const { factory, canvases } = fakeCanvasFactory();
    const frame = encodeRenderedFrame(
      makeFrame(1920, 1080),
      { time: 1.5, maxDimension: 768, format: "png" },
      "web/canvas2d",
      factory,
    );

    expect(frame).toEqual({
      dataUrl: "data:image/png;base64,QUJD",
      mimeType: "image/png",
      width: 768,
      height: 432,
      renderer: "web/canvas2d",
    });
    expect(canvases).toHaveLength(1);
    expect(canvases[0].width).toBe(768);
    expect(canvases[0].drawCalls).toEqual([[expect.anything(), 0, 0, 768, 432]]);
    expect(canvases[0].mimeTypes).toEqual(["image/png"]);
  });

  it("honors the jpeg format", () => {
    const { factory } = fakeCanvasFactory();
    const frame = encodeRenderedFrame(
      makeFrame(640, 360),
      { time: 0, maxDimension: 768, format: "jpeg" },
      "web/canvas2d",
      factory,
    );
    expect(frame.mimeType).toBe("image/jpeg");
    expect(frame.dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("rejects a canvas that produces no data URL (no silent placeholders)", () => {
    const factory: EncodeCanvasFactory = (width, height) => ({
      width,
      height,
      getContext: () => ({ drawImage: () => {} }),
      toDataURL: () => "about:blank",
    });
    expect(() =>
      encodeRenderedFrame(
        makeFrame(100, 100),
        { time: 0, maxDimension: 768, format: "png" },
        "web/canvas2d",
        factory,
      ),
    ).toThrow(/no data URL/);
  });

  it("throws when no 2D context is available", () => {
    const factory: EncodeCanvasFactory = (width, height) => ({
      width,
      height,
      getContext: () => null,
      toDataURL: () => "data:image/png;base64,QUJD",
    });
    expect(() =>
      encodeRenderedFrame(
        makeFrame(100, 100),
        { time: 0, maxDimension: 768, format: "png" },
        "web/canvas2d",
        factory,
      ),
    ).toThrow(/no 2D canvas context/);
  });
});
