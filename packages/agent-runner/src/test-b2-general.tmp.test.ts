/**
 * B2 STAGE 1.5 — does `spreadLayout()` encode design rules or one frame?
 *
 * Stage 1 proved the compositor can hit a measured layout with the reference's
 * own pixels. This test changes everything except the design system:
 *
 *   variant  cards  headline  palette                     motion
 *   A        2      PLAY      ink-blue page / sand column  3s enter
 *   B        4      MOTION    charcoal page / cream column  none
 *   C        3      CUT       warm-grey page / oxblood      none
 *
 * No per-variant coordinates and no per-variant branches: every rect is
 * derived from the shared grid. If a variant only looks designed after tuning
 * rects, the function fails.
 *
 * Run:
 *   KOVE_TEST_B2_GENERAL=1 pnpm --filter @kove-advanced/agent-runner test:run \
 *     src/test-b2-general.tmp.test.ts
 */
import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { Project, MediaItem } from "@kove-advanced/core/types/project";
import type { Track } from "@kove-advanced/core/types/timeline";
import { createMirrorSnapshot, MirrorCompositor } from "./mirror-compositor";
import { createEmptyProject, saveProjectFile } from "./project-io";
import {
  DEFAULT_SPREAD_GRID,
  spreadLayout,
  spreadTrackList,
  type SpreadAsset,
  type SpreadLayout,
  type SpreadMedia,
  type SpreadMotion,
  type SpreadPalette,
} from "./spread-layout";

const execFileAsync = promisify(execFile);

const WIDTH = 1024;
const HEIGHT = 576;
const FPS = 30;
const GENERAL = resolve("../../evaluation-files/test-b/general");
const PHOTOS = resolve(GENERAL, "photos");
const OUT = resolve(GENERAL, "out");
const RUN = process.env.KOVE_TEST_B2_GENERAL === "1";

// ---------------------------------------------------------------- assets

const asset = (mediaId: string, file: string, width: number, height: number): Asset => ({
  mediaId,
  file,
  width,
  height,
});

interface Asset extends SpreadAsset {
  readonly file: string;
}

const PAGE: Record<string, Asset> = {
  A: asset("page-A", resolve(PHOTOS, "page-A.png"), 1024, 576),
  B: asset("page-B", resolve(PHOTOS, "page-B.png"), 1024, 576),
  C: asset("page-C", resolve(PHOTOS, "page-C.png"), 1024, 576),
};
const COLUMN: Record<string, Asset> = {
  A: asset("column-A", resolve(PHOTOS, "column-A.png"), 293, 576),
  B: asset("column-B", resolve(PHOTOS, "column-B.png"), 293, 576),
  C: asset("column-C", resolve(PHOTOS, "column-C.png"), 293, 576),
};
const ACCENT = asset("accent", resolve(PHOTOS, "accent.jpg"), 480, 640);
const AVATAR = asset("avatar", resolve(PHOTOS, "avatar.png"), 300, 300);
const CARDS: readonly Asset[] = [
  asset("card-1", resolve(PHOTOS, "card-1.jpg"), 480, 640),
  asset("card-2", resolve(PHOTOS, "card-2.jpg"), 480, 640),
  asset("card-3", resolve(PHOTOS, "card-3.jpg"), 480, 640),
  asset("card-4", resolve(PHOTOS, "card-4.jpg"), 480, 640),
];

// ---------------------------------------------------------------- variants

interface VariantSpec {
  readonly id: "A" | "B" | "C";
  readonly cards: number;
  readonly headline: string;
  readonly palette: SpreadPalette;
  readonly body: string;
  readonly motion?: SpreadMotion;
}

const VARIANTS: readonly VariantSpec[] = [
  {
    id: "A",
    cards: 2,
    headline: "PLAY",
    palette: { ink: "#efe3cf", letter: "#16222c" },
    body:
      "The subject enters the frame without announcement, moving through light and shadow. " +
      "Shot on location over three evenings, the sequence keeps its attention on rhythm: the pause " +
      "before a turn, the weight of a step, and the moment a gesture lands. Nothing is staged twice.",
    motion: {
      duration: 3,
      cardStagger: 0.16,
      cardRise: 26,
      cardFadeSeconds: 0.5,
      bodyDelay: 0.45,
      headlineDelay: 0.28,
      textRise: 18,
      drift: 7,
    },
  },
  {
    id: "B",
    cards: 4,
    headline: "MOTION",
    palette: { ink: "#f1ece3", letter: "#161616" },
    body:
      "A short study of motion. The camera stays close, the cuts stay quiet, and the frame does " +
      "the work: a glance, a step, the space between them.",
  },
  {
    id: "C",
    cards: 3,
    headline: "CUT",
    palette: { ink: "#3a1d24", letter: "#e8e0d3" },
    body:
      "An edit is a set of decisions about attention. What stays, what goes, and how long the frame " +
      "holds. This spread treats the page the same way: one subject, one measure, and enough room " +
      "for the eye to move.",
  },
];

const DURATION_STILL = 0.6;

// ---------------------------------------------------------------- project

function mediaItem(def: Asset): MediaItem {
  return {
    id: def.mediaId,
    name: def.mediaId,
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

interface BuiltVariant {
  readonly project: Project;
  readonly mediaPaths: Record<string, string>;
  readonly duration: number;
  readonly layout: SpreadLayout;
}

function buildVariant(spec: VariantSpec): BuiltVariant {
  const media: SpreadMedia = {
    page: PAGE[spec.id]!,
    column: COLUMN[spec.id]!,
    accent: ACCENT,
    avatar: AVATAR,
    cards: CARDS.slice(0, spec.cards),
  };
  const duration = spec.motion ? spec.motion.duration : DURATION_STILL;
  const layers = spreadLayout({
    width: WIDTH,
    height: HEIGHT,
    duration,
    palette: spec.palette,
    fonts: { display: "Anton", body: "Courier Prime" },
    content: { headline: spec.headline, body: spec.body },
    media,
    motion: spec.motion,
  });

  const tracks: Track[] = spreadTrackList();
  const byId = new Map(tracks.map((item) => [item.id, item]));
  for (const clip of layers.clips) {
    const owner = byId.get(clip.trackId);
    if (!owner) throw new Error(`spread clip ${clip.id} has unknown track ${clip.trackId}`);
    owner.clips.push(clip);
  }

  const assets: readonly Asset[] = [
    PAGE[spec.id]!,
    COLUMN[spec.id]!,
    ACCENT,
    AVATAR,
    ...CARDS.slice(0, spec.cards),
  ];
  const project: Project = {
    ...createEmptyProject(`B2 stage 1.5 — variant ${spec.id}`, {
      width: WIDTH,
      height: HEIGHT,
      frameRate: FPS,
    }),
    mediaLibrary: { items: assets.map(mediaItem) },
    timeline: { tracks, subtitles: [], duration, markers: [] },
    textClips: [...layers.textClips],
  };
  return {
    project,
    mediaPaths: Object.fromEntries(assets.map((item) => [item.mediaId, item.file])),
    duration,
    layout: layers.layout,
  };
}

// ---------------------------------------------------------------- checks

function expectWithin(actual: number, expected: number, tolerance: number, label: string): void {
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance);
}

function checkLayout(spec: VariantSpec, built: BuiltVariant): void {
  const L = built.layout;
  expect(L.cards).toHaveLength(spec.cards);
  expect(L.bodyLines.length).toBeGreaterThan(1);
  expect(L.bodyLines.length).toBeLessThanOrEqual(14);

  const G = DEFAULT_SPREAD_GRID;
  const accentX = L.column.x;
  const contentRight = accentX - G.accentGap * WIDTH;
  const gutter = G.gutter * WIDTH;

  // Cards share one width, one bottom baseline and equal gutters.
  const card0 = L.cards[0]!;
  for (const [i, card] of L.cards.entries()) {
    expectWithin(card.w, card0.w, 0.01, `card ${i} width`);
    expectWithin(card.y + card.h, card0.y + card0.h, 0.01, `card ${i} baseline`);
    expectWithin(card.w / card.h, G.cardAspect, 0.001, `card ${i} aspect`);
    if (i > 0) {
      const prev = L.cards[i - 1]!;
      expectWithin(card.x - (prev.x + prev.w), gutter, 0.01, `gutter ${i - 1}->${i}`);
    }
  }
  expect(card0.x).toBeGreaterThanOrEqual(G.marginX * WIDTH - 0.5);
  expect(L.cards[L.cards.length - 1]!.x + card0.w).toBeLessThanOrEqual(contentRight + 0.5);
  expect(card0.y).toBeGreaterThanOrEqual(L.body.y + L.body.h - 0.5);

  // The row is centred in the band below the copy: equal slack above (past the
  // designed body gap) and below. A row that fills the band has zero slack.
  const bandTop = L.body.y + L.body.h + G.cardGapLeadings * L.bodyLeadingPx;
  const bandBottom = HEIGHT - G.marginBottom * HEIGHT;
  const slackAbove = card0.y - bandTop;
  const slackBelow = bandBottom - (card0.y + card0.h);
  expectWithin(slackAbove, slackBelow, 0.5, "card row slack");

  // Body measure sits between the avatar and the accent column, and clears the
  // cards vertically.
  expect(L.avatar.x + L.avatar.w).toBeLessThan(L.body.x);
  expect(L.body.x + L.body.w).toBeLessThanOrEqual(contentRight + 0.5);
  expect(L.body.y + L.body.h).toBeLessThanOrEqual(card0.y + 0.5);

  // Type hierarchy: display scale vs body scale, headline inside the column.
  expect(L.headline.capHeight).toBeGreaterThanOrEqual(L.bodySize * 6);
  expect(L.headline.rect.x).toBeGreaterThanOrEqual(accentX - 0.5);
  expect(L.headline.rect.w).toBeGreaterThanOrEqual(L.column.w);
  expect(L.headline.rect.w).toBeLessThanOrEqual(L.column.w * (G.headlineBleed + 0.01));
  expect(L.headline.rect.y).toBeGreaterThanOrEqual(L.accentPhoto.y + L.accentPhoto.h - 0.5);

  // Everything stays on canvas.
  for (const rect of [L.page, L.column, L.accentPhoto, L.avatar, L.body, ...L.cards]) {
    expect(rect.x).toBeGreaterThanOrEqual(-0.5);
    expect(rect.y).toBeGreaterThanOrEqual(-0.5);
    expect(rect.x + rect.w).toBeLessThanOrEqual(WIDTH + 0.5);
    expect(rect.y + rect.h).toBeLessThanOrEqual(HEIGHT + 0.5);
  }
}

// ---------------------------------------------------------------- test

describe.skipIf(!RUN)("B2 stage 1.5 — general layout + motion", () => {
  it("renders three parameter variants and one 3s motion clip", async () => {
    await rm(OUT, { recursive: true, force: true });
    await mkdir(OUT, { recursive: true });

    const compositor = new MirrorCompositor(process.env.CHROMIUM_EXECUTABLE_PATH);
    try {
      for (const spec of VARIANTS) {
        const built = buildVariant(spec);
        checkLayout(spec, built);
        await saveProjectFile(resolve(OUT, `variant-${spec.id}-project.json`), built.project);

        const snapshot = await createMirrorSnapshot(built.project, built.mediaPaths);
        const mp4 = resolve(OUT, `variant-${spec.id}.mp4`);
        await rm(mp4, { force: true });
        const result = await compositor.exportVideo(snapshot, mp4, {
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
        expect(result.framesRendered).toBe(Math.round(built.duration * FPS));

        const stillTime = spec.motion ? built.duration - 0.1 : 0.4;
        const still = resolve(OUT, `variant-${spec.id}.png`);
        await rm(still, { force: true });
        await execFileAsync("ffmpeg", [
          "-y", "-ss", String(stillTime), "-i", mp4, "-frames:v", "1", still, "-loglevel", "error",
        ]);

        if (spec.motion) {
          const times = [0.15, 0.5, 0.85, 1.2, 2.0, 2.9];
          for (const [i, t] of times.entries()) {
            const frame = resolve(OUT, `motion-${String(i + 1).padStart(2, "0")}.png`);
            await execFileAsync("ffmpeg", [
              "-y", "-ss", String(t), "-i", mp4, "-frames:v", "1",
              "-vf", "scale=512:-1", frame, "-loglevel", "error",
            ]);
          }
          // Motion must actually change pixels, not hold one frame.
          const a = resolve(OUT, "motion-01.png");
          const b = resolve(OUT, "motion-06.png");
          const ssim = await execFileAsync("ffmpeg", [
            "-i", a, "-i", b, "-lavfi", "ssim", "-f", "null", "-",
          ]);
          const match = /All:([0-9.]+)/.exec(ssim.stderr);
          expect(match, "ffmpeg ssim output").toBeTruthy();
          expect(Number(match![1])).toBeLessThan(0.98);
        }

        console.log(`variant ${spec.id}: ${result.framesRendered} frames, card count ${spec.cards}`);
      }
    } finally {
      await compositor.close();
    }

    console.log(`stage 1.5 output: ${OUT}`);
  }, 600_000);
});
