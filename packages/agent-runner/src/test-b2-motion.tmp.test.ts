/**
 * B2 MOTION — one measured entrance, played by the renderer.
 *
 * The analyzer measures the reference's horizontal band reveal at native frame
 * rate (evaluation-files/test-b/motion/dna/band-reveal.json). This test does
 * not author an entrance: it loads that measured curve and drives a card with
 * it.
 *
 * The card's visible height is the channel. Uniform scale follows the fitted
 * bezier, quantized back onto the reference's 18fps frame grid with `hold`
 * easing, so the stop-motion cadence survives a 30fps render instead of being
 * smoothed away. A second export with no card is the clean plate the analyzer
 * uses to measure the card back out of the render.
 *
 * Run:
 *   KOVE_TEST_B2_MOTION=1 pnpm --filter @kove-advanced/agent-runner test:run \
 *     src/test-b2-motion.tmp.test.ts
 */
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { cubicBezier } from "@kove-advanced/core/animation/easing-functions";
import type { MediaItem, Project } from "@kove-advanced/core/types/project";
import type { Clip, Track } from "@kove-advanced/core/types/timeline";
import { createMirrorSnapshot, MirrorCompositor } from "./mirror-compositor";
import { createEmptyProject, saveProjectFile } from "./project-io";
import { fittedCardKeyframes, loadMotionDna } from "./motion-dna";

const execFileAsync = promisify(execFile);

const WIDTH = 1024;
const HEIGHT = 576;
const FPS = 30;
const DURATION = 1.4;
const CARD_WIDTH = 384;

const CURRY = resolve("../../evaluation-files/test-b/curry");
const PAGE = resolve(CURRY, "photos/page-curry.png");
const PHOTO = resolve(CURRY, "photos/card-1.jpg");
const DNA = resolve("../../evaluation-files/test-b/motion/dna/band-reveal.json");
const OUT = resolve("../../evaluation-files/test-b/motion/out/render");
const RUN = process.env.KOVE_TEST_B2_MOTION === "1";

function media(id: string, file: string): MediaItem {
  const png = file.endsWith(".png");
  return {
    id,
    name: id,
    type: "image",
    fileHandle: null,
    blob: null,
    metadata: {
      duration: 10,
      width: png ? WIDTH : 480,
      height: png ? HEIGHT : 640,
      frameRate: 0,
      codec: png ? "png" : "jpeg",
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

function track(id: string): Track {
  return {
    id,
    type: "video",
    name: id,
    clips: [],
    transitions: [],
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
  };
}

function buildProject(withCard: boolean, scaleKeyframes: Clip["keyframes"]): Project {
  const page = track("motion-page");
  const cards = track("motion-cards");
  const contain = Math.min(WIDTH / 480, HEIGHT / 640);
  const baseScale = CARD_WIDTH / 480 / contain;

  const pageClip: Clip = {
    id: "motion-page",
    mediaId: "page",
    trackId: "motion-page",
    startTime: 0,
    duration: DURATION,
    inPoint: 0,
    outPoint: DURATION,
    effects: [],
    audioEffects: [],
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
      fitMode: "contain",
    },
    volume: 0,
    keyframes: [],
  };
  page.clips.push(pageClip);

  if (withCard) {
    const cardClip: Clip = {
      id: "motion-card",
      mediaId: "photo",
      trackId: "motion-cards",
      startTime: 0,
      duration: DURATION,
      inPoint: 0,
      outPoint: DURATION,
      effects: [],
      audioEffects: [],
      transform: {
        position: { x: 0, y: 0 },
        scale: { x: baseScale, y: baseScale },
        rotation: 0,
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
        fitMode: "contain",
      },
      volume: 0,
      keyframes: scaleKeyframes,
    };
    cards.clips.push(cardClip);
  }

  return {
    ...createEmptyProject(withCard ? "B2 Motion — card" : "B2 Motion — plate", {
      width: WIDTH,
      height: HEIGHT,
      frameRate: FPS,
    }),
    mediaLibrary: {
      items: withCard ? [media("page", PAGE), media("photo", PHOTO)] : [media("page", PAGE)],
    },
    timeline: {
      // Highest track index renders behind (the page is the backdrop), so the
      // card track must come first.
      tracks: withCard ? [cards, page] : [page],
      subtitles: [],
      duration: DURATION,
      markers: [],
    },
    textClips: [],
  };
}

async function exportProject(
  compositor: MirrorCompositor,
  project: Project,
  mediaPaths: Record<string, string>,
  mp4: string,
): Promise<void> {
  const snapshot = await createMirrorSnapshot(project, mediaPaths);
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
}

async function decodeAll(mp4: string, dir: string): Promise<number> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await execFileAsync("ffmpeg", [
    "-y", "-i", mp4, "-vsync", "0", resolve(dir, "%04d.png"), "-loglevel", "error",
  ]);
  const { stdout } = await execFileAsync("ls", [dir]);
  return stdout.trim().split("\n").filter(Boolean).length;
}

describe.skipIf(!RUN)("B2 motion — measured card entrance", () => {
  it("plays the reference band curve as a card reveal and renders a clean plate", async () => {
    const dna = await loadMotionDna(DNA);
    expect(dna.channel).toBe("visibleHeight");
    expect(dna.samples).toHaveLength(9);
    expect(dna.profile).toBe("smooth");
    expect(dna.fit.family).toBe("bezier");
    expect(dna.fit.rmse).toBeLessThan(0.05);
    // The source's first visible slit is 9/352 of the final band, not zero.
    expect(dna.from).toBeCloseTo(0.0255, 4);
    expect(dna.to).toBe(1);

    const { x1 = 0, y1 = 0, x2 = 0, y2 = 0 } = dna.fit.params;
    const ease = cubicBezier(x1, y1, x2, y2);
    const contain = Math.min(WIDTH / 480, HEIGHT / 640);
    const baseScale = CARD_WIDTH / 480 / contain;

    const keyframes = fittedCardKeyframes(dna, {
      idPrefix: "motion-card",
      baseScale,
      holdUntil: DURATION,
    });
    expect(keyframes).toHaveLength(20);
    const span = dna.durationFrames / dna.fps;
    for (const axis of ["x", "y"] as const) {
      const axisFrames = keyframes.filter((kf) => kf.property === `scale.${axis}`);
      expect(axisFrames).toHaveLength(10);
      expect(axisFrames[0]!.time).toBe(0);
      expect(axisFrames[0]!.easing).toBe("hold");
      expect(axisFrames[0]!.value).toBeCloseTo(baseScale * dna.from, 6);
      expect(axisFrames[8]!.time).toBeCloseTo(span, 6);
      expect(axisFrames[8]!.value).toBeCloseTo(baseScale, 6);
      expect(axisFrames[9]!.time).toBe(DURATION);
      expect(axisFrames[9]!.value).toBeCloseTo(baseScale, 6);
      for (let i = 1; i <= 8; i++) {
        expect(axisFrames[i]!.time).toBeGreaterThan(axisFrames[i - 1]!.time);
        expect(axisFrames[i]!.time).toBeCloseTo((i / 8) * span, 6);
        expect(axisFrames[i]!.value).toBeCloseTo(
          baseScale * (dna.from + (dna.to - dna.from) * ease(i / 8)),
          6,
        );
        expect(axisFrames[i]!.value as number).toBeGreaterThanOrEqual(
          axisFrames[i - 1]!.value as number,
        );
      }
    }

    await rm(OUT, { recursive: true, force: true });
    await mkdir(OUT, { recursive: true });

    const cardProject = buildProject(true, keyframes);
    const plateProject = buildProject(false, []);
    const cardPaths = { page: PAGE, photo: PHOTO };
    const platePaths = { page: PAGE };
    await saveProjectFile(resolve(OUT, "motion-project.json"), cardProject);
    await saveProjectFile(resolve(OUT, "motion-plate-project.json"), plateProject);

    const compositor = new MirrorCompositor(process.env.CHROMIUM_EXECUTABLE_PATH);
    try {
      const cardMp4 = resolve(OUT, "motion-test.mp4");
      const plateMp4 = resolve(OUT, "motion-plate.mp4");
      await exportProject(compositor, cardProject, cardPaths, cardMp4);
      await exportProject(compositor, plateProject, platePaths, plateMp4);

      const cardFrames = await decodeAll(cardMp4, resolve(OUT, "frames"));
      const plateFrames = await decodeAll(plateMp4, resolve(OUT, "plate"));
      expect(cardFrames).toBe(Math.round(DURATION * FPS));
      expect(plateFrames).toBe(cardFrames);

      await writeFile(
        resolve(OUT, "measure.sh"),
        [
          "#!/bin/sh",
          "# Measure the rendered card back out and compare with the reference.",
          "set -eu",
          "python=evaluation-files/test-b/motion/analyze_reference.py",
          "packages/python-engine/.venv/bin/python $python diffband \\",
          "  --dir evaluation-files/test-b/motion/out/render/frames \\",
          "  --plate evaluation-files/test-b/motion/out/render/plate/0001.png \\",
          "  --end 42 --fps 30 \\",
          "  --out evaluation-files/test-b/motion/out/render-band.json",
          "",
        ].join("\n"),
      );

      console.log(`motion card: ${cardFrames} frames -> ${cardMp4}`);
      console.log(`clean plate: ${plateFrames} frames -> ${plateMp4}`);
    } finally {
      await compositor.close();
    }
  }, 600_000);
});
