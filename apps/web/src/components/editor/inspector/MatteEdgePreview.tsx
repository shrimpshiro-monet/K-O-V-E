import React, { useEffect, useRef } from "react";
import type { BezierPath } from "@kove-advanced/core";
import { ToolcraftText as Text } from "@kove-advanced/ui";
import { drawMatteEdgePreview } from "./matte-edge-preview";

export interface MatteEdgePreviewProps {
  /** Path at the keyframe being previewed (normalized 0..1). */
  path: BezierPath;
  featherPx: number;
  expansionPx: number;
  inverted?: boolean;
  opacity?: number;
  /** Edge the matte had *before* refinement, for the side-by-side comparison. */
  baselineFeatherPx: number;
  baselineExpansionPx?: number;
  /** Label for the keyframe being shown, e.g. "keyframe 3 · 1.4s". */
  caption?: string;
  width?: number;
  height?: number;
}

interface SwatchProps {
  title: string;
  testId: string;
  width: number;
  height: number;
  draw: (canvas: HTMLCanvasElement) => void;
}

const Swatch: React.FC<SwatchProps> = ({ title, testId, width, height, draw }) => {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    draw(canvas);
  });

  return (
    <div className="flex-1 space-y-1">
      <Text type="supporting" color="secondary" className="text-fg-2">
        {title}
      </Text>
      <canvas
        ref={ref}
        data-testid={testId}
        width={width}
        height={height}
        className="block w-full rounded-md border border-border-subtle bg-bg-2"
        style={{ aspectRatio: `${width} / ${height}` }}
      />
    </div>
  );
};

/**
 * Side-by-side before/after of a matte edge.
 *
 * Both canvases draw the same silhouette through the same steps the renderer
 * uses (fill → blur → expand), so what you see is what `mask/setAll` will
 * commit. The checkerboard makes the feather band legible, since that band is
 * exactly the part refinement changes.
 */
export const MatteEdgePreview: React.FC<MatteEdgePreviewProps> = ({
  path,
  featherPx,
  expansionPx,
  inverted,
  opacity,
  baselineFeatherPx,
  baselineExpansionPx = 0,
  caption,
  width = 220,
  height = 132,
}) => {
  const paint =
    (feather: number, expansion: number) =>
    (canvas: HTMLCanvasElement): void => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      drawMatteEdgePreview(ctx, {
        path,
        featherPx: feather,
        expansionPx: expansion,
        ...(inverted !== undefined ? { inverted } : {}),
        ...(opacity !== undefined ? { opacity } : {}),
        width: canvas.width,
        height: canvas.height,
      });
    };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Text type="supporting" color="secondary" className="text-fg-2">
          Edge preview
        </Text>
        {caption ? (
          <Text type="supporting" color="secondary" className="tabular-nums text-fg-2">
            {caption}
          </Text>
        ) : null}
      </div>
      <div className="flex gap-2">
        <Swatch
          title={`Before · ${baselineFeatherPx.toFixed(1)}px`}
          testId="matte-edge-preview-before"
          width={width}
          height={height}
          draw={paint(baselineFeatherPx, baselineExpansionPx)}
        />
        <Swatch
          title={`After · ${featherPx.toFixed(1)}px`}
          testId="matte-edge-preview-after"
          width={width}
          height={height}
          draw={paint(featherPx, expansionPx)}
        />
      </div>
    </div>
  );
};
