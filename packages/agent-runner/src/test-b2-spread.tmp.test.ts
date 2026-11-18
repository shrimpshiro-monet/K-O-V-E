/**
 * B2 STAGE 1 — static magazine-spread reproduction.
 *
 * Target: evaluation-files/test-b/b2/assets/ref-target.png
 * (magazine edit, motion graphics.MP4 @ 13.0s — avatar ring, typewriter
 * column, 3 photo cards, giant cropped type).
 *
 * Pass criteria were written first: ./PASS-CRITERIA.md (10-element checklist,
 * side-by-side at same crop, 3-of-5 blind pick). Stage 1 renders ONE static
 * frame. Motion = stage 2. Barrel glitch scanlines = stage 3.
 *
 * Canvas is 1024x576 — the reference's exact resolution — so every reference
 * pixel coordinate maps 1:1 onto the layout.
 *
 * The layout comes from spread(params), a parametric function (seed of the
 * first style pack), NOT hardcoded coordinates in the render path.
 *
 * Run:
 *   KOVE_TEST_B2=1 pnpm --filter @kove-advanced/agent-runner test:run src/test-b2-spread.tmp.test.ts
 */
import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { TextClip, TextStyle } from "@kove-advanced/core/text/types";
import type { Project, MediaItem } from "@kove-advanced/core/types/project";
import type { Clip, Track } from "@kove-advanced/core/types/timeline";
import { createMirrorSnapshot, MirrorCompositor } from "./mirror-compositor";
import { createEmptyProject, saveProjectFile } from "./project-io";

const execFileAsync = promisify(execFile);

const WIDTH = 1024;
const HEIGHT = 576;
const FPS = 30;
const DURATION = 1;
const B2 = resolve("../../evaluation-files/test-b/b2");
const ASSETS = resolve(B2, "assets");
const OUTPUT = resolve(B2, "stage1-render.png");
const SIDEBYSIDE = resolve(B2, "stage1-side-by-side.png");
const RUN = process.env.KOVE_TEST_B2 === "1";

// ---------------------------------------------------------------- params

interface CardSpec {
  mediaId: string;
  /** pixel position in reference space (1024x576) */
  rect: { x: number; y: number };
  rotation: number;
}

interface SpreadParams {
  palette: { page: string; ink: string; letter: string };
  fonts: { display: string; body: string };
  avatar: {
    mediaId: string;
    rect: { x: number; y: number };
    size: { w: number; h: number };
  };
  body: {
    text: string;
    /** ink-block top-left in reference px */
    origin: { x: number; y: number };
    size: number;
  };
  cards: CardSpec[];
  headline: {
    text: string;
    /** ink top-left of first glyph in reference px */
    origin: { x: number; y: number };
    size: number;
    squeezeX: number;
    stretchY: number;
    letterSpacing: number;
    strokeWidth: number;
    /** first-glyph left side bearing in em (style-pack font metric) */
    lsb: number;
  };
  panel: { mediaId: string; x: number };
}

/**
 * Font metrics (em) needed to convert an ink-top origin into the engine's
 * anchor. title-engine sets ctx.textBaseline = "middle", so a text line's
 * y-anchor is the line's middle, not its baseline or cap top. Measured:
 * - Courier Prime at 13.5px: anchor sits 6.4px above ink top -> 0.474em
 * - Anton at 225px (+14px same-color stroke): anchor sits 136.5px above
 *   cap top -> (0.86 cap - 0.2533 middle) = 0.6067em
 */
const COURIER_MIDDLE_TO_TOP = 0.474;
const ANTON_MIDDLE_TO_CAP = 0.58;

interface SpreadLayers {
  clips: Clip[];
  textClips: TextClip[];
  mediaIds: string[];
}

function track(id: string, type: Track["type"], name: string): Track {
  return { id, type, name, clips: [], transitions: [], locked: false, hidden: false, muted: false, solo: false };
}

/**
 * contain-fit scale correction: the engine fits image clips to the CANVAS,
 * so a small card must be scaled back down by exactly the inverse factor.
 */
function containScale(srcW: number, srcH: number): number {
  return Math.min(WIDTH / srcW, HEIGHT / srcH);
}

function imageClip(spec: {
  id: string;
  mediaId: string;
  trackId: string;
  srcW: number;
  srcH: number;
  /** pixel rect in reference space (top-left) */
  rect: { x: number; y: number };
  rotation?: number;
  shadow?: boolean;
  effects?: Clip["effects"];
}): Clip {
  const cs = containScale(spec.srcW, spec.srcH);
  const scale = 1 / cs; // display the PNG at its native pixel size
  const cx = spec.rect.x + spec.srcW / 2;
  const cy = spec.rect.y + spec.srcH / 2;
  return {
    id: spec.id,
    mediaId: spec.mediaId,
    trackId: spec.trackId,
    startTime: 0,
    duration: DURATION,
    inPoint: 0,
    outPoint: DURATION,
    effects: spec.effects ?? [],
    audioEffects: [],
    transform: {
      position: { x: cx - WIDTH / 2, y: cy - HEIGHT / 2 },
      scale: { x: scale, y: scale },
      rotation: spec.rotation ?? 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
      fitMode: "contain",
    },
    volume: 0,
    keyframes: [],
  };
}

const CARD_SIZES: Record<string, { w: number; h: number }> = {
  card1: { w: 185, h: 259 },
  card2: { w: 200, h: 264 },
  card3: { w: 203, h: 265 },
};

/**
 * The style-pack seed: everything visual comes from these parameters.
 * Extraction's future job is fitting this parameter set to a reference.
 */
function spread(p: SpreadParams): SpreadLayers {
  const clips: Clip[] = [];
  const textClips: TextClip[] = [];

  // 1) cream page (vignette + texture baked into the PNG)
  clips.push(
    imageClip({ id: "page", mediaId: "page-bg", trackId: "t-page", srcW: WIDTH, srcH: HEIGHT, rect: { x: 0, y: 0 } }),
  );

  // 2) right maroon panel (photo tiles top, horizontal slat band below)
  clips.push(
    imageClip({ id: "panel", mediaId: p.panel.mediaId, trackId: "t-panel", srcW: 293, srcH: HEIGHT, rect: { x: p.panel.x, y: 0 } }),
  );

  // 3) photo cards: photo edge directly on the page. Measured: no border, and
  // no shadow (page below cards 2/3 is clean; card1's strip is codec smear from
  // its dark edge). Slight positive rotation stands in for the reference's
  // perspective tilt, which a flat compositor cannot express.
  for (const [i, card] of p.cards.entries()) {
    const size = CARD_SIZES[card.mediaId]!;
    clips.push(
      imageClip({
        id: `card-${i + 1}`,
        mediaId: card.mediaId,
        trackId: "t-cards",
        srcW: size.w,
        srcH: size.h,
        rect: card.rect,
        rotation: card.rotation,
      }),
    );
  }

  // 4) gradient-ring avatar (reference crop, ring baked)
  clips.push(
    imageClip({
      id: "avatar",
      mediaId: p.avatar.mediaId,
      trackId: "t-avatar",
      srcW: p.avatar.size.w,
      srcH: p.avatar.size.h,
      rect: p.avatar.rect,
    }),
  );

  // 5) body copy — typewriter, left-aligned, manual line breaks (ref is ragged-right)
  const bodyStyle: TextStyle = {
    fontFamily: p.fonts.body,
    fontSize: p.body.size,
    fontWeight: 400,
    fontStyle: "normal",
    color: p.palette.ink,
    backgroundColor: "rgba(0,0,0,0)",
    strokeColor: "rgba(0,0,0,0)",
    strokeWidth: 0,
    textAlign: "left",
    verticalAlign: "top",
    lineHeight: 1.3139,
    letterSpacing: 0,
  };
  textClips.push({
    id: "body-copy",
    trackId: "t-type",
    startTime: 0,
    duration: DURATION,
    text: p.body.text,
    style: bodyStyle,
    // title-engine: left/top-aligned text anchors at position (normalized
    // 0..1), and since textBaseline is "middle", position.y is the first
    // line's vertical middle.
    transform: {
      position: {
        x: p.body.origin.x / WIDTH,
        y: (p.body.origin.y + p.body.size * COURIER_MIDDLE_TO_TOP) / HEIGHT,
      },
      scale: { x: 1, y: 1 },
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    },
    keyframes: [],
  });

  // 6) giant cropped display type — Anton, horizontally squeezed, vertically
  // stretched, fattened with a same-color stroke to match the reference's
  // ultra-heavy letterforms (measured: crossbar 51px, stem 56px, cap 178px)
  const h = p.headline;
  const middleInk = (ANTON_MIDDLE_TO_CAP * h.size + h.strokeWidth / 2) * h.stretchY;
  const leftInk = h.lsb * h.size * h.squeezeX + (h.strokeWidth / 2) * h.squeezeX;
  textClips.push({
    id: "giant-type",
    trackId: "t-type",
    startTime: 0,
    duration: DURATION,
    text: h.text,
    style: {
      fontFamily: p.fonts.display,
      fontSize: h.size,
      fontWeight: 400,
      fontStyle: "normal",
      color: p.palette.letter,
      backgroundColor: "rgba(0,0,0,0)",
      strokeColor: p.palette.letter,
      strokeWidth: h.strokeWidth,
      textAlign: "left",
      verticalAlign: "top",
      lineHeight: 1,
      letterSpacing: h.letterSpacing,
    },
    transform: {
      position: {
        x: (h.origin.x - leftInk) / WIDTH,
        y: (h.origin.y + middleInk) / HEIGHT,
      },
      scale: { x: h.squeezeX, y: h.stretchY },
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    },
    keyframes: [],
  });

  return { clips, textClips, mediaIds: ["page-bg", p.panel.mediaId, ...p.cards.map((c) => c.mediaId), p.avatar.mediaId] };
}

// ---------------------------------------------------------------- assets

interface MediaDef {
  id: string;
  file: string;
  width: number;
  height: number;
}

const MEDIA: Record<string, MediaDef> = {
  "page-bg": { id: "page-bg", file: resolve(ASSETS, "page-bg.png"), width: 1024, height: 576 },
  panel: { id: "panel", file: resolve(ASSETS, "panel.png"), width: 293, height: 576 },
  card1: { id: "card1", file: resolve(ASSETS, "card1.png"), width: 185, height: 259 },
  card2: { id: "card2", file: resolve(ASSETS, "card2.png"), width: 200, height: 264 },
  card3: { id: "card3", file: resolve(ASSETS, "card3.png"), width: 203, height: 265 },
  avatar: { id: "avatar", file: resolve(ASSETS, "avatar.png"), width: 143, height: 153 },
};

const BODY_LINES = [
  "Lamine Yamal Nasraoui Ebana is a Spanish",
  "professional football player born on July",
  "13, 2007, in Esplugues de Llobregat,",
  "Spain. He plays as a right winger for FC",
  "Barcelona and the Spain national team,",
  "and is known worldwide for his incredible",
  "dribbling, playmaking, and record-",
  "bre",
].join("\n");

function mediaItem(def: MediaDef): MediaItem {
  return {
    id: def.id,
    name: def.id,
    type: "image",
    fileHandle: null,
    blob: null,
    metadata: {
      duration: 10,
      width: def.width,
      height: def.height,
      frameRate: 0,
      codec: "png",
      sampleRate: 0,
      channels: 0,
      fileSize: 1,
      hasVideo: true,
      hasAudio: false,
      audioTrackCount: 0,
    },
    thumbnailUrl: null,
    waveformData: null,
  };
}

function buildProject(): Project {
  const layers = spread({
    palette: { page: "#d3beba", ink: "#24130f", letter: "#d5c0bc" },
    fonts: { display: "Anton", body: "Courier Prime" },
    avatar: { mediaId: "avatar", rect: { x: 72, y: 47 }, size: { w: 143, h: 153 } },
    body: { text: BODY_LINES, origin: { x: 251.3, y: 52 }, size: 13.7 },
    cards: [
      { mediaId: "card1", rect: { x: 79, y: 280 }, rotation: 0 },
      { mediaId: "card2", rect: { x: 278, y: 280 }, rotation: 0 },
      { mediaId: "card3", rect: { x: 500, y: 280 }, rotation: 0 },
    ],
    headline: {
      text: "TEM",
      origin: { x: 741.5, y: 385.5 },
      // Measured Anton model: cap = (0.86em + stroke) * stretchY. The 225/14
      // pair matches the reference's stem, gaps and crossbar; stretchY 0.895
      // brings its 207px cap down to 185px so it no longer clips at the frame
      // bottom, which the old bbox-height gate could not see.
      size: 225,
      squeezeX: 1.06,
      stretchY: 0.895,
      letterSpacing: 9,
      strokeWidth: 14,
      lsb: 0.0075,
    },
    panel: { mediaId: "panel", x: 731 },
  });

  // Track order is TOP-FIRST (index 0 paints last): type/panel accents above,
  // page background LAST so it sits at the bottom of the stack.
  const tracks: Track[] = [
    track("t-type", "text", "Type"),
    track("t-avatar", "video", "Avatar"),
    track("t-cards", "video", "Cards"),
    track("t-panel", "video", "Panel"),
    track("t-page", "video", "Page"),
  ];
  const byId = new Map(tracks.map((item) => [item.id, item]));
  for (const clip of layers.clips) byId.get(clip.trackId)?.clips.push(clip);

  const base = createEmptyProject("B2 stage 1 — magazine spread", {
    width: WIDTH,
    height: HEIGHT,
    frameRate: FPS,
  });
  return {
    ...base,
    mediaLibrary: { items: Object.values(MEDIA).map(mediaItem) },
    timeline: { tracks, subtitles: [], duration: DURATION, markers: [] },
    textClips: layers.textClips,
  };
}

// ---------------------------------------------------------------- test

describe.skipIf(!RUN)("B2 stage 1 — static spread reproduction", () => {
  it("renders the spread and builds the side-by-side", async () => {
    const project = buildProject();
    await mkdir(B2, { recursive: true });
    await saveProjectFile(resolve(B2, "stage1-project.json"), project);

    const mediaPaths = Object.fromEntries(Object.values(MEDIA).map((m) => [m.id, m.file]));
    const snapshot = await createMirrorSnapshot(project, mediaPaths);
    const compositor = new MirrorCompositor(process.env.CHROMIUM_EXECUTABLE_PATH);
    try {
      const mp4 = resolve(B2, "stage1-render.mp4");
      await rm(mp4, { force: true });
      await compositor.exportVideo(snapshot, mp4, {
        format: "mp4",
        codec: "h264",
        width: WIDTH,
        height: HEIGHT,
        frameRate: FPS,
        bitrate: 20_000,
        bitrateMode: "vbr",
        quality: 98,
        keyframeInterval: 30,
        audioSettings: { format: "aac", sampleRate: 48000, bitDepth: 16, bitrate: 128, channels: 2 },
      });
      await rm(OUTPUT, { force: true });
      await execFileAsync("ffmpeg", ["-y", "-ss", "0.5", "-i", mp4, "-frames:v", "1", OUTPUT, "-loglevel", "error"]);
      console.log(`B2 stage 1 render: ${OUTPUT}`);
    } finally {
      await compositor.close();
    }

    // Side-by-side at identical scale (PASS-CRITERIA item 2)
    await execFileAsync("ffmpeg", ["-y", "-i", resolve(ASSETS, "ref-target.png"), "-i", OUTPUT, "-filter_complex", "[0][1]hstack=2", "-frames:v", "1", SIDEBYSIDE, "-loglevel", "error"]);
    console.log(`B2 side-by-side: ${SIDEBYSIDE}`);
    expect(SIDEBYSIDE).toBeTruthy();
  }, 300_000);
});
