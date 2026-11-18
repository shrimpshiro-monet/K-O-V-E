/**
 * General magazine-spread layout (style pack "editorial spread").
 *
 * This is the *design function*, not a serialised frame: callers pass content
 * (headline, body copy, photos), a palette and a grid. Every position/size is
 * derived from those parameters on a shared column grid. There are no
 * per-element coordinates and no branches on card count, headline length or
 * variant identity.
 *
 * Preconditions on media (content prep, not layout):
 * - page/column textures match the canvas/column pixel size
 * - cards are pre-cropped to `grid.cardAspect`
 * - accent is pre-cropped to the column photo aspect (3:4)
 * - avatar is pre-masked square
 *
 * Stage 1's exact-frame reproduction keeps its own fitted function; this one is
 * the generalisation tested by stage 1.5.
 */
import type { TextClip, TextStyle } from "@kove-advanced/core/text/types";
import type { Clip, Keyframe, Track } from "@kove-advanced/core/types/timeline";

/** title-engine anchors text at the line MIDDLE (textBaseline = "middle"). */
const COURIER_MIDDLE_TO_TOP = 0.474;
const ANTON_MIDDLE_TO_CAP = 0.58;
/** Anton advance width in em, measured from the reference headline. */
const ANTON_ADVANCE = 0.47;
const ANTON_SPACE = 0.25;
/**
 * Measured from a 200px "H" rendered through this engine (no stroke):
 * cap = 0.86em, ink top sits 0.58em above the line anchor. A stroke of width w
 * adds w/2 to each side, so cap = (0.86 + weight) * size * stretchY and the
 * ink-top offset is (0.58 + weight/2) * size * stretchY. Antons cap/width
 * ratio is taller than the reference face, so Y is squeezed to hit the cap
 * without narrowing the measured letter gaps. Stage 1's old 0.791 constant hid
 * this because its letters were clipped at the frame bottom.
 */
const ANTON_CAP = 0.86;
/** Weight stroke as a fraction of font size (same-colour stroke). */
const ANTON_WEIGHT = 0.062;
/** Vertical squeeze used to hit the reference cap from Anton's tall cap. */
const ANTON_STRETCH_Y = 0.895;
const COURIER_ADVANCE = 0.6;

export interface SpreadAsset {
  readonly mediaId: string;
  readonly width: number;
  readonly height: number;
}

export interface SpreadMedia {
  readonly page: SpreadAsset;
  readonly column: SpreadAsset;
  /** Full-bleed photo at the top of the accent column. */
  readonly accent: SpreadAsset;
  readonly avatar: SpreadAsset;
  readonly cards: readonly SpreadAsset[];
}

export interface SpreadPalette {
  readonly ink: string;
  readonly letter: string;
}

export interface SpreadContent {
  readonly headline: string;
  readonly body: string;
}

/**
 * All spatial values are fractions of the canvas dimension they act on, so the
 * same parameter set works at any output size.
 */
export interface SpreadGrid {
  readonly marginX: number;
  readonly marginTop: number;
  readonly marginBottom: number;
  /** Width of the full-bleed accent column. */
  readonly accentFraction: number;
  /** Page gap between content area and accent column. */
  readonly accentGap: number;
  readonly gutter: number;
  readonly avatarFraction: number;
  /** Avatar-to-body gap, in gutters. */
  readonly avatarGap: number;
  /** Body measure as a fraction of the content width. */
  readonly bodyWidthFactor: number;
  readonly bodySizeFactor: number;
  readonly bodyLeading: number;
  readonly cardAspect: number;
  /** Body-to-card gap in leadings. */
  readonly cardGapLeadings: number;
  /** Left inset of the giant type inside the column. */
  readonly headlineInset: number;
  /** Allowed horizontal bleed past the frame edge before type is scaled down. */
  readonly headlineBleed: number;
  /** How much of the band height the cap height fills (0..1). */
  readonly headlineBandFill: number;
  /** Maximum wrapped body lines before the layout refuses the copy. */
  readonly maxBodyLines: number;
}

export const DEFAULT_SPREAD_GRID: SpreadGrid = {
  marginX: 0.066,
  marginTop: 0.09,
  marginBottom: 0.058,
  accentFraction: 0.286,
  accentGap: 0.029,
  gutter: 0.0215,
  avatarFraction: 0.14,
  avatarGap: 1.6,
  bodyWidthFactor: 0.55,
  bodySizeFactor: 0.0238,
  bodyLeading: 1.3139,
  cardAspect: 0.75,
  cardGapLeadings: 5,
  headlineInset: 0.008,
  headlineBleed: 1.15,
  headlineBandFill: 0.95,
  maxBodyLines: 14,
};

export interface SpreadMotion {
  readonly duration: number;
  /** Per-card start delay. */
  readonly cardStagger: number;
  /** Vertical travel in px. */
  readonly cardRise: number;
  readonly cardFadeSeconds: number;
  readonly bodyDelay: number;
  readonly headlineDelay: number;
  readonly textRise: number;
  readonly drift: number;
}

export interface SpreadParams {
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  readonly palette: SpreadPalette;
  readonly fonts: { readonly display: string; readonly body: string };
  readonly grid?: Partial<SpreadGrid>;
  readonly content: SpreadContent;
  readonly media: SpreadMedia;
  readonly motion?: SpreadMotion;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface SpreadCardRect extends Rect {
  readonly mediaId: string;
}

export interface SpreadLayout {
  readonly page: Rect;
  readonly column: Rect;
  readonly accentPhoto: Rect;
  readonly avatar: Rect;
  readonly body: Rect;
  readonly cards: readonly SpreadCardRect[];
  readonly headline: {
    readonly text: string;
    readonly size: number;
    readonly strokeWidth: number;
    readonly letterSpacing: number;
    readonly capHeight: number;
    readonly rect: Rect;
  };
  readonly bodyLines: readonly string[];
  readonly bodySize: number;
  readonly bodyLeadingPx: number;
}

export interface SpreadLayers {
  readonly clips: readonly Clip[];
  readonly textClips: readonly TextClip[];
  readonly layout: SpreadLayout;
  readonly mediaIds: readonly string[];
}

export const SPREAD_TRACKS = {
  type: "spread-type",
  avatar: "spread-avatar",
  cards: "spread-cards",
  accent: "spread-accent",
  column: "spread-column",
  page: "spread-page",
} as const;

export function spreadTrackList(): Track[] {
  return [
    track(SPREAD_TRACKS.type, "text", "Type"),
    track(SPREAD_TRACKS.avatar, "video", "Avatar"),
    track(SPREAD_TRACKS.cards, "video", "Cards"),
    track(SPREAD_TRACKS.accent, "video", "Accent"),
    track(SPREAD_TRACKS.column, "video", "Column"),
    track(SPREAD_TRACKS.page, "video", "Page"),
  ];
}

function track(id: string, type: Track["type"], name: string): Track {
  return { id, type, name, clips: [], transitions: [], locked: false, hidden: false, muted: false, solo: false };
}

/** Wrap monospace copy: Courier advance is exactly 0.6em, so this is exact. */
export function wrapBody(text: string, maxChars: number): string[] {
  const limit = Math.max(8, Math.floor(maxChars));
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      if (word.length > limit) {
        if (line) {
          out.push(line);
          line = "";
        }
        for (let i = 0; i < word.length; i += limit) out.push(word.slice(i, i + limit));
        continue;
      }
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length <= limit) line = candidate;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

function headlineEm(text: string): number {
  let em = 0;
  for (const ch of text) em += ch === " " ? ANTON_SPACE : ANTON_ADVANCE;
  return em;
}

export function spreadLayout(params: SpreadParams): SpreadLayers {
  const { width: W, height: H, duration, media, content, fonts } = params;
  const g: SpreadGrid = { ...DEFAULT_SPREAD_GRID, ...params.grid };

  const marginX = g.marginX * W;
  const marginTop = g.marginTop * H;
  const marginBottom = g.marginBottom * H;
  const accentW = Math.round(g.accentFraction * W);
  const accentX = W - accentW;
  const contentW = accentX - g.accentGap * W - marginX;
  const gutter = g.gutter * W;

  const avatarSize = g.avatarFraction * W;
  const bodySize = g.bodySizeFactor * H;
  const leading = bodySize * g.bodyLeading;

  const bodyX = marginX + avatarSize + gutter * g.avatarGap;
  const bodyW = contentW * g.bodyWidthFactor;
  const maxChars = bodyW / (bodySize * COURIER_ADVANCE);
  const bodyLines = content.body.trim() ? wrapBody(content.body, maxChars) : [];
  if (bodyLines.length > g.maxBodyLines) {
    throw new Error(`spread: body wraps to ${bodyLines.length} lines (max ${g.maxBodyLines})`);
  }
  const bodyH = bodyLines.length * leading;

  const cardBottom = H - marginBottom;
  const cardTopMin = marginTop + bodyH + g.cardGapLeadings * leading;
  const areaH = Math.max(0, cardBottom - cardTopMin);

  const n = media.cards.length;
  const widthFit = n > 0 ? (contentW - Math.max(0, n - 1) * gutter) / n : 0;
  const cards: SpreadCardRect[] = [];
  if (n > 0) {
    // Height-constrained when few cards: never exceed the available band.
    // Every card keeps `cardAspect` and the row shares one baseline. The row
    // is centred in the band left by the copy rather than pinned to the page
    // edge: with four or more cards the row cannot fill the band, and a
    // bottom-pinned strip reads as an orphan with a hole above it. Centring
    // splits that slack evenly; when the row fills the band (few cards) this
    // is exactly the old bottom-aligned result.
    const cardW = Math.min(widthFit, areaH * g.cardAspect);
    const rowH = cardW / g.cardAspect;
    const rowTop = cardTopMin + (areaH - rowH) / 2;
    for (let i = 0; i < n; i++) {
      const asset = media.cards[i]!;
      cards.push({
        mediaId: asset.mediaId,
        x: marginX + i * (cardW + gutter),
        y: rowTop,
        w: cardW,
        h: rowH,
      });
    }
  }

  // Accent column: photo bleeds from the top; giant type occupies the band
  // below it, centred in the band and cropped by the frame edge by design.
  const accentPhotoH = accentW * (media.accent.height / media.accent.width);
  const bandTop = accentPhotoH;
  const bandH = H - bandTop;
  const capByBand = bandH * g.headlineBandFill;
  const sizeByWidth =
    (accentW * g.headlineBleed) / Math.max(1, headlineEm(content.headline) + ANTON_WEIGHT);
  const headlineSize = Math.min(
    capByBand / ((ANTON_CAP + ANTON_WEIGHT) * ANTON_STRETCH_Y),
    sizeByWidth,
  );
  const headlineCap = (ANTON_CAP + ANTON_WEIGHT) * headlineSize * ANTON_STRETCH_Y;
  const headlineStroke = headlineSize * ANTON_WEIGHT;
  const capTop = bandTop + (bandH - headlineCap) / 2;
  const headlineTracking = headlineSize * 0.04;
  const headlineInkLeft = accentX + g.headlineInset * W;
  const headlineW = headlineEm(content.headline) * headlineSize;

  const layout: SpreadLayout = {
    page: { x: 0, y: 0, w: W, h: H },
    column: { x: accentX, y: 0, w: accentW, h: H },
    accentPhoto: { x: accentX, y: 0, w: accentW, h: accentPhotoH },
    avatar: { x: marginX, y: marginTop, w: avatarSize, h: avatarSize },
    body: { x: bodyX, y: marginTop, w: bodyW, h: bodyH },
    cards,
    headline: {
      text: content.headline,
      size: headlineSize,
      strokeWidth: headlineStroke,
      letterSpacing: headlineTracking,
      capHeight: headlineCap,
      rect: { x: headlineInkLeft, y: capTop, w: headlineW, h: headlineCap },
    },
    bodyLines,
    bodySize,
    bodyLeadingPx: leading,
  };

  const clips: Clip[] = [];
  const canvas = { W, H };
  clips.push(
    imageClip({
      canvas,
      id: "spread-page",
      mediaId: media.page.mediaId,
      trackId: SPREAD_TRACKS.page,
      asset: media.page,
      rect: layout.page,
      duration,
    }),
  );
  clips.push(
    imageClip({
      canvas,
      id: "spread-column",
      mediaId: media.column.mediaId,
      trackId: SPREAD_TRACKS.column,
      asset: media.column,
      rect: layout.column,
      duration,
    }),
  );
  clips.push(
    imageClip({
      canvas,
      id: "spread-accent",
      mediaId: media.accent.mediaId,
      trackId: SPREAD_TRACKS.accent,
      asset: media.accent,
      rect: layout.accentPhoto,
      duration,
      motion: params.motion,
      motionKind: "drift",
    }),
  );
  cards.forEach((card, i) => {
    clips.push(
      imageClip({
        canvas,
        id: `spread-card-${i + 1}`,
        mediaId: card.mediaId,
        trackId: SPREAD_TRACKS.cards,
        asset: media.cards[i]!,
        rect: card,
        duration,
        motion: params.motion,
        motionKind: "card",
        motionIndex: i,
      }),
    );
  });
  clips.push(
    imageClip({
      canvas,
      id: "spread-avatar",
      mediaId: media.avatar.mediaId,
      trackId: SPREAD_TRACKS.avatar,
      asset: media.avatar,
      rect: layout.avatar,
      duration,
      motion: params.motion,
      motionKind: "avatar",
    }),
  );

  const textClips: TextClip[] = [];
  const bodyPositionY = (marginTop + bodySize * COURIER_MIDDLE_TO_TOP) / H;
  if (bodyLines.length > 0) {
    textClips.push({
      id: "spread-body",
      trackId: SPREAD_TRACKS.type,
      startTime: 0,
      duration,
      text: bodyLines.join("\n"),
      style: {
        fontFamily: fonts.body,
        fontSize: bodySize,
        fontWeight: 400,
        fontStyle: "normal",
        color: params.palette.ink,
        backgroundColor: "rgba(0,0,0,0)",
        strokeColor: "rgba(0,0,0,0)",
        strokeWidth: 0,
        textAlign: "left",
        verticalAlign: "top",
        lineHeight: g.bodyLeading,
        letterSpacing: 0,
      },
      transform: {
        position: { x: bodyX / W, y: bodyPositionY },
        scale: { x: 1, y: 1 },
        rotation: 0,
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      keyframes: params.motion
        ? textEnter(
            "body",
            params.motion.bodyDelay,
            bodyPositionY,
            params.motion.textRise / H,
          )
        : [],
    });
  }
  const headlinePositionY =
    (capTop + (ANTON_MIDDLE_TO_CAP + ANTON_WEIGHT / 2) * headlineSize * ANTON_STRETCH_Y) / H;
  if (content.headline.trim()) {
    textClips.push({
      id: "spread-headline",
      trackId: SPREAD_TRACKS.type,
      startTime: 0,
      duration,
      text: content.headline,
      style: headlineStyle(params, headlineSize, headlineStroke, headlineTracking),
      transform: {
        position: { x: headlineInkLeft / W, y: headlinePositionY },
        scale: { x: 1.06, y: ANTON_STRETCH_Y },
        rotation: 0,
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      keyframes: params.motion
        ? textEnter(
            "headline",
            params.motion.headlineDelay,
            headlinePositionY,
            (params.motion.textRise * 2) / H,
          )
        : [],
    });
  }

  const mediaIds = [
    media.page.mediaId,
    media.column.mediaId,
    media.accent.mediaId,
    media.avatar.mediaId,
    ...media.cards.map((c) => c.mediaId),
  ];
  return { clips, textClips, layout, mediaIds };
}

function headlineStyle(
  params: SpreadParams,
  size: number,
  strokeWidth: number,
  letterSpacing: number,
): TextStyle {
  return {
    fontFamily: params.fonts.display,
    fontSize: size,
    fontWeight: 400,
    fontStyle: "normal",
    color: params.palette.letter,
    backgroundColor: "rgba(0,0,0,0)",
    strokeColor: params.palette.letter,
    strokeWidth,
    textAlign: "left",
    verticalAlign: "top",
    lineHeight: 1,
    letterSpacing,
  };
}

/** contain-fit correction: engine fits the source to the canvas first. */
function containScale(asset: SpreadAsset, W: number, H: number): number {
  return Math.min(W / asset.width, H / asset.height);
}

type MotionKind = "card" | "avatar" | "drift";

function imageClip(spec: {
  canvas: { W: number; H: number };
  id: string;
  mediaId: string;
  trackId: string;
  asset: SpreadAsset;
  rect: Rect;
  duration: number;
  motion?: SpreadMotion;
  motionKind?: MotionKind;
  motionIndex?: number;
}): Clip {
  const { W, H } = spec.canvas;
  const cs = containScale(spec.asset, W, H);
  const scale = spec.rect.w / spec.asset.width / cs;
  const cx = spec.rect.x + spec.rect.w / 2;
  const cy = spec.rect.y + spec.rect.h / 2;
  const base: Clip = {
    id: spec.id,
    mediaId: spec.mediaId,
    trackId: spec.trackId,
    startTime: 0,
    duration: spec.duration,
    inPoint: 0,
    outPoint: spec.duration,
    effects: [],
    audioEffects: [],
    transform: {
      position: { x: cx - W / 2, y: cy - H / 2 },
      scale: { x: scale, y: scale },
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
      fitMode: "contain",
    },
    volume: 0,
    keyframes: [],
  };
  if (!spec.motion) return base;
  return {
    ...base,
    keyframes: imageKeyframes(base, spec.motion, spec.motionKind ?? "card", spec.motionIndex ?? 0),
  };
}

function imageKeyframes(clip: Clip, m: SpreadMotion, kind: MotionKind, index: number): Keyframe[] {
  const kfs: Keyframe[] = [];
  const t = clip.transform;
  const push = (
    time: number,
    property: string,
    value: number,
    easing: Keyframe["easing"] = "ease-out",
  ): void => {
    kfs.push({ id: `${clip.id}-${property}-${kfs.length}`, time, property, value, easing });
  };
  if (kind === "drift") {
    push(0, "position.x", t.position.x + m.drift, "linear");
    push(m.duration, "position.x", t.position.x - m.drift, "linear");
    push(0, "scale.x", t.scale.x * 1.05);
    push(m.duration, "scale.x", t.scale.x);
    push(0, "scale.y", t.scale.y * 1.05);
    push(m.duration, "scale.y", t.scale.y);
    return kfs;
  }
  if (kind === "avatar") {
    push(0, "opacity", 0);
    push(0.45, "opacity", 1);
    push(0, "scale.x", t.scale.x * 0.86);
    push(0.45, "scale.x", t.scale.x);
    push(0, "scale.y", t.scale.y * 0.86);
    push(0.45, "scale.y", t.scale.y);
    return kfs;
  }
  const start = 0.08 + index * m.cardStagger;
  const end = Math.min(m.duration - 0.05, start + m.cardFadeSeconds);
  push(start, "opacity", 0);
  push(end, "opacity", 1);
  push(start, "position.y", t.position.y + m.cardRise);
  push(end, "position.y", t.position.y);
  return kfs;
}

/** opacity + vertical rise, expressed in the engine's normalized text space. */
function textEnter(
  tag: string,
  delay: number,
  finalY: number,
  rise: number,
): Keyframe[] {
  return [
    { id: `${tag}-op0`, time: delay, property: "opacity", value: 0, easing: "ease-out" },
    { id: `${tag}-op1`, time: delay + 0.5, property: "opacity", value: 1, easing: "ease-out" },
    { id: `${tag}-py0`, time: delay, property: "position.y", value: finalY + rise, easing: "ease-out" },
    { id: `${tag}-py1`, time: delay + 0.55, property: "position.y", value: finalY, easing: "ease-out" },
  ];
}
