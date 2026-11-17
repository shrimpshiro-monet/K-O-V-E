import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyMographPageContract,
  createPageScene,
  getPageTemplate,
  pageSceneTimelineLayers,
  validateMographPageScene,
  type PageLayerSpec,
  type PageScene,
  type PageTemplateId,
} from "@kove-advanced/creation-schema";
import { createDefaultAnimation } from "@kove-advanced/core/text/text-animation-presets";
import type { TextClip, TextStyle } from "@kove-advanced/core/text/types";
import type { Project, MediaItem } from "@kove-advanced/core/types/project";
import type { Clip, Keyframe, Track } from "@kove-advanced/core/types/timeline";
import { createMirrorSnapshot, MirrorCompositor } from "./mirror-compositor";
import { createEmptyProject, saveProjectFile } from "./project-io";

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;
const DURATION = 28;
const OUT = resolve("../../evaluation-files/mograph-p1.5");
const ASSETS = resolve(OUT, "assets");
const OUTPUT = resolve(OUT, "curry56-magazine-p1.5.mp4");
const RUN_P15 = process.env.KOVE_P15_RENDER === "1";

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
  "photo-1": { id: "photo-1", name: "Curry photo 1 still", type: "image", width: 1080, height: 630, duration: 10, file: resolve(ASSETS, "photo-1.jpg") },
  "photo-2": { id: "photo-2", name: "Curry photo 2 still", type: "image", width: 1080, height: 630, duration: 10, file: resolve(ASSETS, "photo-2.jpg") },
  "photo-3": { id: "photo-3", name: "Curry photo 3 still", type: "image", width: 1080, height: 630, duration: 10, file: resolve(ASSETS, "photo-3.jpg") },
  "photo-1-video": { id: "photo-1-video", name: "Curry photo 1 footage", type: "video", width: 1080, height: 630, duration: 8, file: resolve(ASSETS, "photo-1.mp4") },
  "photo-2-video": { id: "photo-2-video", name: "Curry photo 2 footage", type: "video", width: 1080, height: 630, duration: 8, file: resolve(ASSETS, "photo-2.mp4") },
  "photo-3-video": { id: "photo-3-video", name: "Curry photo 3 footage", type: "video", width: 1080, height: 630, duration: 8, file: resolve(ASSETS, "photo-3.mp4") },
  avatar: { id: "avatar", name: "Curry avatar", type: "image", width: 240, height: 240, duration: 10, file: resolve(ASSETS, "avatar.jpg") },
};

const HEADLINES = ["STEPH\nCURRY", "56\nPOINTS", "NIGHT\n56", "ORLANDO\nMAGIC", "WARDEN\n30", "SPLASH\nCURRY", "BUCKETS\nONLY", "CURRY\nTIME"];
const BODIES = ["56 POINTS / ORLANDO", "FEB 27 / 2025", "GOLDEN STATE / 30", "NIGHT NIGHT / 56", "THE WARDEN / 30", "ORLANDO / FL", "CURRY / 56", "K.O.V.E. / EDIT"];
const AVATAR_BODIES = ["NIGHT 56\nORLANDO", "56 POINTS\nFEB 27", "STEPH CURRY\n30", "ORLANDO\nFLORIDA", "GOLDEN STATE\n30", "THE WARDEN\n56", "CURRY\nTIME", "K.O.V.E.\nEDIT"];

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

function motionKeyframes(
  clipId: string,
  baseX: number,
  baseY: number,
  layer: PageLayerSpec,
  duration: number,
  energy: number,
): Keyframe[] {
  const move = layer.motion[0]?.move ?? "slow-push";
  const fullBleed = layer.rect.width >= 0.9;
  const scaleEnd = fullBleed ? 1.012 : move === "punch-in" ? 1.09 : move === "slow-push" ? 1.04 : move === "breathe" ? 1.03 : 1.035;
  const dx = fullBleed ? 4 : move === "drift-left" ? -18 : move === "drift-right" ? 18 : 0;
  const dy = fullBleed ? 3 : move === "breathe" ? 7 : move === "punch-in" ? -9 : -5;
  const rotationEnd = fullBleed ? 0.15 : move === "drift-left" ? -1.1 : move === "drift-right" ? 1.1 : 0.6;
  const t = Math.max(0.1, duration);
  return [
    { id: `${clipId}-x0`, time: 0, property: "position.x", value: baseX, easing: "easeInOutSine" },
    { id: `${clipId}-x1`, time: t, property: "position.x", value: baseX + dx * energy, easing: "linear" },
    { id: `${clipId}-y0`, time: 0, property: "position.y", value: baseY, easing: "easeInOutSine" },
    { id: `${clipId}-y1`, time: t, property: "position.y", value: baseY + dy * energy, easing: "linear" },
    { id: `${clipId}-sx0`, time: 0, property: "scale.x", value: 1, easing: "easeInOutSine" },
    { id: `${clipId}-sx1`, time: t, property: "scale.x", value: scaleEnd, easing: "linear" },
    { id: `${clipId}-sy0`, time: 0, property: "scale.y", value: 1, easing: "easeInOutSine" },
    { id: `${clipId}-sy1`, time: t, property: "scale.y", value: scaleEnd, easing: "linear" },
    { id: `${clipId}-r0`, time: 0, property: "rotation", value: 0, easing: "easeInOutSine" },
    { id: `${clipId}-r1`, time: t, property: "rotation", value: rotationEnd * energy, easing: "linear" },
  ];
}

function imageClip(
  id: string,
  mediaId: string,
  trackId: string,
  scene: PageScene,
  layer: PageLayerSpec,
  energy: number,
  inPoint: number,
): Clip {
  const centerX = (layer.rect.x + layer.rect.width / 2 - 0.5) * WIDTH;
  const centerY = (layer.rect.y + layer.rect.height / 2 - 0.5) * HEIGHT;
  return {
    id,
    mediaId,
    trackId,
    startTime: scene.startTime,
    duration: scene.durationSeconds,
    inPoint,
    outPoint: inPoint + scene.durationSeconds,
    effects: [],
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
    keyframes: scene.hold ? [] : motionKeyframes(id, centerX, centerY, layer, scene.durationSeconds, energy),
  };
}

function textStyle(role: "headline" | "body", avatarTemplate: boolean): TextStyle {
  const headline = role === "headline";
  return {
    fontFamily: "Arial",
    fontSize: headline ? 86 : avatarTemplate ? 54 : 44,
    fontWeight: 900,
    fontStyle: "normal",
    color: "#15110d",
    backgroundColor: "rgba(247,240,227,0.92)",
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
  scene: PageScene,
  layer: PageLayerSpec,
  templateId: PageTemplateId,
  energy: number,
): TextClip {
  const baseX = layer.rect.x + layer.rect.width / 2;
  const baseY = layer.rect.y + layer.rect.height / 2;
  const move = layer.motion[0]?.move ?? "slow-push";
  const dx = move === "drift-left" ? -0.007 : move === "drift-right" ? 0.007 : 0;
  const dy = move === "breathe" ? 0.004 : -0.003;
  const animated = !scene.hold;
  const preset = layer.textPreset ?? "scatter-settle";
  const animation = createDefaultAnimation(preset);
  const keyframes: Keyframe[] = animated
    ? [
        { id: `${id}-x0`, time: 0, property: "position.x", value: baseX, easing: "easeInOutSine" },
        { id: `${id}-x1`, time: scene.durationSeconds, property: "position.x", value: baseX + dx * energy, easing: "linear" },
        { id: `${id}-y0`, time: 0, property: "position.y", value: baseY, easing: "easeInOutSine" },
        { id: `${id}-y1`, time: scene.durationSeconds, property: "position.y", value: baseY + dy * energy, easing: "linear" },
        { id: `${id}-sx0`, time: 0, property: "scale.x", value: 1, easing: "easeInOutSine" },
        { id: `${id}-sx1`, time: scene.durationSeconds, property: "scale.x", value: 1.02, easing: "linear" },
        { id: `${id}-sy0`, time: 0, property: "scale.y", value: 1, easing: "easeInOutSine" },
        { id: `${id}-sy1`, time: scene.durationSeconds, property: "scale.y", value: 1.02, easing: "linear" },
      ]
    : [];
  return {
    id,
    trackId,
    startTime: scene.startTime,
    duration: scene.durationSeconds,
    text: layer.text ?? "",
    style: textStyle(layer.role === "headline" ? "headline" : "body", templateId === "avatar-body-3up"),
    transform: {
      position: { x: baseX, y: baseY },
      scale: { x: 1, y: 1 },
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    },
    animation: animated
      ? {
          ...animation,
          inDuration: Math.min(0.9, scene.durationSeconds * 0.7),
          outDuration: Math.min(0.3, scene.durationSeconds * 0.3),
          stagger: Math.min(animation.stagger ?? 0.04, 0.045),
        }
      : undefined,
    keyframes,
  };
}

function buildScenes(): PageScene[] {
  const scenes: PageScene[] = [];
  let time = 0;
  const add = (templateId: PageTemplateId, duration: number, options: { text?: Record<string, string>; hold?: boolean; energy?: number }) => {
    const scene = applyMographPageContract(
      createPageScene(templateId, {
        id: `page-${scenes.length.toString().padStart(2, "0")}`,
        startTime: time,
        durationSeconds: duration,
        hold: options.hold,
        text: options.text,
        motionScale: options.energy ?? 1,
      }),
    );
    expect(validateMographPageScene(scene)).toEqual([]);
    scenes.push(scene);
    time += duration;
  };

  add("headline-column-3up", 6.5, {
    text: { headline: "STEPH\nCURRY", body: "56 POINTS / ORLANDO" },
    energy: 1.45,
  });
  add("headline-column-3up", 1.35, {
    text: { headline: "FEB 27\n2025", body: "ORLANDO / FL" },
    energy: 1.1,
  });
  for (let index = 0; index < 33; index += 1) {
    const avatar = index % 2 === 0;
    add(avatar ? "avatar-body-3up" : "headline-column-3up", 0.4, {
      text: avatar ? { body: AVATAR_BODIES[index % AVATAR_BODIES.length]! } : { headline: HEADLINES[index % HEADLINES.length]!, body: BODIES[index % BODIES.length]! },
      energy: 0.95,
    });
  }
  add("avatar-body-3up", 2.5, { text: { body: "NIGHT 56\nORLANDO" }, hold: true, energy: 0 });
  for (let index = 0; index < 8; index += 1) {
    const avatar = index % 2 === 0;
    add(avatar ? "avatar-body-3up" : "headline-column-3up", 0.55625, {
      text: avatar ? { body: AVATAR_BODIES[index % AVATAR_BODIES.length]! } : { headline: HEADLINES[index % HEADLINES.length]!, body: BODIES[index % BODIES.length]! },
      energy: 0.95,
    });
  }
  expect(time).toBeCloseTo(DURATION);
  return scenes;
}

function buildProject(scenes: PageScene[]): Project {
  const base = createEmptyProject("Curry 56 — Mograph P1.5", {
    width: WIDTH,
    height: HEIGHT,
    frameRate: FPS,
  });
  const tracks: Track[] = [
    track("track-body", "text", "Body"),
    track("track-headline", "text", "Headline"),
    track("track-avatar", "video", "Avatar"),
    track("track-photo-3", "video", "Photo 3"),
    track("track-photo-2", "video", "Photo 2"),
    track("track-photo-1", "video", "Photo 1"),
    track("track-bg", "video", "Paper background"),
  ];
  const byId = new Map(tracks.map((item) => [item.id, item]));
  const clips: Clip[] = [];
  const textClips: TextClip[] = [];

  for (const [sceneIndex, scene] of scenes.entries()) {
    const template = getPageTemplate(scene.templateId);
    expect(template).toBeDefined();
    for (const layer of scene.layers) {
      if (layer.role === "background" || layer.role === "photo" || layer.role === "avatar") {
        const photoIndex = layer.role === "photo" ? Number(layer.id.split("-")[1] ?? 1) - 1 : 0;
        const sourceIndex = layer.role === "photo" ? (photoIndex + sceneIndex) % 3 : 0;
        const sourceId = `photo-${sourceIndex + 1}`;
        const mediaId = layer.role === "background" ? "paper-bg" : layer.role === "avatar" ? "avatar" : scene.hold ? sourceId : `${sourceId}-video`;
        const trackId = layer.role === "background" ? "track-bg" : layer.role === "avatar" ? "track-avatar" : `track-${layer.id}`;
        const clipId = `${scene.id}-${layer.id}`;
        const shiftedLayer = layer.role === "photo" && sceneIndex % 2 === 1 ? { ...layer, rect: { ...layer.rect, x: layer.rect.x + 0.1 } } : layer;
        const inPoint = scene.hold || layer.role !== "photo" ? 0 : scene.startTime === 0 ? (sourceIndex === 2 ? 0.8 : 0) : (sceneIndex * 0.37 + sourceIndex * 1.7) % 7.0;
        const clip = imageClip(clipId, mediaId, trackId, scene, shiftedLayer, scene.hold ? 0 : scene.startTime === 0 ? 1.45 : 0.95, inPoint);
        clips.push(clip);
        byId.get(trackId)?.clips.push(clip);
      } else if (layer.role === "headline" || layer.role === "body") {
        const trackId = layer.role === "headline" ? "track-headline" : "track-body";
        const clip = textClip(`${scene.id}-${layer.id}`, trackId, scene, layer, scene.templateId, scene.startTime === 0 ? 1.45 : 0.95);
        textClips.push(clip);
      }
    }
  }

  return {
    ...base,
    mediaLibrary: { items: Object.values(MEDIA).map(mediaItem) },
    timeline: { tracks, subtitles: [], duration: DURATION, markers: [] },
    textClips,
  };
}

describe.skipIf(!RUN_P15)("P1.5 vertical page-template render", () => {
  it("samples a composed page frame", async () => {
    const project = buildProject(buildScenes());
    const mediaPaths = Object.fromEntries(Object.values(MEDIA).map((asset) => [asset.id, asset.file]));
    const snapshot = await createMirrorSnapshot(project, mediaPaths);
    const compositor = new MirrorCompositor(process.env.CHROMIUM_EXECUTABLE_PATH);
    try {
      const frame = await compositor.sample(snapshot, 3, 256, 256);
      const mean = frame.data.reduce((sum, value) => sum + value, 0) / frame.data.length;
      const variance = frame.data.reduce((sum, value) => sum + (value - mean) ** 2, 0) / frame.data.length;
      const unique = new Set(frame.data).size;
      const frameA = await compositor.sample(snapshot, 3.0, 96, 54);
      const frameB = await compositor.sample(snapshot, 3.2, 96, 54);
      const frameC = await compositor.sample(snapshot, 10.0, 96, 54);
      const frameD = await compositor.sample(snapshot, 10.2, 96, 54);
      const diff = (left: typeof frameA, right: typeof frameA) => left.data.reduce((sum, value, index) => sum + Math.abs(value - (right.data[index] ?? value)), 0) / left.data.length;
      console.log("P1.5 sample stats", { mean: mean.toFixed(2), variance: variance.toFixed(2), unique, hookDiff: diff(frameA, frameB).toFixed(2), peakDiff: diff(frameC, frameD).toFixed(2) });
      expect(variance).toBeGreaterThan(50);
      expect(unique).toBeGreaterThan(4);
    } finally {
      await compositor.close();
    }
  }, 120_000);

  it("probes page motion at harness cadence", async () => {
    const project = buildProject(buildScenes());
    const mediaPaths = Object.fromEntries(Object.values(MEDIA).map((asset) => [asset.id, asset.file]));
    const snapshot = await createMirrorSnapshot(project, mediaPaths);
    const compositor = new MirrorCompositor(process.env.CHROMIUM_EXECUTABLE_PATH);
    try {
      for (const [label, start, count] of [["hook", 0, 30], ["peak", 10, 12]] as const) {
        let previous: Awaited<ReturnType<typeof compositor.sample>> | undefined;
        const diffs: number[] = [];
        for (let index = 0; index < count; index += 1) {
          const frame = await compositor.sample(snapshot, start + index / 6, 96, 54);
          if (previous) {
            diffs.push(frame.data.reduce((sum, value, pixel) => sum + Math.abs(value - (previous?.data[pixel] ?? value)), 0) / frame.data.length);
          }
          previous = frame;
        }
        console.log(`P1.5 ${label} motion`, { mean: (diffs.reduce((a, b) => a + b, 0) / diffs.length).toFixed(2), first4: (diffs.slice(0, 24).reduce((a, b) => a + b, 0) / Math.min(24, diffs.length)).toFixed(2), min: Math.min(...diffs).toFixed(2), max: Math.max(...diffs).toFixed(2) });
      }
    } finally {
      await compositor.close();
    }
  }, 180_000);

  it("renders the 1080x1920 Curry page edit", async () => {
    const scenes = buildScenes();
    expect(scenes).toHaveLength(44);
    expect(scenes[0]?.startTime).toBe(0);
    expect((scenes.at(-1)?.startTime ?? 0) + (scenes.at(-1)?.durationSeconds ?? 0)).toBeCloseTo(DURATION);
    expect(scenes.filter((scene) => scene.hold)).toHaveLength(1);

    const project = buildProject(scenes);
    expect(project.textClips?.length).toBeGreaterThan(0);
    await mkdir(OUT, { recursive: true });
    await saveProjectFile(resolve(OUT, "curry-magazine-p1.5-project.json"), project);

    const timeline = {
      version: "kove.mograph.timeline.v1",
      durationSeconds: DURATION,
      scenes: scenes.map((scene) => ({
        id: scene.id,
        startSeconds: scene.startTime,
        endSeconds: Math.min(DURATION, scene.startTime + scene.durationSeconds),
        composed: true,
        hold: scene.hold,
        layers: pageSceneTimelineLayers(scene, DURATION),
      })),
    };
    await writeFile(resolve(OUT, "timeline.json"), `${JSON.stringify(timeline, null, 2)}\n`);

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
    } finally {
      await compositor.close();
    }
  }, 900_000);
});
