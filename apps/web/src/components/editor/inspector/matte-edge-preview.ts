/**
 * Matte edge preview drawing.
 *
 * The renderer (MaskEngine) turns a matte into pixels by filling the path,
 * blurring it (`feathering`) and then dilating/eroding it (`expansion`). This
 * draws the same three steps into any 2D context so the inspector can show the
 * edge *before* it is committed — and so tests can assert on the drawing
 * without a browser canvas.
 *
 * Kept separate from the React component so the geometry is unit-testable.
 */

import type { BezierPath } from "@kove-advanced/core";

export interface MatteEdgePreviewOptions {
  /** Normalized (0..1) closed path, the same space MaskEngine consumes. */
  path: BezierPath;
  /** Blur radius in preview pixels. */
  featherPx: number;
  /** Grow (+) or shrink (−) the silhouette, in preview pixels. */
  expansionPx: number;
  /** Knock the subject out instead of keeping it. */
  inverted?: boolean;
  /** Matte opacity, 0..1. */
  opacity?: number;
  /** Canvas backing size in pixels. */
  width: number;
  height: number;
}

/** Records what the preview drew, for assertions without a real canvas. */
export interface MatteEdgePreviewDrawCall {
  filter: string;
  strokeWidth: number;
  compositeOperation: string;
  fillAlpha: number;
}

type PreviewContext = {
  filter: string;
  lineWidth: number;
  globalAlpha: number;
  globalCompositeOperation: string;
  fillStyle: unknown;
  strokeStyle: unknown;
  clearRect: (x: number, y: number, w: number, h: number) => void;
  beginPath: () => void;
  moveTo: (x: number, y: number) => void;
  lineTo: (x: number, y: number) => void;
  closePath: () => void;
  fill: () => void;
  stroke: () => void;
  fillRect: (x: number, y: number, w: number, h: number) => void;
};

function tracePath(ctx: PreviewContext, path: BezierPath, width: number, height: number): void {
  ctx.beginPath();
  path.points.forEach((point, index) => {
    const x = point.x * width;
    const y = point.y * height;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  if (path.closed) ctx.closePath();
}

/**
 * Draw one matte edge into `ctx`.
 *
 * Expansion is approximated with a stroke — dilate draws with `source-over`,
 * erode with `destination-out` — which is the standard canvas equivalent of the
 * renderer's morphological pass and, like it, is expressed in pixels.
 */
export function drawMatteEdgePreview(
  ctx: PreviewContext,
  options: MatteEdgePreviewOptions,
): MatteEdgePreviewDrawCall {
  const { width, height } = options;
  const feather = Math.max(0, options.featherPx);
  const opacity = Math.max(0, Math.min(1, options.opacity ?? 1));

  ctx.clearRect(0, 0, width, height);
  ctx.filter = "none";
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";

  tracePath(ctx, options.path, width, height);

  if (options.inverted) {
    // Inverted mattes keep the background: fill the frame, then punch the
    // subject out of it.
    ctx.fillStyle = "#ffffff";
    ctx.globalAlpha = opacity;
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = 1;
    ctx.filter = feather > 0 ? `blur(${feather}px)` : "none";
    ctx.fill();
    ctx.filter = "none";
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    return {
      filter: feather > 0 ? `blur(${feather}px)` : "none",
      strokeWidth: 0,
      compositeOperation: "destination-out",
      fillAlpha: opacity,
    };
  }

  ctx.fillStyle = "#ffffff";
  ctx.filter = feather > 0 ? `blur(${feather}px)` : "none";
  ctx.globalAlpha = opacity;
  ctx.fill();

  // Expansion: stroke outward to grow, or erase inward to shrink. The stroke
  // straddles the outline, so twice the requested radius covers it.
  let strokeWidth = 0;
  let compositeOperation = "source-over";
  if (options.expansionPx !== 0) {
    ctx.filter = "none";
    strokeWidth = Math.abs(options.expansionPx) * 2;
    ctx.lineWidth = strokeWidth;
    ctx.strokeStyle = "#ffffff";
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = options.expansionPx > 0 ? "source-over" : "destination-out";
    tracePath(ctx, options.path, width, height);
    ctx.stroke();
    compositeOperation = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = "source-over";
  }

  ctx.filter = "none";
  ctx.globalAlpha = 1;
  return {
    filter: feather > 0 ? `blur(${feather}px)` : "none",
    strokeWidth,
    compositeOperation,
    fillAlpha: opacity,
  };
}

/** Blur radius (px) for the matte at a given motion score — preview helper. */
export function previewFeatherAt(
  baseFeatherPx: number,
  maxFeatherPx: number,
  motion: number,
  sensitivity: number,
): number {
  const clamped = Math.max(0, Math.min(1, motion * sensitivity));
  return baseFeatherPx + (Math.max(baseFeatherPx, maxFeatherPx) - baseFeatherPx) * clamped;
}
