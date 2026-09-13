import type { SegmentMap, StyleProfile } from "@kove-advanced/creation-schema";
import {
  type AdaptiveSampleConfig,
  type ExtractedFrame,
  type VisionDescription,
  batchFrames,
  computeAdaptiveTimestamps,
  detectSceneBoundaries,
  descriptionsToSegmentMap,
  callVisionWorker,
  DEFAULT_SAMPLE_CONFIG,
} from "./frame-extraction";

export type {
  ExtractedFrame,
  VisionDescription,
  AdaptiveSampleConfig,
} from "./frame-extraction";

export { DEFAULT_SAMPLE_CONFIG, batchFrames } from "./frame-extraction";

export interface ExtractSegmentsInput {
  readonly videos: readonly VideoInput[];
  readonly workerUrl: string;
  readonly sampleConfig?: AdaptiveSampleConfig;
}

export interface VideoInput {
  readonly videoId: string;
  readonly duration: number;
  readonly frames: readonly ExtractedFrame[];
}

export interface ExtractSegmentsResult {
  readonly segmentMap: SegmentMap;
  readonly processingTimeMs: number;
  readonly frameCount: number;
  readonly segmentCount: number;
  readonly referenceAnalysis: ReferenceAnalysis;
}

export interface ReferenceAnalysis {
  readonly analysisVersion: "1.1.0";
  readonly videos: readonly ReferenceVideoAnalysis[];
}

export interface ReferenceVideoAnalysis {
  readonly videoId: string;
  readonly duration: number;
  readonly summary: {
    readonly pacing: "fast" | "moderate" | "slow" | "unknown";
    readonly cutCount: number;
    readonly cutsPerMinute: number;
    readonly dialogueLed: boolean;
  };
  readonly styleProfile: StyleProfile;
  readonly timeline: readonly {
    readonly startTime: number;
    readonly endTime: number;
    readonly usedFor: readonly string[];
    readonly evidence: string;
    readonly confidence: number;
  }[];
}

export async function extractSegments(
  input: ExtractSegmentsInput,
): Promise<ExtractSegmentsResult> {
  const startTime = Date.now();
  const config = input.sampleConfig ?? DEFAULT_SAMPLE_CONFIG;

  const allDescriptions: Array<{
    videoId: string;
    duration: number;
    descriptions: readonly VisionDescription[];
  }> = [];

  let totalFrameCount = 0;

  for (const video of input.videos) {
    // Detect scene boundaries from the provided frames (now async — decoding is unavoidably async)
    const sceneBoundaries = await detectSceneBoundaries(
      video.frames,
      config.sceneThreshold,
    );

    // Compute which timestamps we need (adaptive sampling)
    const targetTimestamps = computeAdaptiveTimestamps(
      video.duration,
      sceneBoundaries,
      config,
    );

    // Filter frames to match target timestamps (within tolerance)
    const tolerance = 0.5; // seconds
    const selectedFrames = video.frames.filter((frame) =>
      targetTimestamps.some(
        (t) => Math.abs(frame.timestamp - t) < tolerance,
      ),
    );

    totalFrameCount += selectedFrames.length;

    // Batch frames for the vision worker
    const batches = batchFrames(selectedFrames);

    // Call the vision worker
    const descriptions = await callVisionWorker(
      input.workerUrl,
      video.videoId,
      video.duration,
      batches,
    );

    allDescriptions.push({
      videoId: video.videoId,
      duration: video.duration,
      descriptions,
    });
  }

  // Convert descriptions to SegmentMap
  const videos = allDescriptions.map((v) =>
    descriptionsToSegmentMap(v.videoId, v.duration, v.descriptions),
  );

  const segmentMap: SegmentMap = { videos };
  const segmentCount = videos.reduce((sum, v) => sum + v.segments.length, 0);
  const referenceAnalysis: ReferenceAnalysis = {
    analysisVersion: "1.1.0",
    videos: allDescriptions.map((video) => {
      const descriptions = video.descriptions;
      const durations = descriptions.map((description, index) =>
        (descriptions[index + 1]?.timestamp ?? video.duration) - description.timestamp,
      );
      const typicalDuration = durations.length > 0
        ? durations.sort((a, b) => a - b)[Math.floor(durations.length / 2)]!
        : 0;
      const pacing = typicalDuration <= 1.5 ? "fast" : typicalDuration >= 6 ? "slow" : "moderate";
      const timeline = descriptions.flatMap((description, index) => {
        const usedFor = description.editSignals?.usedFor ?? [];
        if (usedFor.length === 0) return [];
        return [{
          startTime: description.timestamp,
          endTime: descriptions[index + 1]?.timestamp ?? video.duration,
          usedFor,
          evidence: description.description,
          confidence: description.confidence,
        }];
      });
      return {
        videoId: video.videoId,
        duration: video.duration,
        summary: {
          pacing,
          cutCount: Math.max(
            0,
            (videos.find((item) => item.videoId === video.videoId)?.segments.length ?? 0) - 1,
          ),
          cutsPerMinute: video.duration > 0 ? Math.max(0, descriptions.length - 1) / (video.duration / 60) : 0,
          dialogueLed: descriptions.filter((description) => description.hasDialogue).length / Math.max(1, descriptions.length) >= 0.35,
        },
        styleProfile: buildStyleProfile(descriptions, durations, video.duration, pacing),
        timeline,
      };
    }),
  };

  return {
    segmentMap,
    processingTimeMs: Date.now() - startTime,
    frameCount: totalFrameCount,
    segmentCount,
    referenceAnalysis,
  };
}

function buildStyleProfile(
  descriptions: readonly VisionDescription[],
  durations: readonly number[],
  duration: number,
  pacing: ReferenceVideoAnalysis["summary"]["pacing"],
): StyleProfile {
  const shotTypeCounts = new Map<string, number>();
  for (const description of descriptions) {
    const shotType = description.editSignals?.shotType ?? description.sceneType;
    shotTypeCounts.set(shotType, (shotTypeCounts.get(shotType) ?? 0) + 1);
  }
  const shotTypeDistribution = Object.fromEntries(
    [...shotTypeCounts.entries()].map(([key, count]) => [
      key,
      count / Math.max(1, descriptions.length),
    ]),
  );
  const sortedDurations = [...durations].sort((left, right) => left - right);
  const medianShotDuration = sortedDurations.length > 0
    ? sortedDurations[Math.floor(sortedDurations.length / 2)]!
    : 0;
  const effects = descriptions.reduce(
    (count, description) => count + (description.editSignals?.effects.length ?? 0),
    0,
  );
  const overlays = descriptions.filter((description) => description.editSignals?.overlayText).length;
  const transitions = descriptions.filter((description) => description.editSignals?.transition).length;

  return {
    version: "1.0.0",
    pacing,
    cutsPerMinute: duration > 0 ? Math.max(0, descriptions.length - 1) / (duration / 60) : 0,
    medianShotDuration,
    cutOnBeatRatio: null,
    effectDensity: duration > 0 ? effects / (duration / 60) : 0,
    transitionDensity: duration > 0 ? transitions / (duration / 60) : 0,
    textOverlayDensity: duration > 0 ? overlays / (duration / 60) : 0,
    shotTypeDistribution,
    cutStyle: transitions > 0 ? "mixed" : "unknown",
    effectPalette: [...new Set(descriptions.flatMap((description) => description.editSignals?.effects ?? []))],
    transitionPalette: [...new Set(descriptions.flatMap((description) => {
      const transition = description.editSignals?.transition;
      return transition ? [transition] : [];
    }))],
    detectedBpm: null,
    dialogueRatio: descriptions.filter((description) => description.hasDialogue).length / Math.max(1, descriptions.length),
    musicRatio: 0,
    confidence: descriptions.length > 0
      ? descriptions.reduce((sum, description) => sum + description.confidence, 0) / descriptions.length
      : 0,
  };
}
