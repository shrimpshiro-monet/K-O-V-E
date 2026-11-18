/**
 * B2 CURRY — the general magazine spread, run as a three-page scrapbook.
 *
 * Stage 1.5 proved `spreadLayout()` is a design function with stand-in footage.
 * This test swaps in the user's Curry batch and renders a 9s cut: three 3s
 * pages, three palettes, six photos and two real video highlights. Nothing in
 * `spread-layout.ts` changes. Only content, palette and grid parameters differ
 * between pages — there are no per-scene coordinates or branches.
 *
 *   page 1  CURRY  cream / navy / gold   celebration · short clip · trophies
 *   page 2  30     navy / cream / navy   shooting · game clip · award
 *   page 3  FOUR   sand / deep navy      jersey · trophies · award
 *
 * Both video cards are pre-cropped 3:4 assets played through the same
 * `imageClip()` path as the stills; the compositor's SSIM/motion gate still
 * applies. The pages are exported separately and concatenated, so every cut
 * is a real hard edit and every page keeps the full 3s animation.
 *
 * Run:
 *   KOVE_TEST_B2_CURRY=1 pnpm --filter @kove-advanced/agent-runner test:run \
 *     src/test-b2-curry.tmp.test.ts
 */
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
  type SpreadGrid,
  type SpreadLayout,
  type SpreadMedia,
  type SpreadMotion,
  type SpreadPalette,
} from "./spread-layout";

const execFileAsync = promisify(execFile);

const WIDTH = 1024;
const HEIGHT = 576;
const FPS = 30;
const DURATION = 3;
/** A proper name has to read in full; the reference's heavy edge crop does not. */
const HEADLINE_BLEED = 0.86;
const CURRY = resolve("../../evaluation-files/test-b/curry");
const PHOTOS = resolve(CURRY, "photos");
const OUT = resolve(CURRY, "out");
const RUN = process.env.KOVE_TEST_B2_CURRY === "1";

// ---------------------------------------------------------------- assets

interface Asset extends SpreadAsset {
  readonly file: string;
  readonly type: "image" | "video";
  readonly duration: number;
}

function asset(
  mediaId: string,
  file: string,
  width: number,
  height: number,
  type: "image" | "video" = "image",
): Asset {
  return {
    mediaId,
    file: resolve(PHOTOS, file),
    width,
    height,
    type,
    duration: type === "video" ? 3.2 : 10,
  };
}

const PAGE_CREAM = asset("page-cream", "page-curry.png", 1024, 576);
const COLUMN_NAVY = asset("column-navy", "column-curry.png", 293, 576);
const PAGE_NAVY = asset("page-navy", "page-navy.png", 1024, 576);
const COLUMN_CREAM = asset("column-cream", "column-cream.png", 293, 576);
const PAGE_SAND = asset("page-sand", "page-sand.png", 1024, 576);
const COLUMN_DEEP = asset("column-deep", "column-deep.png", 293, 576);

const ACCENT_JERSEY = asset("accent-jersey", "accent.jpg", 480, 640);
const ACCENT_CELEBRATION = asset("accent-celebration", "accent-celebration.jpg", 480, 640);
const ACCENT_SHOOTING = asset("accent-shooting", "accent-shooting.jpg", 480, 640);
const AVATAR = asset("avatar", "avatar.png", 300, 300);

const CARD_CELEBRATION = asset("card-celebration", "card-1.jpg", 480, 640);
const CARD_SHORT_VIDEO = asset("card-short", "card-2.mp4", 480, 640, "video");
const CARD_TROPHIES = asset("card-trophies", "card-3.jpg", 480, 640);
const CARD_SHOOTING = asset("card-shooting", "card-4.jpg", 480, 640);
const CARD_LONG_VIDEO = asset("card-long", "card-5.mp4", 480, 640, "video");
const CARD_AWARD = asset("card-award", "card-6.jpg", 480, 640);
const CARD_JERSEY = asset("card-jersey", "card-7.jpg", 480, 640);

// ---------------------------------------------------------------- scenes

interface SceneSpec {
  readonly id: string;
  readonly label: string;
  readonly page: Asset;
  readonly column: Asset;
  readonly accent: Asset;
  readonly avatar: Asset;
  readonly cards: readonly Asset[];
  readonly palette: SpreadPalette;
  readonly headline: string;
  readonly body: string;
  readonly motion: SpreadMotion;
  readonly grid?: Partial<SpreadGrid>;
}

const SCENES: readonly SceneSpec[] = [
  {
    id: "curry",
    label: "CURRY — cream / navy / gold · celebration · short clip · trophies",
    page: PAGE_CREAM,
    column: COLUMN_NAVY,
    accent: ACCENT_JERSEY,
    avatar: AVATAR,
    cards: [CARD_CELEBRATION, CARD_SHORT_VIDEO, CARD_TROPHIES],
    palette: { ink: "#16263f", letter: "#e8b34a" },
    headline: "CURRY",
    body:
      "Stephen Curry never arrives at the moment; he builds toward it. The warm-up is a ritual, " +
      "the shot is a decision, the celebration is the release. Four championships, two MVPs, one " +
      "motion, repeated until it looks effortless.",
    motion: {
      duration: DURATION,
      cardStagger: 0.16,
      cardRise: 26,
      cardFadeSeconds: 0.5,
      bodyDelay: 0.45,
      headlineDelay: 0.28,
      textRise: 18,
      drift: 7,
    },
    grid: { headlineBleed: HEADLINE_BLEED },
  },
  {
    id: "thirty",
    label: "30 — navy / cream · shooting · game clip · award",
    page: PAGE_NAVY,
    column: COLUMN_CREAM,
    accent: ACCENT_CELEBRATION,
    avatar: AVATAR,
    cards: [CARD_SHOOTING, CARD_LONG_VIDEO, CARD_AWARD],
    palette: { ink: "#efe3cf", letter: "#12233f" },
    headline: "30",
    body:
      "Thirty is the number on the back, not the limit of the range. He shoots from the logo, " +
      "runs the floor, and makes the impossible look like repetition. The work is the story.",
    motion: {
      duration: DURATION,
      cardStagger: 0.2,
      cardRise: 34,
      cardFadeSeconds: 0.55,
      bodyDelay: 0.18,
      headlineDelay: 0.06,
      textRise: 24,
      drift: 9,
    },
  },
  {
    id: "four",
    label: "FOUR — sand / deep navy · jersey · trophies · award",
    page: PAGE_SAND,
    column: COLUMN_DEEP,
    accent: ACCENT_SHOOTING,
    avatar: AVATAR,
    cards: [CARD_JERSEY, CARD_TROPHIES, CARD_AWARD],
    palette: { ink: "#16263f", letter: "#e8b34a" },
    headline: "FOUR",
    body:
      "Four championships. Two MVPs. One motion. The celebration changes; the work does not. " +
      "The number stays on the back, and the standard stays in the room. The room is the same.",
    motion: {
      duration: DURATION,
      cardStagger: 0.12,
      cardRise: 20,
      cardFadeSeconds: 0.45,
      bodyDelay: 0.5,
      headlineDelay: 0.35,
      textRise: 14,
      drift: 5,
    },
    grid: { headlineBleed: HEADLINE_BLEED },
  },
];

// ---------------------------------------------------------------- project

function mediaItem(def: Asset): MediaItem {
  const isVideo = def.type === "video";
  return {
    id: def.mediaId,
    name: def.mediaId,
    type: def.type,
    fileHandle: null,
    blob: null,
    metadata: {
      duration: def.duration,
      width: def.width,
      height: def.height,
      frameRate: isVideo ? FPS : 0,
      codec: isVideo ? "h264" : def.file.endsWith(".png") ? "png" : "jpeg",
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

interface BuiltScene {
  readonly project: Project;
  readonly mediaPaths: Record<string, string>;
  readonly layout: SpreadLayout;
}

function buildScene(spec: SceneSpec): BuiltScene {
  const media: SpreadMedia = {
    page: spec.page,
    column: spec.column,
    accent: spec.accent,
    avatar: spec.avatar,
    cards: spec.cards,
  };
  const layers = spreadLayout({
    width: WIDTH,
    height: HEIGHT,
    duration: DURATION,
    palette: spec.palette,
    fonts: { display: "Anton", body: "Courier Prime" },
    content: { headline: spec.headline, body: spec.body },
    media,
    motion: spec.motion,
    grid: spec.grid,
  });

  const tracks: Track[] = spreadTrackList();
  const byId = new Map(tracks.map((item) => [item.id, item]));
  for (const clip of layers.clips) {
    const owner = byId.get(clip.trackId);
    if (!owner) throw new Error(`spread clip ${clip.id} has unknown track ${clip.trackId}`);
    owner.clips.push(clip);
  }

  const assets: readonly Asset[] = [
    spec.page,
    spec.column,
    spec.accent,
    spec.avatar,
    ...spec.cards,
  ];
  const project: Project = {
    ...createEmptyProject(`B2 Curry — ${spec.id}`, {
      width: WIDTH,
      height: HEIGHT,
      frameRate: FPS,
    }),
    mediaLibrary: { items: assets.map(mediaItem) },
    timeline: { tracks, subtitles: [], duration: DURATION, markers: [] },
    textClips: [...layers.textClips],
  };
  return {
    project,
    mediaPaths: Object.fromEntries(assets.map((item) => [item.mediaId, item.file])),
    layout: layers.layout,
  };
}

// ---------------------------------------------------------------- checks

function expectWithin(actual: number, expected: number, tolerance: number, label: string): void {
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance);
}

function checkScene(spec: SceneSpec, built: BuiltScene): void {
  const L = built.layout;
  const G = DEFAULT_SPREAD_GRID;
  expect(L.cards, spec.id).toHaveLength(3);
  expect(L.cards.map((card) => card.mediaId)).toEqual(spec.cards.map((card) => card.mediaId));

  // Shared grid: equal widths, one baseline, equal gutters, 3:4 cards.
  const card0 = L.cards[0]!;
  for (const [i, card] of L.cards.entries()) {
    expectWithin(card.w, card0.w, 0.01, `${spec.id} card ${i} width`);
    expectWithin(card.y + card.h, card0.y + card0.h, 0.01, `${spec.id} card ${i} baseline`);
    expectWithin(card.w / card.h, G.cardAspect, 0.001, `${spec.id} card ${i} aspect`);
    if (i > 0) {
      const prev = L.cards[i - 1]!;
      expectWithin(card.x - (prev.x + prev.w), G.gutter * WIDTH, 0.01, `${spec.id} gutter ${i - 1}->${i}`);
    }
  }
  expect(card0.x).toBeGreaterThanOrEqual(G.marginX * WIDTH - 0.5);
  expect(L.cards[2]!.x + card0.w).toBeLessThanOrEqual(L.column.x - G.accentGap * WIDTH + 0.5);

  // Row centred in the band left by the copy.
  const bandTop = L.body.y + L.body.h + G.cardGapLeadings * L.bodyLeadingPx;
  const bandBottom = HEIGHT - G.marginBottom * HEIGHT;
  expectWithin(card0.y - bandTop, bandBottom - (card0.y + card0.h), 0.5, `${spec.id} card row slack`);

  // Type + copy live on the grid.
  expect(L.bodyLines.length).toBeGreaterThan(3);
  expect(L.bodyLines.length).toBeLessThanOrEqual(G.maxBodyLines);
  expect(L.avatar.x + L.avatar.w).toBeLessThan(L.body.x);
  expect(L.body.y + L.body.h).toBeLessThanOrEqual(card0.y + 0.5);
  expect(L.headline.capHeight).toBeGreaterThanOrEqual(L.bodySize * 6);

  // A headline either fills the column's width (long word) or the band's
  // height (short word like "30"). Both are grid outcomes, not branches.
  const bleed = spec.grid?.headlineBleed ?? G.headlineBleed;
  const bandH = HEIGHT - L.accentPhoto.h;
  const widthFills = L.headline.rect.w >= L.column.w * Math.min(0.85, bleed) * 0.9;
  const heightFills = L.headline.rect.h >= bandH * 0.85;
  expect(widthFills || heightFills, `${spec.id} headline fills column or band`).toBe(true);
  expect(L.headline.rect.x).toBeGreaterThanOrEqual(L.column.x - 0.5);
  expect(L.headline.rect.w).toBeLessThanOrEqual(L.column.w * (bleed + 0.01));
  expect(L.headline.rect.h).toBeLessThanOrEqual(bandH + 0.5);
  expect(L.headline.rect.x + L.headline.rect.w).toBeLessThanOrEqual(WIDTH - 4);
  expect(L.headline.rect.y).toBeGreaterThanOrEqual(L.accentPhoto.y + L.accentPhoto.h - 0.5);

  // Any video card is a real clip: 3s, muted, in the card track.
  const clips = built.project.timeline.tracks.flatMap((track) => track.clips);
  for (const card of spec.cards.filter((item) => item.type === "video")) {
    const video = clips.find((clip) => clip.mediaId === card.mediaId);
    expect(video, `${spec.id} video clip ${card.mediaId}`).toBeDefined();
    expect(video!.trackId).toBe("spread-cards");
    expect(video!.inPoint).toBe(0);
    expect(video!.outPoint).toBe(DURATION);
    expect(video!.volume).toBe(0);
  }
  expect(clips).toHaveLength(7);
  expect(built.project.textClips).toHaveLength(2);

  // Everything on canvas.
  for (const rect of [L.page, L.column, L.accentPhoto, L.avatar, L.body, ...L.cards]) {
    expect(rect.x).toBeGreaterThanOrEqual(-0.5);
    expect(rect.y).toBeGreaterThanOrEqual(-0.5);
    expect(rect.x + rect.w).toBeLessThanOrEqual(WIDTH + 0.5);
    expect(rect.y + rect.h).toBeLessThanOrEqual(HEIGHT + 0.5);
  }
}

// ---------------------------------------------------------------- test

describe.skipIf(!RUN)("B2 Curry — three-page scrapbook with live cards", () => {
  it("renders three 3s pages and concatenates them into one 9s cut", async () => {
    await rm(OUT, { recursive: true, force: true });
    await mkdir(OUT, { recursive: true });

    const compositor = new MirrorCompositor(process.env.CHROMIUM_EXECUTABLE_PATH);
    const rendered: string[] = [];
    try {
      for (const [i, spec] of SCENES.entries()) {
        const built = buildScene(spec);
        checkScene(spec, built);
        await saveProjectFile(resolve(OUT, `scene-${i + 1}-project.json`), built.project);

        const snapshot = await createMirrorSnapshot(built.project, built.mediaPaths);
        const mp4 = resolve(OUT, `scene-${i + 1}.mp4`);
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
        expect(result.framesRendered, spec.id).toBe(DURATION * FPS);
        rendered.push(mp4);

        const still = resolve(OUT, `scene-${i + 1}.png`);
        await rm(still, { force: true });
        await execFileAsync("ffmpeg", [
          "-y", "-ss", "2.9", "-i", mp4, "-frames:v", "1", still, "-loglevel", "error",
        ]);

        // Card close-ups from the exported clip prove the highlight plays.
        const videoIndex = spec.cards.findIndex((card) => card.type === "video");
        if (videoIndex >= 0) {
          const videoCard = built.layout.cards[videoIndex]!;
          const cropFilter =
            `crop=${Math.round(videoCard.w)}:${Math.round(videoCard.h)}:` +
            `${Math.round(videoCard.x)}:${Math.round(videoCard.y)},scale=240:-1`;
          for (const [j, t] of [1.0, 1.5, 2.0, 2.5, 2.9].entries()) {
            const frame = resolve(OUT, `scene-${i + 1}-video-${String(j + 1).padStart(2, "0")}.png`);
            await execFileAsync("ffmpeg", [
              "-y", "-ss", String(t), "-i", mp4, "-frames:v", "1",
              "-vf", cropFilter, frame, "-loglevel", "error",
            ]);
          }
        }

        console.log(`${spec.label}: ${result.framesRendered} frames -> ${mp4}`);
      }
    } finally {
      await compositor.close();
    }

    const list = resolve(OUT, "concat.txt");
    await writeFile(list, rendered.map((path) => `file '${path}'`).join("\n") + "\n");
    const combined = resolve(OUT, "curry-scrapbook.mp4");
    await execFileAsync("ffmpeg", [
      "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", combined, "-loglevel", "error",
    ]);
    const probe = await execFileAsync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", combined,
    ]);
    expect(Math.abs(Number(probe.stdout.trim()) - DURATION * SCENES.length), "concat duration").toBeLessThan(0.15);

    // Overview frames across the whole cut.
    for (const [i, t] of Array.from({ length: 12 }, (_, n) => 0.25 + n * 0.75).entries()) {
      await execFileAsync("ffmpeg", [
        "-y", "-ss", String(t), "-i", combined, "-frames:v", "1",
        "-vf", "scale=512:-1", resolve(OUT, `seq-${String(i + 1).padStart(2, "0")}.png`), "-loglevel", "error",
      ]);
    }

    // Page 1 must actually move, not hold a still.
    const a = resolve(OUT, "seq-01.png");
    const b = resolve(OUT, "seq-02.png");
    const ssim = await execFileAsync("ffmpeg", ["-i", a, "-i", b, "-lavfi", "ssim", "-f", "null", "-"]);
    const match = /All:([0-9.]+)/.exec(ssim.stderr);
    expect(match, "ffmpeg ssim output").toBeTruthy();
    expect(Number(match![1])).toBeLessThan(0.98);

    console.log(`curry scrapbook: ${DURATION * SCENES.length}s -> ${combined}`);
  }, 900_000);
});
