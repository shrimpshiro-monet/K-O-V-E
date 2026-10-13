/**
 * Legibility minima for text that ends up over footage.
 *
 * Edit v1 shipped white captions with no stroke and no shadow over bright
 * footage and they were unreadable. The constants existed (DEFAULT_TEXT_STYLE
 * carries a 2 px #111827 stroke) but plan-derived text never went through a
 * place that filled them, and a fixed 2 px stroke is invisible under a 100 px
 * title anyway.
 *
 * Contract (standing rule 8): fill ONLY undefined fields — an explicit choice
 * in the plan or caption template is never overridden. ONE documented
 * exception: the minimum font size is a hard floor, not a default. An
 * explicit 12 px caption on 1080p IS the Edit v1 failure, so explicit sizes
 * below the role floor are lifted to it. Everything else (stroke, shadow,
 * colors) passes explicit values through untouched. Sizes are computed
 * relative to the frame so 1080p and 4K exports get the same readable
 * result. Positions are clamped into a safe-area inset; captions keep extra
 * bottom clearance because vertical platform UI eats the bottom of the frame.
 */

import { DEFAULT_TEXT_STYLE, type TextStyle } from "./types";

/** Text roles a director plan can request. */
export type TextRole = "title" | "subtitle" | "lower-third" | "caption" | "callout";

/** Minimum font size as a fraction of frame height, by role. */
const MIN_FONT_SIZE_RATIO: Readonly<Record<TextRole, number>> = {
  title: 0.06,
  subtitle: 0.05,
  "lower-third": 0.05,
  caption: 0.045,
  callout: 0.05,
};

/** Safe-area insets in normalized 0–1 coordinates. */
const SAFE_AREA_INSET = 0.05;
/** Vertical platforms render UI (buttons, usernames) over the bottom ~15%. */
const CAPTION_BOTTOM_INSET = 0.15;

const DEFAULT_SHADOW_COLOR = "rgba(0, 0, 0, 0.6)";

/** Style fields the legibility pass may fill. Mirrors the overlay style bag. */
export interface LegibilityStyle {
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly fontWeight?: number | string;
  readonly color?: string;
  readonly backgroundColor?: string;
  readonly backgroundPadding?: number;
  readonly backgroundRadius?: number;
  readonly strokeColor?: string;
  readonly strokeWidth?: number;
  readonly shadowColor?: string;
  readonly shadowBlur?: number;
  readonly shadowOffsetX?: number;
  readonly shadowOffsetY?: number;
  readonly align?: string;
}

export interface LegibilityFrame {
  readonly width: number;
  readonly height: number;
}

export interface LegibilityPosition {
  readonly x: number;
  readonly y: number;
}

export interface LegibilityResult {
  readonly style: LegibilityStyle;
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Fill legibility minima into a partially-specified text style. Never
 * overrides an explicitly set field; returns the same strings/numbers it was
 * given for anything defined.
 */
export function applyLegibilityDefaults(
  style: LegibilityStyle,
  frame: LegibilityFrame,
  role: TextRole = "caption",
): LegibilityResult {
  const frameHeight = isFinitePositive(frame.height) ? frame.height : 1080;

  const fontSize = (() => {
    const floor = Math.max(1, Math.round(frameHeight * MIN_FONT_SIZE_RATIO[role]));
    return isFinitePositive(style.fontSize) ? Math.max(style.fontSize, floor) : floor;
  })();

  // Stroke scales with type size: DEFAULT_TEXT_STYLE's 2 px is a floor, not
  // a constant — a 100 px title needs ~5-6 px to read over moving footage.
  const strokeWidthFloor = Math.max(DEFAULT_TEXT_STYLE.strokeWidth ?? 2, fontSize * 0.055);
  const strokeWidth = isFinitePositive(style.strokeWidth)
    ? Math.max(style.strokeWidth, 1) // explicit stroke widths pass through
    : Math.round(strokeWidthFloor * 10) / 10;
  const strokeColor = style.strokeColor ?? DEFAULT_TEXT_STYLE.strokeColor;

  // Soft dark shadow under everything: it is the part of the pairing that
  // survives bright, busy footage, and it costs nothing when unneeded.
  const shadowColor = style.shadowColor ?? DEFAULT_SHADOW_COLOR;
  const shadowBlur = isFinitePositive(style.shadowBlur)
    ? style.shadowBlur
    : Math.max(8, Math.round(fontSize * 0.12));
  const shadowOffsetY = isFinitePositive(style.shadowOffsetY)
    ? style.shadowOffsetY
    : Math.max(2, Math.round(fontSize * 0.05));

  const next: LegibilityStyle = {
    ...style,
    fontSize,
    strokeWidth,
    strokeColor,
    shadowColor,
    shadowBlur,
    shadowOffsetY,
  };

  // Position (when provided) is clamped by the caller via clampToSafeArea —
  // unset positions inherit the caption template / renderer default (centre).
  return { style: next };
}

/** Clamp a normalized position into the safe area for a role. */
export function clampToSafeArea(
  position: LegibilityPosition,
  role: TextRole = "caption",
): LegibilityPosition {
  const bottomInset = role === "caption" ? CAPTION_BOTTOM_INSET : SAFE_AREA_INSET;
  const x = Math.min(1 - SAFE_AREA_INSET, Math.max(SAFE_AREA_INSET, position.x));
  const y = Math.min(1 - bottomInset, Math.max(SAFE_AREA_INSET, position.y));
  return {
    x: Number.isFinite(x) ? x : 0.5,
    y: Number.isFinite(y) ? y : 0.5,
  };
}

/** TextStyle-shaped convenience wrapper for code that already has full styles. */
export function withLegibilityDefaults(
  style: Partial<TextStyle>,
  frame: LegibilityFrame,
  role: TextRole = "caption",
): Partial<TextStyle> {
  return applyLegibilityDefaults(style, frame, role).style as Partial<TextStyle>;
}
