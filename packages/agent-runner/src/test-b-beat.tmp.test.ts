/**
 * TEST B — "Human Oracle" beat test (see: kove output diagnosis).
 *
 * Hand-build ONE 4-second magazine-style beat using ONLY the existing
 * renderer vocabulary (effects, keyframes/easings, text presets,
 * transitions) and no AI at all. Then render it headless.
 *
 * Interpretation:
 *   - Beat looks close to the magazine reference by eye → the renderer can
 *     express the look; the bottleneck is extraction/generation (Causes B/C).
 *   - Beat cannot be made to look right even by hand → the renderer or its
 *     primitive/asset vocabulary is the bottleneck (Causes A'/D).
 *
 * Beat structure (4.0s, 1080x1920, 30fps):
 *   0.00–1.60  hook: paper bg + footage push-in, headline slam (no hard cuts)
 *   1.60–2.20  hard cut + punch-in (easeOutCubic)
 *   2.20–2.50  cut burst A (jitter + chromatic aberration)
 *   2.50–2.80  cut burst B (jitter + motion blur)
 *   2.75–4.00  flash transition into a static hold (avatar + headline)
 *
 * Run:
 *   KOVE_TEST_B=1 pnpm --filter @kove-advanced/agent-runner test:run src/test-b-beat.tmp.test.ts
 */
import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createDefaultAnimation } from "@kove-advanced/core/text/text-animation-presets";
import type { TextClip, TextStyle } from "@kove-advanced/core/text/types";
import type { Project, MediaItem } from "@kove-advanced/core/types/project";
import type { Clip, EasingType, Keyframe, Track, Transition } from "@kove-advanced/core/types/timeline";
import { createMirrorSnapshot, MirrorCompositor } from "./mirror-compositor";
import { createEmptyProject, saveProjectFile } from "./project-io";

const execFileAsync = promisify(execFile);

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;
const DURATION = 4;
const OUT = resolve("../../evaluation-files/test-b");
const ASSETS = resolve("../../evaluation-files/mograph-p1.5/assets");
const OUTPUT = resolve(OUT, "test-b-beat.mp4");
const RUN_TEST_B = process.env.KOVE_TEST_B === "1";

interface MediaDef {
  id: string;
  name: string;
  type: "image" | "video";
  width: number;
  height: number;
  file: string;
  duration: number;
}

const MEDIA: Record<string, MediaDef> = {
  "paper-bg": { id: "paper-bg", name: "Paper background", type: "image", width: 1080, height: 1920, duration: 10, file: resolve(ASSETS, "paper-bg.png") },
  "photo-1": { id: "photo-1", name: "Photo 1 still", type: "image", width: 1080, height: 630, duration: 10, file: resolve(ASSETS, "photo-1.jpg") },
  "photo-2": { id: "photo-2", name: "Photo 2 still", type: "image", width: 1080, height: 630, duration: 10, file: resolve(ASSETS, "photo-2.jpg") },
  "photo-3": { id: "photo-3", name: "Photo 3 still", type: "image", width: 1080, height: 630, duration: 10, file: resolve(ASSETS, "photo-3.jpg") },
  "photo-1-video": { id: "photo-1-video", name: "Photo 1 footage", type: "video", width: 1080, height: 630, duration: 8, file: resolve(ASSETS, "photo-1.mp4") },
  avatar: { id: "avatar", name: "Avatar", type: "image", width: 240, height: 240, duration: 10, file: resolve(ASSETS, "avatar.jpg") },
};

function mediaItem(asset: MediaDef): MediaItem {
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
      frameRate: asset.type === "video" ? 30 : 0,
      codec: asset.type === "video" ? "h264" : asset.file.endsWith(".png") ? "png" : "jpeg",
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

function track(id: string, type: Track["type"], name: string): Track {
  return { id, type, name, clips: [], transitions: [], locked: false, hidden: false, muted: false, solo: false };
}

function kf(id: string, time: number, property: string, value: unknown, easing: EasingType): Keyframe {
  return { id, time, property, value, easing };
}

/** Identity transform positioned at a pixel offset from canvas center. */
function transform(x: number, y: number, scale = 1): Clip["transform"] {
  return {
    position: { x, y },
    scale: { x: scale, y: scale },
    rotation: 0,
    anchor: { x: 0.5, y: 0.5 },
    opacity: 1,
    fitMode: "cover",
  };
}

interface PhotoSegment {
  id: string;
  mediaId: string;
  start: number;
  duration: number;
  inPoint: number;
  keyframes?: Keyframe[];
  effects?: Clip["effects"];
}

function photoClip(trackId: string, segment: PhotoSegment): Clip {
  return {
    id: segment.id,
    mediaId: segment.mediaId,
    trackId,
    startTime: segment.start,
    duration: segment.duration,
    inPoint: segment.inPoint,
    outPoint: segment.inPoint + segment.duration,
    effects: segment.effects ?? [],
    audioEffects: [],
    transform: transform(0, 0),
    volume: 0,
    keyframes: segment.keyframes ?? [],
  };
}

/** Magazine-style headline slam: overshoot in, settle, slow drift. */
function slamKeyframes(id: string, duration: number, baseY: number, slamScale: number, slamSeconds: number): Keyframe[] {
  const settle = Math.min(slamSeconds, duration * 0.6);
  return [
    kf(`${id}-sx0`, 0, "scale.x", slamScale, "easeOutBack"),
    kf(`${id}-sx1`, settle, "scale.x", 1, "easeOutCubic"),
    kf(`${id}-sx2`, duration, "scale.x", 1.02, "linear"),
    kf(`${id}-sy0`, 0, "scale.y", slamScale, "easeOutBack"),
    kf(`${id}-sy1`, settle, "scale.y", 1, "easeOutCubic"),
    kf(`${id}-sy2`, duration, "scale.y", 1.02, "linear"),
    kf(`${id}-py0`, 0, "position.y", baseY + 0.02, "easeOutBack"),
    kf(`${id}-py1`, settle, "position.y", baseY, "easeOutCubic"),
    kf(`${id}-py2`, duration, "position.y", baseY - 0.005, "linear"),
  ];
}

function textStyle(role: "headline" | "body"): TextStyle {
  const headline = role === "headline";
  return {
    fontFamily: "Arial",
    fontSize: headline ? 96 : 44,
    fontWeight: 900,
    fontStyle: "normal",
    color: "#15110d",
    backgroundColor: headline ? "rgba(247,240,227,0.92)" : "rgba(247,240,227,0.85)",
    strokeColor: "#f7f0e3",
    strokeWidth: headline ? 2 : 1,
    textAlign: "center",
    verticalAlign: "middle",
    lineHeight: headline ? 0.93 : 1.18,
    letterSpacing: headline ? -1 : 1.5,
  };
}

function textClip(
  id: string,
  trackId: string,
  spec: {
    text: string;
    role: "headline" | "body";
    start: number;
    duration: number;
    baseY: number;
    slam?: { scale: number; settle: number };
    drift?: { dx: number; dy: number; scale: number };
  },
): TextClip {
  const baseX = 0.5;
  const preset = spec.role === "headline" ? "stacked-slam" : "scatter-settle";
  const animation = createDefaultAnimation(preset);
  const keyframes = spec.slam
    ? slamKeyframes(id, spec.duration, spec.baseY, spec.slam.scale, spec.slam.settle)
    : spec.drift
      ? [
          kf(`${id}-px0`, 0, "position.x", baseX, "easeInOutSine"),
          kf(`${id}-px1`, spec.duration, "position.x", baseX + spec.drift.dx, "linear"),
          kf(`${id}-py0`, 0, "position.y", spec.baseY, "easeInOutSine"),
          kf(`${id}-py1`, spec.duration, "position.y", spec.baseY + spec.drift.dy, "linear"),
          kf(`${id}-sx0`, 0, "scale.x", 1, "easeInOutSine"),
          kf(`${id}-sx1`, spec.duration, "scale.x", spec.drift.scale, "linear"),
          kf(`${id}-sy0`, 0, "scale.y", 1, "easeInOutSine"),
          kf(`${id}-sy1`, spec.duration, "scale.y", spec.drift.scale, "linear"),
        ]
      : [];
  return {
    id,
    trackId,
    startTime: spec.start,
    duration: spec.duration,
    text: spec.text,
    style: textStyle(spec.role),
    transform: {
      position: { x: baseX, y: spec.baseY },
      scale: { x: 1, y: 1 },
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    },
    animation: {
      ...animation,
      inDuration: Math.min(0.3, spec.duration * 0.5),
      outDuration: Math.min(0.12, spec.duration * 0.2),
      stagger: Math.min(animation.stagger ?? 0.04, 0.045),
    },
    keyframes,
  };
}

function buildProject(): Project {
  const base = createEmptyProject("Test B — hand-built beat", {
    width: WIDTH,
    height: HEIGHT,
    frameRate: FPS,
  });

  const tracks: Track[] = [
    track("track-body", "text", "Body"),
    track("track-headline", "text", "Headline"),
    track("track-avatar", "video", "Avatar"),
    track("track-photo", "video", "Photo"),
    track("track-bg", "video", "Paper background"),
  ];
  const byId = new Map(tracks.map((item) => [item.id, item]));

  // Background: paper texture with grain + vignette, continuous slow push.
  const bg: Clip = {
    id: "bg-paper",
    mediaId: "paper-bg",
    trackId: "track-bg",
    startTime: 0,
    duration: DURATION,
    inPoint: 0,
    outPoint: DURATION,
    effects: [
      { id: "fx-grain", type: "grain", params: { amount: 60, size: 2 }, enabled: true },
      { id: "fx-vignette", type: "vignette", params: { amount: 70 }, enabled: true },
    ],
    audioEffects: [],
    transform: transform(0, 0),
    volume: 0,
    keyframes: [
      kf("bg-sx0", 0, "scale.x", 1, "easeInOutSine"),
      kf("bg-sx1", DURATION, "scale.x", 1.03, "linear"),
      kf("bg-sy0", 0, "scale.y", 1, "easeInOutSine"),
      kf("bg-sy1", DURATION, "scale.y", 1.03, "linear"),
    ],
  };

  // Photo segments: hook push-in → punch-in → burst A → burst B → hold.
  const photos: Clip[] = [
    photoClip("track-photo", {
      id: "photo-hook",
      mediaId: "photo-1-video",
      start: 0,
      duration: 1.6,
      inPoint: 0.5,
      keyframes: [
        kf("ph-sx0", 0, "scale.x", 1, "easeInOutSine"),
        kf("ph-sx1", 1.6, "scale.x", 1.045, "linear"),
        kf("ph-sy0", 0, "scale.y", 1, "easeInOutSine"),
        kf("ph-sy1", 1.6, "scale.y", 1.045, "linear"),
        kf("ph-py0", 0, "position.y", 0, "easeInOutSine"),
        kf("ph-py1", 1.6, "position.y", -10, "linear"),
      ],
      effects: [{ id: "fx-bright", type: "brightness", params: { value: 10, amount: 10 }, enabled: true }],
    }),
    photoClip("track-photo", {
      id: "photo-punch",
      mediaId: "photo-2",
      start: 1.6,
      duration: 0.6,
      inPoint: 0,
      keyframes: [
        kf("pu-sx0", 0, "scale.x", 1, "easeOutCubic"),
        kf("pu-sx1", 0.6, "scale.x", 1.09, "linear"),
        kf("pu-sy0", 0, "scale.y", 1, "easeOutCubic"),
        kf("pu-sy1", 0.6, "scale.y", 1.09, "linear"),
        kf("pu-r0", 0, "rotation", 0, "easeOutCubic"),
        kf("pu-r1", 0.6, "rotation", -0.6, "linear"),
      ],
    }),
    photoClip("track-photo", {
      id: "photo-burst-a",
      mediaId: "photo-3",
      start: 2.2,
      duration: 0.3,
      inPoint: 0,
      keyframes: [
        kf("ba-r0", 0, "rotation", 0, "linear"),
        kf("ba-r1", 0.1, "rotation", 1.1, "linear"),
        kf("ba-r2", 0.2, "rotation", -0.8, "linear"),
        kf("ba-r3", 0.3, "rotation", 0.3, "linear"),
        kf("ba-sx0", 0, "scale.x", 1.06, "linear"),
        kf("ba-sx1", 0.3, "scale.x", 1.1, "linear"),
        kf("ba-sy0", 0, "scale.y", 1.06, "linear"),
        kf("ba-sy1", 0.3, "scale.y", 1.1, "linear"),
      ],
      effects: [{ id: "fx-ca", type: "chromatic-aberration", params: { amount: 14 }, enabled: true }],
    }),
    photoClip("track-photo", {
      id: "photo-burst-b",
      mediaId: "photo-1",
      start: 2.5,
      duration: 0.3,
      inPoint: 0,
      keyframes: [
        kf("bb-r0", 0, "rotation", 0, "linear"),
        kf("bb-r1", 0.1, "rotation", -1.2, "linear"),
        kf("bb-r2", 0.2, "rotation", 0.9, "linear"),
        kf("bb-r3", 0.3, "rotation", -0.3, "linear"),
        kf("bb-sx0", 0, "scale.x", 1.09, "linear"),
        kf("bb-sx1", 0.3, "scale.x", 1.02, "linear"),
        kf("bb-sy0", 0, "scale.y", 1.09, "linear"),
        kf("bb-sy1", 0.3, "scale.y", 1.02, "linear"),
      ],
      effects: [{ id: "fx-mb", type: "motion-blur", params: { distance: 8, angle: 45, amount: 8 }, enabled: true }],
    }),
    photoClip("track-photo", {
      id: "photo-hold",
      mediaId: "photo-2",
      start: 2.75,
      duration: 1.25,
      inPoint: 0.6,
      // Hold = deliberately static (mograph hold rule): no keyframes.
    }),
  ];

  // Avatar appears only in the hold.
  const avatar: Clip = {
    id: "avatar-hold",
    mediaId: "avatar",
    trackId: "track-avatar",
    startTime: 2.8,
    duration: 1.2,
    inPoint: 0,
    outPoint: 1.2,
    effects: [{ id: "fx-avatar-shadow", type: "shadow", params: { offsetX: 8, offsetY: 8, blur: 12, color: "#000000", opacity: 0.5 }, enabled: true }],
    audioEffects: [],
    transform: { ...transform(0, 300, 0.3) },
    volume: 0,
    keyframes: [],
  };

  // One rendered transition: flash from burst B into the hold.
  const flash: Transition = {
    id: "tr-flash-hold",
    clipAId: "photo-burst-b",
    clipBId: "photo-hold",
    type: "flash",
    duration: 0.1,
    params: { duration: 0.1, curve: "linear", direction: "left", softness: 0.5, holdDuration: 0 },
  };
  byId.get("track-bg")!.clips.push(bg);
  byId.get("track-avatar")!.clips.push(avatar);
  const photoTrack = byId.get("track-photo")!;
  photoTrack.clips.push(...photos);
  photoTrack.transitions.push(flash);

  const headlines: TextClip[] = [
    textClip("h1", "track-headline", { text: "56\nPOINTS", role: "headline", start: 0, duration: 1.6, baseY: 0.34, slam: { scale: 1.24, settle: 0.24 } }),
    textClip("h2", "track-headline", { text: "FEB 27\n2025", role: "headline", start: 1.6, duration: 0.6, baseY: 0.34, slam: { scale: 1.2, settle: 0.16 } }),
    textClip("h3", "track-headline", { text: "56", role: "headline", start: 2.2, duration: 0.3, baseY: 0.34, slam: { scale: 1.35, settle: 0.1 } }),
    textClip("h4", "track-headline", { text: "PTS", role: "headline", start: 2.5, duration: 0.3, baseY: 0.34, slam: { scale: 1.35, settle: 0.1 } }),
    // Hold headline: static, no slam.
    textClip("h5", "track-headline", { text: "NIGHT 56", role: "headline", start: 2.8, duration: 1.2, baseY: 0.34 }),
  ];
  const bodies: TextClip[] = [
    textClip("b1", "track-body", {
      text: "MAGAZINE / TEST B",
      role: "body",
      start: 0,
      duration: 1.6,
      baseY: 0.76,
      drift: { dx: 0.01, dy: -0.006, scale: 1.03 },
    }),
    textClip("b2", "track-body", { text: "ORLANDO / FL", role: "body", start: 2.8, duration: 1.2, baseY: 0.76 }),
  ];

  return {
    ...base,
    mediaLibrary: { items: Object.values(MEDIA).map(mediaItem) },
    timeline: { tracks, subtitles: [], duration: DURATION, markers: [] },
    textClips: [...headlines, ...bodies],
  };
}

describe.skipIf(!RUN_TEST_B)("Test B — hand-built 4s magazine beat", () => {
  it("renders the beat to mp4 with frame contact sheet", async () => {
    const project = buildProject();
    expect(project.textClips?.length).toBeGreaterThan(0);

    await mkdir(OUT, { recursive: true });
    await saveProjectFile(resolve(OUT, "test-b-beat-project.json"), project);

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
      console.log(`Test B render: ${OUTPUT} (${result.framesRendered} frames)`);
    } finally {
      await compositor.close();
    }

    // Contact sheet: 8 frames for the eye test (the nine mograph thresholds
    // are tuned for 18-28s edits and do not apply to a 4s beat).
    const frames = resolve(OUT, "frames");
    await rm(frames, { recursive: true, force: true });
    await mkdir(frames, { recursive: true });
    await execFileAsync("ffmpeg", ["-y", "-i", OUTPUT, "-vf", "fps=2,scale=540:-1", resolve(frames, "f-%02d.jpg")]);
    console.log(`Test B frames: ${frames} (f-01.jpg … f-08.jpg) — compare side-by-side with the magazine reference`);
  }, 600_000);
});
