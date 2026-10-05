import type { TimelineFrame, TimelineFrameRequest } from "@kove-advanced/agent";
import type { RenderedFrame } from "@kove-advanced/core/video/types";

/**
 * Encodes a VideoEngine-rendered timeline frame into the agent's
 * TimelineFrame shape: downscaled to maxDimension (aspect preserved),
 * exported as a PNG/JPEG data URL.
 *
 * The canvas factory is injectable so the math and contract are testable in
 * jsdom, where HTMLCanvasElement.toDataURL is not implemented.
 */
export interface EncodeCanvas {
  width: number;
  height: number;
  getContext(type: "2d"): {
    drawImage(
      image: CanvasImageSource,
      dx: number,
      dy: number,
      dWidth: number,
      dHeight: number,
    ): void;
  } | null;
  toDataURL(mimeType: string): string;
}

export type EncodeCanvasFactory = (width: number, height: number) => EncodeCanvas;

const defaultCanvasFactory: EncodeCanvasFactory = (width, height) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas as unknown as EncodeCanvas;
};

/** Target size for a frame: longest edge capped at maxDimension, never upscaled. */
export function fitFrameDimensions(
  sourceWidth: number,
  sourceHeight: number,
  maxDimension: number,
): { width: number; height: number } {
  const longest = Math.max(sourceWidth, sourceHeight);
  if (longest <= 0) return { width: 1, height: 1 };
  const scale = Math.min(1, maxDimension / longest);
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

export function encodeRenderedFrame(
  frame: RenderedFrame,
  request: TimelineFrameRequest,
  rendererName: string,
  canvasFactory: EncodeCanvasFactory = defaultCanvasFactory,
): TimelineFrame {
  const mimeType = request.format === "jpeg" ? "image/jpeg" : "image/png";
  const { width, height } = fitFrameDimensions(
    frame.width,
    frame.height,
    request.maxDimension,
  );
  const canvas = canvasFactory(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Timeline frame encode failed: no 2D canvas context.");
  }
  ctx.drawImage(frame.image, 0, 0, width, height);
  const dataUrl = canvas.toDataURL(mimeType);
  if (!dataUrl.startsWith(`data:${mimeType};base64,`)) {
    throw new Error("Timeline frame encode failed: canvas produced no data URL.");
  }
  return { dataUrl, mimeType, width, height, renderer: rendererName };
}
