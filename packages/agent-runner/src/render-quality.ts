import { spawnSync } from "node:child_process";
import type { Project } from "@kove-advanced/core/types/project";

export interface RenderQualityTargets {
  readonly act2Start: number;
  readonly act2End: number;
  readonly gridInterval: number;
  readonly frameRate: number;
  readonly flashStart: number;
  readonly blackStart: number;
  readonly wordmarkStart: number;
}

export interface RenderQualityReport {
  readonly file: string;
  readonly resolution: { readonly width: number; readonly height: number };
  readonly frameRate: number;
  readonly frames: number;
  readonly duration: number;
  readonly act2: {
    readonly meanLuma: number;
    readonly lumaP5: number;
    readonly lumaP95: number;
    readonly meanRgb: { readonly red: number; readonly green: number; readonly blue: number };
    readonly meanSaturation: number;
    readonly tealSkew: { readonly greenMinusRed: number; readonly blueMinusRed: number };
    readonly targets: {
      readonly meanLuma: boolean;
      readonly lumaP5: boolean;
      readonly lumaP95: boolean;
      readonly tealSkew: boolean;
      readonly saturation: boolean;
    };
  };
  readonly cadence: {
    readonly gridIntervalSeconds: number;
    readonly intervalsSeconds: readonly number[];
    readonly intervalsFrames: readonly number[];
    readonly cutBoundaryPixelDelta: readonly number[];
    readonly allIntervalsOnGrid: boolean;
    readonly allRenderBoundariesVisible: boolean;
  };
  readonly ending: {
    readonly flashFrameLuma: readonly number[];
    readonly blackFrameLuma: readonly number[];
    readonly wordmarkFrameLuma: number;
    readonly targetsMet: boolean;
  };
  readonly passed: boolean;
}

interface FrameStats {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly meanLuma: number;
  readonly p5: number;
  readonly p95: number;
  readonly meanSaturation: number;
  readonly pixels: number;
}

function percentile(histogram: Uint32Array, count: number, fraction: number): number {
  const target = Math.floor((count - 1) * fraction);
  let cumulative = 0;
  for (let value = 0; value < histogram.length; value++) {
    cumulative += histogram[value]!;
    if (cumulative > target) return value;
  }
  return histogram.length - 1;
}

function readFrame(bytes: Buffer, offset: number, width: number, height: number): FrameStats {
  const pixels = width * height;
  const histogram = new Uint32Array(256);
  let red = 0;
  let green = 0;
  let blue = 0;
  let saturation = 0;
  let luma = 0;
  for (let pixel = 0; pixel < pixels; pixel++) {
    const index = offset + pixel * 3;
    const r = bytes[index]!;
    const g = bytes[index + 1]!;
    const b = bytes[index + 2]!;
    red += r;
    green += g;
    blue += b;
    const y = Math.max(0, Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b)));
    histogram[y]!++;
    luma += y;
    const maximum = Math.max(r, g, b);
    if (maximum > 0) saturation += (maximum - Math.min(r, g, b)) / maximum;
  }
  return {
    red: red / pixels,
    green: green / pixels,
    blue: blue / pixels,
    meanLuma: luma / pixels,
    p5: percentile(histogram, pixels, 0.05),
    p95: percentile(histogram, pixels, 0.95),
    meanSaturation: saturation / pixels,
    pixels,
  };
}

function rgbDelta(
  bytes: Buffer,
  previousOffset: number,
  currentOffset: number,
  pixelCount: number,
): number {
  let delta = 0;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const index = pixel * 3;
    delta += Math.abs(bytes[currentOffset + index]! - bytes[previousOffset + index]!);
    delta += Math.abs(bytes[currentOffset + index + 1]! - bytes[previousOffset + index + 1]!);
    delta += Math.abs(bytes[currentOffset + index + 2]! - bytes[previousOffset + index + 2]!);
  }
  return delta / (pixelCount * 3 * 255);
}

function frameAt(frames: readonly FrameStats[], seconds: number, frameRate: number): FrameStats | undefined {
  return frames[Math.max(0, Math.min(frames.length - 1, Math.round(seconds * frameRate)))];
}

function mediaFrameDelta(
  bytes: Buffer,
  frameCount: number,
  frameSize: number,
  frameRate: number,
  seconds: number,
): number {
  const frameIndex = Math.round(seconds * frameRate);
  if (frameIndex <= 0 || frameIndex >= frameCount) return 0;
  return rgbDelta(bytes, (frameIndex - 1) * frameSize, frameIndex * frameSize, frameSize / 3);
}

export function isCutIntervalGridConforming(
  intervals: readonly number[],
  gridInterval: number,
  frameRate: number,
): boolean {
  if (intervals.length === 0 || !Number.isFinite(gridInterval) || gridInterval <= 0 || frameRate <= 0) {
    return false;
  }
  const tolerance = 1 / frameRate;
  const gridFrames = gridInterval * frameRate;
  const lowerFrame = Math.floor(gridFrames);
  const upperFrame = Math.ceil(gridFrames);
  return intervals.every((seconds) => {
    const frames = Math.round(seconds * frameRate);
    return Math.abs(seconds - gridInterval) <= tolerance
      && (frames === lowerFrame || frames === upperFrame);
  });
}

export function measureRenderedVideoQuality(
  videoPath: string,
  project: Project,
  targets: RenderQualityTargets,
  ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg",
): RenderQualityReport {
  const probe = spawnSync(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-i", videoPath,
    "-vf", "scale=64:71:flags=area,format=rgb24",
    "-fps_mode", "passthrough", "-f", "rawvideo", "pipe:1",
  ], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  if (probe.error) throw probe.error;
  if (probe.status !== 0) throw new Error(`Could not decode rendered video for QA: ${probe.stderr.toString("utf8")}`);

  const width = 64;
  const height = 71;
  const frameSize = width * height * 3;
  if (probe.stdout.length === 0 || probe.stdout.length % frameSize !== 0) {
    throw new Error("Rendered video decoder returned incomplete RGB frames");
  }
  const bytes = probe.stdout;
  const frameCount = bytes.length / frameSize;
  const frames = Array.from({ length: frameCount }, (_, index) =>
    readFrame(bytes, index * frameSize, width, height),
  );
  const act2First = Math.max(0, Math.ceil(targets.act2Start * targets.frameRate));
  const act2Last = Math.min(frameCount, Math.ceil(targets.act2End * targets.frameRate));
  const act2Frames = frames.slice(act2First, act2Last);
  if (act2Frames.length === 0) throw new Error("Act-two interval contains no rendered frames");
  const pixelCount = act2Frames.reduce((sum, frame) => sum + frame.pixels, 0);
  const channelMean = (key: "red" | "green" | "blue"): number =>
    act2Frames.reduce((sum, frame) => sum + frame[key] * frame.pixels, 0) / pixelCount;
  const lumaHistogram = new Uint32Array(256);
  let lumaTotal = 0;
  let saturationTotal = 0;
  for (let index = act2First; index < act2Last; index++) {
    const offset = index * frameSize;
    for (let pixel = 0; pixel < width * height; pixel++) {
      const byteIndex = offset + pixel * 3;
      const r = bytes[byteIndex]!;
      const g = bytes[byteIndex + 1]!;
      const b = bytes[byteIndex + 2]!;
      const y = Math.max(0, Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b)));
      lumaHistogram[y]!++;
      lumaTotal += y;
      const maximum = Math.max(r, g, b);
      if (maximum > 0) saturationTotal += (maximum - Math.min(r, g, b)) / maximum;
    }
  }
  const act2Pixels = act2Frames.length * width * height;
  const red = channelMean("red");
  const green = channelMean("green");
  const blue = channelMean("blue");
  const lumaMean = lumaTotal / act2Pixels;
  const lumaP5 = percentile(lumaHistogram, act2Pixels, 0.05);
  const lumaP95 = percentile(lumaHistogram, act2Pixels, 0.95);
  const meanSaturation = saturationTotal / act2Pixels;

  const videoTracks = project.timeline.tracks.filter((track) => track.type === "video");
  const primaryTrack = videoTracks.find((track) => track.clips.some((clip) =>
    project.mediaLibrary.items.find((item) => item.id === clip.mediaId)?.type === "video",
  ));
  const act2Shots = (primaryTrack?.clips ?? [])
    .filter((clip) => {
      const media = project.mediaLibrary.items.find((item) => item.id === clip.mediaId);
      return media?.type === "video"
        && clip.startTime >= targets.act2Start - 1e-6
        && clip.startTime < targets.act2End - 1e-6;
    })
    .sort((a, b) => a.startTime - b.startTime);
  const intervals = act2Shots.slice(1).map((clip, index) =>
    clip.startTime - act2Shots[index]!.startTime,
  );
  const intervalFrames = intervals.map((seconds) => Math.round(seconds * targets.frameRate));
  const cutBoundaryPixelDelta = act2Shots.slice(1).map((clip) =>
    mediaFrameDelta(bytes, frameCount, frameSize, targets.frameRate, clip.startTime),
  );
  const allIntervalsOnGrid = isCutIntervalGridConforming(
    intervals,
    targets.gridInterval,
    targets.frameRate,
  );
  const allRenderBoundariesVisible = cutBoundaryPixelDelta.length > 0
    && cutBoundaryPixelDelta.every((delta) => delta > 0.025);

  const flashFrames = [0, 1, 2].map((index) =>
    frameAt(frames, targets.flashStart + index / targets.frameRate, targets.frameRate)?.meanLuma ?? 0,
  );
  const blackFrames = [0, 1, 2, 3, 4, 5].map((index) =>
    frameAt(frames, targets.blackStart + index / targets.frameRate, targets.frameRate)?.meanLuma ?? 255,
  );
  const wordmarkLuma = frameAt(frames, targets.wordmarkStart + 0.25, targets.frameRate)?.meanLuma ?? 0;

  const act2 = {
    meanLuma: lumaMean,
    lumaP5,
    lumaP95,
    meanRgb: { red, green, blue },
    meanSaturation,
    tealSkew: { greenMinusRed: green - red, blueMinusRed: blue - red },
    targets: {
      meanLuma: lumaMean >= 38 && lumaMean <= 45,
      lumaP5: lumaP5 === 0,
      lumaP95: lumaP95 >= 200,
      tealSkew: green > red && blue - red >= 12,
      saturation: meanSaturation >= 0.5 && meanSaturation <= 0.58,
    },
  };
  const endingTargetsMet = flashFrames.every((luma) => luma >= 220)
    && blackFrames.every((luma) => luma <= 5)
    && wordmarkLuma >= 5;
  const cadenceTargetsMet = allIntervalsOnGrid && allRenderBoundariesVisible;

  return {
    file: videoPath,
    resolution: { width: project.settings.width, height: project.settings.height },
    frameRate: targets.frameRate,
    frames: frameCount,
    duration: frameCount / targets.frameRate,
    act2,
    cadence: {
      gridIntervalSeconds: targets.gridInterval,
      intervalsSeconds: intervals,
      intervalsFrames: intervalFrames,
      cutBoundaryPixelDelta,
      allIntervalsOnGrid,
      allRenderBoundariesVisible,
    },
    ending: {
      flashFrameLuma: flashFrames,
      blackFrameLuma: blackFrames,
      wordmarkFrameLuma: wordmarkLuma,
      targetsMet: endingTargetsMet,
    },
    passed: Object.values(act2.targets).every(Boolean) && cadenceTargetsMet && endingTargetsMet,
  };
}
