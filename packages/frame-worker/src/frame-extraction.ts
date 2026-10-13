import type {
  VideoSegmentMap,
  VideoSegment,
} from "@kove-advanced/creation-schema";
import { scoreSportsMoment } from "@kove-advanced/creation-schema";

export interface ExtractedFrame {
  readonly timestamp: number;
  readonly imageData: string; // base64
  readonly width: number;
  readonly height: number;
}

export interface FrameBatch {
  readonly batchIndex: number;
  readonly frames: readonly ExtractedFrame[];
}

export interface SceneBoundary {
  readonly timestamp: number;
  readonly score: number; // histogram difference score
}

export interface AdaptiveSampleConfig {
  readonly baselineFps: number; // 1-2 fps
  readonly burstFps: number; // 8-12 fps
  readonly burstDurationSec: number; // seconds around cut to burst
  readonly sceneThreshold: number; // histogram diff threshold for scene cut
}

export const DEFAULT_SAMPLE_CONFIG: AdaptiveSampleConfig = {
  baselineFps: 1.5,
  burstFps: 10,
  burstDurationSec: 2,
  sceneThreshold: 0.35,
};

// SIGNATURE CHANGE: now async (decoding is unavoidably async). Update every call site.
export async function detectSceneBoundaries(
  frames: readonly ExtractedFrame[],
  threshold: number,
): Promise<readonly SceneBoundary[]> {
  if (frames.length < 2) return [];

  // Compute each frame's histogram ONCE (old code decoded every frame twice, as prev and as curr).
  const histograms = await Promise.all(frames.map(computeFrameHistogram));

  const boundaries: SceneBoundary[] = [];
  for (let i = 1; i < histograms.length; i++) {
    const diff = histogramDifference(histograms[i - 1]!.bins, histograms[i]!.bins);
    if (diff > threshold) boundaries.push({ timestamp: histograms[i]!.timestamp, score: diff });
  }
  return boundaries;
}

// ---- Real perceptual scene-cut detection (replaces Math.random() stub) ----

const HIST_BUCKETS = 16;   // per channel
const THUMB_SIZE = 32;     // downsample before histogramming — cheap and sufficient for cut detection

export interface FrameHistogram {
  readonly timestamp: number;
  readonly bins: Float32Array; // 48 bins: 16 per R/G/B, each channel normalized to sum 1
}

async function decodeToImageData(base64: string): Promise<ImageData> {
  const byteChars = atob(base64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));

  const canvas = new OffscreenCanvas(THUMB_SIZE, THUMB_SIZE);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");
  ctx.drawImage(bitmap, 0, 0, THUMB_SIZE, THUMB_SIZE);
  bitmap.close();
  return ctx.getImageData(0, 0, THUMB_SIZE, THUMB_SIZE);
}

function histogramFromImageData(data: ImageData): Float32Array {
  const bins = new Float32Array(HIST_BUCKETS * 3);
  const bucketSize = 256 / HIST_BUCKETS;
  const px = data.data;
  let count = 0;
  for (let i = 0; i < px.length; i += 4) {
    bins[Math.min(HIST_BUCKETS - 1, Math.floor(px[i]! / bucketSize))]++;
    bins[HIST_BUCKETS + Math.min(HIST_BUCKETS - 1, Math.floor(px[i + 1]! / bucketSize))]++;
    bins[HIST_BUCKETS * 2 + Math.min(HIST_BUCKETS - 1, Math.floor(px[i + 2]! / bucketSize))]++;
    count++;
  }
  for (let i = 0; i < bins.length; i++) bins[i] = bins[i]! / count;
  return bins;
}

export async function computeFrameHistogram(frame: ExtractedFrame): Promise<FrameHistogram> {
  const imageData = await decodeToImageData(frame.imageData);
  return { timestamp: frame.timestamp, bins: histogramFromImageData(imageData) };
}

/** 1 - histogram intersection. 0 = identical frame, 1 = maximally different. */
function histogramDifference(a: Float32Array, b: Float32Array): number {
  let intersection = 0;
  for (let i = 0; i < a.length; i++) intersection += Math.min(a[i]!, b[i]!);
  return 1 - intersection / 3; // 3 channels, each normalized to sum 1
}

export function computeAdaptiveTimestamps(
  durationSec: number,
  sceneBoundaries: readonly SceneBoundary[],
  config: AdaptiveSampleConfig = DEFAULT_SAMPLE_CONFIG,
): readonly number[] {
  const timestamps = new Set<number>();

  // Baseline frames
  const baselineInterval = 1 / config.baselineFps;
  for (let t = 0; t < durationSec; t += baselineInterval) {
    timestamps.add(Math.round(t * 1000) / 1000);
  }

  // Burst frames around scene boundaries
  for (const boundary of sceneBoundaries) {
    const burstStart = Math.max(0, boundary.timestamp - config.burstDurationSec);
    const burstEnd = Math.min(
      durationSec,
      boundary.timestamp + config.burstDurationSec,
    );
    const burstInterval = 1 / config.burstFps;

    for (let t = burstStart; t <= burstEnd; t += burstInterval) {
      timestamps.add(Math.round(t * 1000) / 1000);
    }
  }

  return [...timestamps].sort((a, b) => a - b);
}

export function batchFrames(
  frames: readonly ExtractedFrame[],
  batchSize: number = 6,
): readonly FrameBatch[] {
  const batches: FrameBatch[] = [];

  for (let i = 0; i < frames.length; i += batchSize) {
    const batchFrames = frames.slice(i, i + batchSize);
    batches.push({
      batchIndex: batches.length,
      frames: batchFrames,
    });
  }

  return batches;
}

export interface VisionDescription {
  readonly timestamp: number;
  readonly description: string;
  readonly sceneType: string;
  readonly motionLevel: string;
  readonly hasDialogue: boolean;
  readonly confidence: number;
  readonly motionPeak?: number;
  readonly audioEnergy?: number;
  readonly audioBpm?: number;
  readonly beatTimestamps?: readonly number[];
  readonly facePresenceRatio?: number;
  readonly hasTalkingHead?: boolean;
  readonly subjectIds?: readonly string[];
  readonly subjectContinuityScore?: number;
  readonly editSignals?: {
    readonly shotType: string;
    readonly transition: string;
    readonly overlayText: string | null;
    readonly effects: readonly string[];
    readonly colorTreatment: string | null;
    readonly usedFor: readonly string[];
  };
}

function buildSegmentSignals(items: readonly VisionDescription[]) {
  const strongest = items.reduce((best, item) =>
    (item.motionPeak ?? 0) > (best.motionPeak ?? 0) ? item : best, items[0]!);
  const sports = scoreSportsMoment(strongest);
  const subjectIds = [...new Set(items.flatMap((item) => item.subjectIds ?? []))];
  return {
    motionPeak: Math.max(...items.map((item) => item.motionPeak ?? 0), 0),
    audioEnergy: items.reduce((sum, item) => sum + (item.audioEnergy ?? 0), 0) / Math.max(1, items.length),
    audioBpm: items.find((item) => item.audioBpm !== undefined)?.audioBpm,
    beatTimestamps: [...new Set(items.flatMap((item) => item.beatTimestamps ?? []))].sort((a, b) => a - b),
    facePresenceRatio: items.reduce((sum, item) => sum + (item.facePresenceRatio ?? 0), 0) / Math.max(1, items.length),
    hasTalkingHead: items.some((item) => item.hasTalkingHead),
    subjectIds,
    subjectContinuityScore: items.reduce((sum, item) => sum + (item.subjectContinuityScore ?? 0), 0) / Math.max(1, items.length),
    sportsMomentScore: sports.score,
    sportsMomentEvent: sports.event,
  };
}

export function descriptionsToSegmentMap(
  videoId: string,
  duration: number,
  descriptions: readonly VisionDescription[],
): VideoSegmentMap {
  if (descriptions.length === 0) {
    return {
      videoId,
      duration,
      segments: [],
    };
  }

  const segments: VideoSegment[] = [];
  let segmentStart = descriptions[0]!.timestamp;
  let currentType = descriptions[0]!.sceneType;
  let currentMotion = descriptions[0]!.motionLevel;
  let descriptionBuffer = [descriptions[0]!.description];

  for (let i = 1; i < descriptions.length; i++) {
    const desc = descriptions[i]!;
    const prev = descriptions[i - 1]!;
    const timeGap = desc.timestamp - prev.timestamp;

    const typeChanged = desc.sceneType !== currentType;
    const motionChanged = desc.motionLevel !== currentMotion;
    const longGap = timeGap > 5; // 5 second gap = new segment

    if (typeChanged || motionChanged || longGap) {
      const segmentDescriptions = descriptions.filter((item) => item.timestamp >= segmentStart && item.timestamp <= prev.timestamp);
      segments.push({
        id: `${videoId}-seg-${segments.length}`,
        startTime: segmentStart,
        endTime: prev.timestamp,
        description: descriptionBuffer.join(" "),
        sceneType: currentType as VideoSegment["sceneType"],
        motionLevel: currentMotion as VideoSegment["motionLevel"],
        hasDialogue: prev.hasDialogue,
        visualContent: descriptionBuffer.join(" | "),
        confidence: prev.confidence,
        ...buildSegmentSignals(segmentDescriptions),
      });

      segmentStart = desc.timestamp;
      currentType = desc.sceneType;
      currentMotion = desc.motionLevel;
      descriptionBuffer = [desc.description];
    } else {
      descriptionBuffer.push(desc.description);
    }
  }

  // Final segment
  const lastDesc = descriptions[descriptions.length - 1]!;
  segments.push({
    id: `${videoId}-seg-${segments.length}`,
    startTime: segmentStart,
    endTime: lastDesc.timestamp,
    description: descriptionBuffer.join(" "),
    sceneType: currentType as VideoSegment["sceneType"],
    motionLevel: currentMotion as VideoSegment["motionLevel"],
    hasDialogue: lastDesc.hasDialogue,
    visualContent: descriptionBuffer.join(" | "),
    confidence: lastDesc.confidence,
    ...buildSegmentSignals(descriptions.filter((item) => item.timestamp >= segmentStart)),
  });

  return { videoId, duration, segments };
}

/**
 * Bearer header for an analysis backend, or nothing when no token is configured.
 *
 * Both backends refuse requests that carry no token once one is configured: the
 * Cloudflare worker answers 503 until `WORKER_AUTH_TOKEN` exists, and the Python
 * engine answers 401 when `KOVE_ENGINE_TOKEN` is set. Without this header the
 * client could not talk to a hardened backend at all, which would make the
 * lockdown inert — so the token travels with every request, including the polls.
 */
function authHeaders(authToken?: string): Record<string, string> {
  const token = authToken?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * A failure that carries the HTTP status, so callers can tell "the backend
 * refused me" from "the backend isn't there". Reaching a 401 by way of a JSON
 * parse error is how an auth misconfiguration gets reported as a network
 * outage.
 */
export class VisionWorkerHttpError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(`Vision worker error: HTTP ${status}${detail ? ` (${detail})` : ""}`);
    this.name = "VisionWorkerHttpError";
    this.status = status;
    this.detail = detail;
  }
}

/** Best-effort error text from a failed response, capped for log/UI sanity. */
async function describeFailure(response: {
  status?: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}): Promise<string> {
  const body = await readFailureBody(response);
  if (body === null) return "";
  if (typeof body === "string") return body.trim().slice(0, 300);
  try {
    return JSON.stringify(body).slice(0, 300);
  } catch {
    return "";
  }
}

async function readFailureBody(response: {
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}): Promise<unknown> {
  if (typeof response.text === "function") {
    try {
      return await response.text();
    } catch {
      return null;
    }
  }
  if (typeof response.json === "function") {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  return null;
}

export interface VisionWorkerCallOptions {
  /**
   * Shared secret for a hardened backend, from the app's configuration. Empty or
   * absent means no Authorization header is sent — correct for a backend that
   * has not been locked down yet, and the only case that works against one that
   * has.
   */
  readonly authToken?: string;
}

export async function callVisionWorker(
  workerUrl: string,
  videoId: string,
  totalDuration: number,
  batches: readonly FrameBatch[],
  options: VisionWorkerCallOptions = {},
): Promise<readonly VisionDescription[]> {
  const response = await fetch(workerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(options.authToken) },
    body: JSON.stringify({
      videoId,
      totalDuration,
      frames: batches,
    }),
  });

  if (!response.ok) {
    throw new VisionWorkerHttpError(
      response.status ?? 0,
      await describeFailure(response),
    );
  }

  const payload = (await response.json()) as unknown;

  // Job-based backend (python-engine): the POST returns {jobId} immediately
  // and the result arrives via GET /jobs/{id}. Sync backends (the Cloudflare
  // worker) return {batches} inline and take the legacy path below.
  if (isJobAccepted(payload)) {
    const jobsUrl = new URL(`/jobs/${payload.jobId}`, workerUrl).toString();
    const result = await pollAnalysisJob(jobsUrl, { authToken: options.authToken });
    return result.batches.flatMap((b) => b.descriptions);
  }

  const result = payload as VisionWorkerSyncResult;
  return result.batches.flatMap((b) => b.descriptions);
}

interface VisionWorkerSyncResult {
  batches: Array<{
    descriptions: VisionDescription[];
  }>;
}

interface VisionWorkerJobAccepted {
  jobId: string;
  status?: string;
}

const JOB_POLL_INTERVAL_MS = 500;
const JOB_POLL_TIMEOUT_MS = 15 * 60 * 1000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isJobAccepted(value: unknown): value is VisionWorkerJobAccepted {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).jobId === "string" &&
    !("batches" in (value as Record<string, unknown>))
  );
}

/**
 * Polls a job-based analysis backend (python-engine) until the job reaches a
 * terminal status, then returns its result. Cadence is ~500ms with a hard
 * timeout so a wedged job cannot hang an edit session forever.
 */
export async function pollAnalysisJob(
  jobsUrl: string,
  options: { pollIntervalMs?: number; timeoutMs?: number; authToken?: string } = {},
): Promise<VisionWorkerSyncResult> {
  const interval = options.pollIntervalMs ?? JOB_POLL_INTERVAL_MS;
  const deadline = Date.now() + (options.timeoutMs ?? JOB_POLL_TIMEOUT_MS);

  while (Date.now() < deadline) {
    const response = await fetch(jobsUrl, { headers: authHeaders(options.authToken) });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403 || response.status === 503) {
        throw new VisionWorkerHttpError(
          response.status,
          await describeFailure(response),
        );
      }
      throw new Error(`Analysis job poll error: HTTP ${response.status}`);
    }
    const job = (await response.json()) as {
      status: string;
      result?: VisionWorkerSyncResult | null;
      error?: string;
    };
    if (job.status === "completed") {
      if (!job.result || !Array.isArray(job.result.batches)) {
        throw new Error("Analysis job completed without a usable result.");
      }
      return job.result;
    }
    if (job.status === "failed") {
      throw new Error("Analysis job failed.");
    }
    if (job.status === "unknown") {
      throw new Error("Analysis job not found (it may have expired).");
    }
    await sleep(interval);
  }
  throw new Error("Analysis job timed out while polling for completion.");
}
