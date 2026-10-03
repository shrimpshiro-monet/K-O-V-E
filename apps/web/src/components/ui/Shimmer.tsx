import React from "react";

interface ShimmerProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Corner radius token (defaults to the card radius). */
  radius?: "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "full";
  /** Explicit height; prefer parent-driven sizing otherwise. */
  height?: number | string;
  /** Accessible description of what is loading. */
  label?: string;
}

const RADIUS_CLASS: Record<NonNullable<ShimmerProps["radius"]>, string> = {
  xs: "rounded-xs",
  sm: "rounded-sm",
  md: "rounded-md",
  lg: "rounded-lg",
  xl: "rounded-xl",
  "2xl": "rounded-2xl",
  full: "rounded-full",
};

/**
 * Skeleton block with the sanctioned slow diagonal highlight sweep
 * (see .monet-shimmer in styles/glass.css — 1.4s loop, disabled under
 * prefers-reduced-motion). Use for asset cards, thumbnails, and waveforms
 * while async content loads. Never shifts layout: pass the real box size.
 */
export const Shimmer: React.FC<ShimmerProps> = ({
  radius = "lg",
  height,
  label = "Loading",
  className = "",
  style,
  ...rest
}) => (
  <div
    role="status"
    aria-live="polite"
    aria-label={label}
    className={`monet-shimmer ${RADIUS_CLASS[radius]} ${className}`}
    style={{ height, ...style }}
    {...rest}
  >
    <span className="sr-only">{label}</span>
  </div>
);

export default Shimmer;
