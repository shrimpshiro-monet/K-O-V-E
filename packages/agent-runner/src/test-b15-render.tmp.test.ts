/**
 * TEST B1.5 — rebuild of the 4s beat following the reference, not a layout
 * guess. Fixes the structural problems flagged in B1:
 *
 *   B1 flaw                     → B1.5 fix
 *   ----------------------------→------------------------------------------
 *   full-bleed cover layering   → page-scene helpers (createPageScene);
 *                                 photos sit in inset slots, paper visible
 *   stills everywhere           → real video (photo-1/2/3.mp4) for every clip
 *   no audio                    → synthesized hit on the cut (0.5s)
 *   double animation (preset+   → no hand-written text keyframes (and no text
 *     keyframes on text)          at all: the reference shows no text in its
 *                                 first 4 seconds)
 *   dead hold, repeated imagery → single continuous shot, matching the
 *                                 reference's structure
 *
 * Reference structure (magazine edit, motion graphics.MP4, first 4s):
 *   0.00–0.50  black
 *   ~0.50      ONE cut: the wall of panels slides in from the right
 *   0.5–4.0    one continuous camera glide across a white panel wall;
 *              next hard cut is at 6.39s (outside this beat)
 *   AAC audio present throughout
 *
 * B1.5 mirrors that: black until 0.5, then a single page scene whose every
 * layer shares one glide (position 340 → -40 px, scale 1 → 1.045, easeOutQuad),
 * paper visible in the margins, a hit sound exactly on the cut.
 *
 * Run:
 *   KOVE_TEST_B15=1 pnpm --filter @kove-advanced/agent-runner test:run src/test-b15-render.tmp.test.ts
 */
import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  applyMographPageContract,
  createPageScene,
  validateMographPageScene,
  type PageLayerSpec,
  type PageScene,
  type PageTemplateId,
} from "@kove-advanced/creation-schema";
import type { Project, MediaItem } from "@kove-advanced/core/types/project";
import type { Clip, Keyframe, Track } from "@kove-advanced/core/types/timeline";
import { createMirrorSnapshot, MirrorCompositor } from "./mirror-compositor";
import { createEmptyProject, saveProjectFile } from "./project-io";

const execFileAsync = promisify(execFile);

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;
const DURATION = 4;
const BLACK_SECONDS = 0.5;
const SCENE_START = BLACK_SECONDS;
const SCENE_DURATION = DURATION - BLACK_SECONDS;
const OUT = resolve("../../evaluation-files/test-b/b15");
const ASSETS = resolve("../../evaluation-files/mograph-p1.5/assets");
const AUDIO_DIR = resolve("../../evaluation-files/test-b/assets");
const OUTPUT = resolve(OUT, "test-b15-beat.mp4");
const HIT = resolve(AUDIO_DIR, "hit.wav");
const RUN = process.env.KOVE_TEST_B15 === "1";

interface MediaDef {
  id: string;
  name: string;
  type: "image" | "video" | "audio";
  width: number;
  height: number;
  file: string;
  duration: number;
}

const MEDIA: Record<string, MediaDef> = {
  "paper-bg": { id: "paper-bg", name: "Paper background", type: "image", width: 1080, height: 1920, duration: 10, file: resolve(ASSETS, "paper-bg.png") },
  "foot-1": { id: "foot-1", name: "Footage 1", type: "video", width: 1080, height: 630, duration: 8, file: resolve(ASSETS, "photo-1.mp4") },
  "foot-2": { id: "foot-2", name: "Footage 2", type: "video", width: 1080, height: 630, duration: 8, file: resolve(ASSETS, "photo-2.mp4") },
  "foot-3": { id: "foot-3", name: "Footage 3", type: "video", width: 1080, height: 630, duration: 8, file: resolve(ASSETS, "photo-3.mp4") },
  hit: { id: "hit", name: "Cut hit", type: "audio", width: 0, height: 0, duration: 0.4, file: HIT },
};

function mediaItem(asset: MediaDef): MediaItem {
  const isVideo = asset.type === "video";
  const isAudio = asset.type === "audio";
  return {
    id: asset.id,
    name: asset.name,
    type: asset.type,
    fileHandle: null,
    blob: null,
    metadata: {
      duration: asset.duration,
      width: asset.width,
      height: asset.height,
      frameRate: isVideo ? 30 : 0,
      codec: isVideo ? "h264" : isAudio ? "wav" : asset.file.endsWith(".png") ? "png" : "jpeg",
      sampleRate: isAudio ? 48000 : 0,
      channels: isAudio ? 2 : 0,
      fileSize: 1,
      hasVideo: !isAudio,
      hasAudio: isAudio,
      audioTrackCount: isAudio ? 1 : 0,
    },
    thumbnailUrl: null,
    waveformData: null,
  };
}

function track(id: string, type: Track["type"], name: string): Track {
  return { id, type, name, clips: [], transitions: [], locked: false, hidden: false, muted: false, solo: false };
}

function kf(id: string, time: number, property: string, value: unknown, easing: Keyframe["easing"]): Keyframe {
  return { id, time, property, value, easing };
}

/**
 * One shared camera glide for every layer (the reference's wall moves as a
 * single camera, not as per-element idle motion): slide in from the right,
 * settle past center, keep drifting, slight push-in. easeOutQuad gives the
 * fast entry at the cut and the slow settle of a dolly.
 */
function glideKeyframes(id: string, duration: number): Keyframe[] {
  return [
    kf(`${id}-x0`, 0, "position.x", 340, "easeOutQuad"),
    kf(`${id}-x1`, duration, "position.x", -40, "linear"),
    kf(`${id}-sx0`, 0, "scale.x", 1, "easeOutQuad"),
    kf(`${id}-sx1`, duration, "scale.x", 1.045, "linear"),
    kf(`${id}-sy0`, 0, "scale.y", 1, "easeOutQuad"),
    kf(`${id}-sy1`, duration, "scale.y", 1.045, "linear"),
  ];
}

function slotClip(id: string, mediaId: string, trackId: string, scene: PageScene, layer: PageLayerSpec, inPoint: number): Clip {
  const centerX = (layer.rect.x + layer.rect.width / 2 - 0.5) * WIDTH;
  const centerY = (layer.rect.y + layer.rect.height / 2 - 0.5) * HEIGHT;
  const isBackground = layer.role === "background";
  return {
    id,
    mediaId,
    trackId,
    startTime: scene.startTime,
    duration: scene.durationSeconds,
    inPoint,
    outPoint: inPoint + scene.durationSeconds,
    // Texture lives on the paper layer only; the footage stays clean (B1
    // put stock glitch filters on the video itself).
    effects: isBackground
      ? [
          { id: "fx-grain", type: "grain", params: { amount: 45, size: 2 }, enabled: true },
          { id: "fx-vignette", type: "vignette", params: { amount: 55 }, enabled: true },
        ]
      : [],
    audioEffects: [],
    transform: {
      position: { x: centerX, y: centerY },
      scale: { x: 1, y: 1 },
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
      borderRadius: layer.borderRadius,
      fitMode: "contain",
    },
    volume: 0,
    keyframes: glideKeyframes(id, scene.durationSeconds),
  };
}

/** Distinct source moments so the three bands never show the same frame. */
const SLOT_MEDIA: Record<string, { mediaId: string; inPoint: number }> = {
  "photo-1": { mediaId: "foot-1", inPoint: 1.0 },
  "photo-2": { mediaId: "foot-2", inPoint: 3.2 },
  "photo-3": { mediaId: "foot-3", inPoint: 5.4 },
};

function buildScene(): PageScene {
  const scene = applyMographPageContract(
    createPageScene("headline-column-3up" as PageTemplateId, {
      id: "glide-01",
      startTime: SCENE_START,
      durationSeconds: SCENE_DURATION,
      motionScale: 1,
    }),
  );
  expect(validateMographPageScene(scene)).toEqual([]);
  return scene;
}

function buildProject(scene: PageScene): Project {
  const base = createEmptyProject("Test B1.5 — reference-mirrored beat", {
    width: WIDTH,
    height: HEIGHT,
    frameRate: FPS,
  });

  // Track order is TOP-FIRST: background must be LAST so it paints underneath.
  const tracks: Track[] = [
    track("track-audio", "audio", "Hits"),
    track("track-photo-3", "video", "Band 3"),
    track("track-photo-2", "video", "Band 2"),
    track("track-photo-1", "video", "Band 1"),
    track("track-bg", "video", "Paper background"),
  ];
  const byId = new Map(tracks.map((item) => [item.id, item]));

  for (const layer of scene.layers) {
    if (layer.role === "background") {
      byId.get("track-bg")!.clips.push(slotClip("bg-paper", "paper-bg", "track-bg", scene, layer, 0));
    } else if (layer.role === "photo") {
      const slot = SLOT_MEDIA[layer.id];
      expect(slot).toBeDefined();
      const trackId = `track-${layer.id}`;
      byId.get(trackId)!.clips.push(slotClip(`band-${layer.id}`, slot!.mediaId, trackId, scene, layer, slot!.inPoint));
    }
    // headline/body layers: intentionally emit no TextClip — the reference
    // has no text in its first 4 seconds, so B1.5 matches that.
  }

  // One hit, exactly on the cut at 0.5s.
  byId.get("track-audio")!.clips.push({
    id: "hit-cut",
    mediaId: "hit",
    trackId: "track-audio",
    startTime: BLACK_SECONDS,
    duration: MEDIA.hit!.duration,
    inPoint: 0,
    outPoint: MEDIA.hit!.duration,
    effects: [],
    audioEffects: [],
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    },
    volume: 1,
    keyframes: [],
  });

  return {
    ...base,
    mediaLibrary: { items: Object.values(MEDIA).map(mediaItem) },
    timeline: { tracks, subtitles: [], duration: DURATION, markers: [] },
  };
}

describe.skipIf(!RUN)("Test B1.5 — reference-mirrored 4s beat", () => {
  it("renders black→cut→single glide with a hit on the cut", async () => {
    const scene = buildScene();
    const project = buildProject(scene);
    await mkdir(OUT, { recursive: true });
    await saveProjectFile(resolve(OUT, "test-b15-project.json"), project);

    const mediaPaths = Object.fromEntries(Object.values(MEDIA).map((asset) => [asset.id, asset.file]));
    const snapshot = await createMirrorSnapshot(project, mediaPaths);
    const compositor = new MirrorCompositor(process.env.CHROMIUM_EXECUTABLE_PATH);
    try {
      await rm(OUTPUT, { force: true });
      const result = await compositor.exportVideo(snapshot, OUTPUT, {
        format: "mp4",
        codec: "h264",
        width: WIDTH,
        height: HEIGHT,
        frameRate: FPS,
        bitrate: 10_000,
        bitrateMode: "vbr",
        quality: 90,
        keyframeInterval: 60,
        audioSettings: {
          format: "aac",
          sampleRate: 48000,
          bitDepth: 16,
          bitrate: 128,
          channels: 2,
        },
      });
      expect(result.framesRendered).toBe(DURATION * FPS);
      console.log(`B1.5 render: ${OUTPUT} (${result.framesRendered} frames)`);
    } finally {
      await compositor.close();
    }

    // The render must actually carry the hit — assert an audio stream exists.
    const streams = await execFileAsync("ffprobe", [
      "-v", "error", "-select_streams", "a",
      "-show_entries", "stream=codec_name",
      "-of", "csv=p=0", OUTPUT,
    ]);
    console.log(`B1.5 audio streams: ${streams.stdout.trim() || "(none)"}`);
    expect(streams.stdout.trim()).toContain("aac");

    // Same contact sheet timestamps as B1 and the reference (t=0…3.5, step 0.5).
    const frames = resolve(OUT, "frames");
    await rm(frames, { recursive: true, force: true });
    await mkdir(frames, { recursive: true });
    await execFileAsync("ffmpeg", ["-y", "-i", OUTPUT, "-vf", "fps=2,scale=540:-1", resolve(frames, "f-%02d.jpg")]);

    // Frame strip around the cut (0.40–0.80s, every frame) — cut feel lives here.
    const strip = resolve(OUT, "cut-strip");
    await mkdir(strip, { recursive: true });
    await execFileAsync("ffmpeg", ["-y", "-ss", "0.4", "-t", "0.4", "-i", OUTPUT, "-vf", "fps=30,scale=270:-1", resolve(strip, "c-%02d.jpg")]);

    // Matching reference strip (18fps source).
    const refStrip = resolve(OUT, "cut-strip-ref");
    await mkdir(refStrip, { recursive: true });
    await execFileAsync("ffmpeg", [
      "-y", "-ss", "0.4", "-t", "0.4",
      "-i", resolve("../../reference_videos_to_select/magazine edit, motion graphics.MP4"),
      "-vf", "fps=18,scale=270:-1", resolve(refStrip, "c-%02d.jpg"),
    ]);
    console.log(`B1.5 strips: ${strip} vs ${refStrip}`);
  }, 600_000);
});
