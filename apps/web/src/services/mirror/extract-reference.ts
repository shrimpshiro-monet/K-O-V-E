import { openIndexedVideoFrames } from "@kove-advanced/core/mirror/decoded-frames";
import { InvalidCutDifferenceError, locateCutFrame, refineCutFrameByPeak } from "@kove-advanced/core/mirror/cut-boundary";
import { frameToSeconds, secondsToFrame, type FrameRate } from "@kove-advanced/core/mirror/timebase";
import { computeLabStats } from "@kove-advanced/core/color/reinhard-transfer";
import { classifyDominantMove, type CameraMotionSample } from "@kove-advanced/core/vision/camera-motion-extractor";
import { getWarmOpenCvMotionClient } from "./opencv-motion-client";
import {
  buildEditorStructure,
  createReferenceProfile,
  type ReferenceEffectEvidence,
  type ReferenceProfile,
  type ReferenceTransitionEvidence,
  type ShotProfile,
} from "@kove-advanced/core/mirror/reference-profile";
import {
  abortError,
  abortable,
  analysisDimensions,
  createReferenceProgressReporter,
  createWorkBudget,
  REFERENCE_FRAME_BUDGET_MS,
  REFERENCE_MAX_FRAMES_PER_SLICE,
  REFERENCE_PROGRESS_INTERVAL_MS,
  throwIfAborted,
} from "./reference-measurement";
import {
  createLocalTextDetector,
  detectTextInPixels,
  mergeTextObservations,
  normalizeTextObservations,
  type TextObservation,
} from "./reference-text";

/** Tuned against the existing normalized, sampled-RGB difference signal.
 * Never reuse this value for luma or another signal without recalibration. */
const CUT_DIFFERENCE_THRESHOLD = 0.23;
const OCR_SAMPLE_BUDGET = 60;
const OCR_TOTAL_BUDGET_MS = 10_000;
const OCR_FRAME_TIMEOUT_MS = 1_000;
const SOURCE_FRAME_TIMEOUT_MS = 15_000;
const LONG_SHOT_MEDIAN_MULTIPLIER = 4;
const MAX_LONG_SHOT_RESCAN_FRAMES = 1_800;
const MAX_TRAILING_RESCAN_FRAMES = 180;
export const FFMPEG_SCENE_THRESHOLD = 0.08;

export interface ExtractReferenceOptions {
  /** Called with coalesced progress: at most once per ~250ms, plus the total at the end. */
  onProgress?: (done: number, total: number) => void;
  /** Cancels in-flight measurement and decoder reads. The measurement rejects
   * with an `AbortError` and releases its decoder immediately. */
  signal?: AbortSignal;
  /** Long-edge cap of the analysis buffer. Defaults to the calibrated 160px. */
  maxAnalysisDimension?: number;
  /** Wall clock for the work budget and the progress throttle. Injectable for tests. */
  now?: () => number;
  /** Include creator-added text in analysis only after explicit user consent. */
  includeReferenceText?: boolean;
}

interface YieldingScheduler {
  yield?: () => Promise<void>;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Let the tab paint and handle input between work slices.
 * scheduler.yield() avoids the clamping delay of nested zero timers where available. */
async function yieldToEventLoop(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & { scheduler?: YieldingScheduler }).scheduler;
  if (typeof scheduler?.yield === "function") {
    await scheduler.yield();
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Bounded, local decoder pass. No media bytes leave the browser or enter the DNA artifact.
 * Desktop FFmpeg scene scores supplement cut measurements for unusually long
 * shots; camera motion uses sparse patch correspondences + least-squares similarity fit.
 * Sparse HTML seeking is limited to <= 4 fps: never promise frame-exact cuts from that fallback.
 *
 * Responsiveness contract for the caller: every synchronous stretch of this
 * function is bounded by REFERENCE_FRAME_BUDGET_MS / REFERENCE_MAX_FRAMES_PER_SLICE
 * and the analysis buffer is capped by `analysisDimensions`, so no slice of work
 * grows with the reference's resolution or length. Awaiting decodes yields to
 * the event loop naturally, and `signal` cancels the loop *and* any pending
 * decode wait. */
export interface ReferenceClock {
  fps: FrameRate;
  fpsSource: ReferenceProfile["fpsSource"];
  durationSeconds?: number;
  videoStartTimeSeconds?: number;
  sampleAspectRatio?: FrameRate;
  codedDimensions?: { width: number; height: number };
  rotationDegrees?: number;
}
/** Browser HTMLVideoElement has duration and display dimensions but NO authoritative FPS.
 * Desktop ffprobe can provide a clock; otherwise the user must supply it explicitly. */
export async function probeReferenceClock(file: File): Promise<{ status: "known"; clock: ReferenceClock } | { status: "unknown"; reason: string }> {
  const bridge = window["kove-advanced"]?.media;
  if (bridge?.probeVideoStream && bridge.getPathForFile) {
    try {
      const srcPath = bridge.getPathForFile(file);
      if (srcPath) {
        const metadata = await bridge.probeVideoStream({ srcPath });
        if (metadata.fps) return { status: "known", clock: { fps: metadata.fps, fpsSource: "ffprobe", ...(metadata.durationSeconds && { durationSeconds: metadata.durationSeconds }), videoStartTimeSeconds: metadata.startTimeSeconds, ...(metadata.sampleAspectRatio && { sampleAspectRatio: metadata.sampleAspectRatio }), codedDimensions: { width: metadata.width, height: metadata.height }, ...(metadata.rotationDegrees !== null && { rotationDegrees: metadata.rotationDegrees }) } };
        return { status: "unknown", reason: metadata.variableFrameRate ? "Variable frame rate: select a target frame clock explicitly." : "ffprobe did not report an authoritative frame rate." };
      }
    } catch { return { status: "unknown", reason: "Desktop ffprobe unavailable. Select a frame rate explicitly." }; }
  }
  return { status: "unknown", reason: "Browser video metadata does not expose an authoritative frame rate. Select one explicitly." };
}

export async function extractReference(file: Blob, clock: ReferenceClock, options: ExtractReferenceOptions = {}): Promise<ReferenceProfile> {
  const { signal } = options;
  const now = options.now ?? (() => Date.now());
  throwIfAborted(signal);
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.src = url;
  // OpenCV's Emscripten runtime lives in a shared worker (warmed at app idle):
  // its eval pegged a thread for seconds when it ran on this thread, freezing
  // the tab mid-measurement.
  const motionClient = getWarmOpenCvMotionClient();
  try {
    await abortable(new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("Could not decode reference video"));
    }), signal);
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) await abortable(new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve(); video.onerror = () => reject(new Error("Reference frame unavailable"));
    }), signal);
    if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) throw new Error("Invalid reference video metadata");
    if (!clock?.fps || !clock.fpsSource) throw new Error("Reference FPS is unknown: select a frame clock before extraction");
    const fps = clock.fps;
    const durationFrames = secondsToFrame(clock.durationSeconds ?? video.duration, fps);
    let analyzedDurationFrames = durationFrames;
    if (durationFrames < 1) throw new Error("Reference is shorter than one frame");
    // Analysis never runs at native resolution: the long edge is capped, so a
    // 4K reference costs exactly what a 720p one costs per sampled frame.
    const { width, height } = analysisDimensions(
      video.videoWidth,
      video.videoHeight,
      options.maxAnalysisDimension,
    );
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Canvas 2D is unavailable");
    // Prefer timestamp-verified WebCodecs samples. HTML seeking is only a
    // capability fallback and is never labelled frame-exact.
    const indexed = await abortable(openIndexedVideoFrames(file, width, height), signal).catch((error: unknown) => {
      // A cancelled measurement must not silently degrade to the HTML fallback.
      throwIfAborted(signal);
      if (error instanceof Error && error.name === "AbortError") throw error;
      return null;
    });
    let activeIndexed = indexed;
    const warnings: string[] = !indexed
      ? ["Indexed WebCodecs decoder unavailable: HTML video seeks may not decode exact requested frames. Verify critical cuts manually."]
      : [];
    const readFrame = async (frame: number): Promise<Uint8ClampedArray> => {
      throwIfAborted(signal);
      if (activeIndexed) {
        try {
          const data = await abortable(activeIndexed.read(frame, fps).then((image) => image.data), signal);
          throwIfAborted(signal);
          return maskPersistentCornerOverlays(data, width, height);
        } catch (error) {
          throwIfAborted(signal);
          activeIndexed = null;
          warnings.push(
            `Indexed WebCodecs frame read failed at frame ${frame}; continuing with HTML video seeks, which may not decode exact requested frames. Verify critical cuts manually. ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const target = Math.min(video.duration - 0.001, frameToSeconds(frame, fps) + fps.den / fps.num / 4);
      if (Math.abs(video.currentTime - target) > 0.0001) await abortable(new Promise<void>((resolve, reject) => {
        video.onseeked = () => resolve(); video.onerror = () => reject(new Error("Reference frame seek failed")); video.currentTime = target;
      }), signal);
      ctx.drawImage(video, 0, 0, width, height);
      throwIfAborted(signal);
      return maskPersistentCornerOverlays(ctx.getImageData(0, 0, width, height).data, width, height);
    };
    // An unavailable OpenCV worker does not block extraction: after this short
    // head start, the sparse JS matcher below covers the whole run.
    const motionReady = await abortable(Promise.race([
      motionClient.ready,
      new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), 2500); }),
    ]), signal);
    const stepFrames = indexed && durationFrames <= 600 ? 1 : Math.max(1, Math.ceil(durationFrames / 600), Math.ceil(fps.num / fps.den / 4));
    // One warnings path for decoder precision, sparse sampling and low-confidence cuts.
    if (stepFrames > 1) {
      warnings.push("Long reference sampled at up to 600 positions: rapid cuts between samples may be missed; detected cut candidates are resolved at integer frames.");
    }
    const frames = Math.ceil(durationFrames / stepFrames);
    const shots: ShotProfile[] = [];
    const transitions: ReferenceTransitionEvidence[] = [];
    const effects: ReferenceEffectEvidence[] = [];
    let textDetector: ReturnType<typeof createLocalTextDetector> = null;
    const textObservations: TextObservation[] = [];
    if (options.includeReferenceText) {
      try {
        textDetector = createLocalTextDetector();
        if (!textDetector) warnings.push("Local OCR is unavailable in this browser; reference text overlays were not measured.");
      } catch (error) {
        warnings.push(`Local OCR could not be initialized: ${error instanceof Error ? error.message : String(error)}.`);
      }
    } else {
      warnings.push("Creator-added reference text was excluded; opt in to analyze and reuse its timing and placement.");
    }
    let previous: Uint8ClampedArray | null = null;
    let previousFrame = 0, startFrame = 0, motion: CameraMotionSample[] = [], grade: ShotProfile["colorStats"];
    const finish = (endFrame: number) => {
      if (endFrame <= startFrame) return;
      shots.push({ startFrame, endFrame,
        cameraMotion: { samples: motion, dominantMove: classifyDominantMove(motion) }, colorStats: grade, captionWindows: [] });
      startFrame = endFrame; motion = []; grade = undefined;
    };
    // Progress is coalesced to about 4 notices per second, which still reads as
    // live. Uncoalesced, the store re-rendered the chat panel once per decoded
    // frame, and that render storm was as unresponsive as the pixel work.
    const progress = createReferenceProgressReporter(
      options.onProgress,
      REFERENCE_PROGRESS_INTERVAL_MS,
      now,
    );
    // Work is sliced by wall clock, not by a fixed frame batch: a slice can
    // never grow with the source resolution, and a slow decode ends it at once.
    const budget = createWorkBudget(REFERENCE_FRAME_BUDGET_MS, now());
    let sliceFrames = 0;
    let textDetectionFailures = 0;
    let textDetectionMs = 0;
    const textSampleStride = Math.max(1, Math.ceil(frames / OCR_SAMPLE_BUDGET));
    // Difference inside a cut bracket: bounded work, but a cancelled measurement
    // must not keep scanning frames.
    const guard = (a: Uint8ClampedArray, b: Uint8ClampedArray): number => {
      throwIfAborted(signal);
      return difference(a, b);
    };
    try { for (let i = 0; i < frames; i++) {
      // Prompt cancel before doing any work for the next sample.
      throwIfAborted(signal);
      if (budget.expired(now()) || sliceFrames >= REFERENCE_MAX_FRAMES_PER_SLICE) {
        progress.report(i, frames);
        await yieldToEventLoop();
        // A Stop during the yield wins over the work already queued.
        throwIfAborted(signal);
        budget.reset(now());
        sliceFrames = 0;
      }
      const frame = Math.min(durationFrames - 1, i * stepFrames);
      const pixels = await readFrame(frame);
      if (
        textDetector &&
        i % textSampleStride === 0 &&
        textDetectionFailures < 3 &&
        textDetectionMs < OCR_TOTAL_BUDGET_MS
      ) {
        const detectionStartedAt = now();
        try {
          const blocks = await abortable(withTimeout(
            detectTextInPixels(textDetector, pixels, width, height),
            OCR_FRAME_TIMEOUT_MS,
            "Local OCR sample exceeded its 1s analysis limit.",
          ), signal);
          textObservations.push(...normalizeTextObservations(
            blocks,
            frame,
            Math.min(durationFrames, frame + stepFrames),
            width,
            height,
          ));
        } catch (error) {
          throwIfAborted(signal);
          textDetectionFailures++;
          if (textDetectionFailures === 1) {
            warnings.push(`Local OCR stopped after a detection error: ${error instanceof Error ? error.message : String(error)}.`);
          }
        } finally {
          textDetectionMs += Math.max(0, now() - detectionStartedAt);
        }
      }
      // A sampled frame's grade is measured; each shot keeps the first non-boundary sample.
      const coarseDifference = previous ? difference(previous, pixels) : null;
      if (coarseDifference !== null && (!Number.isFinite(coarseDifference) || coarseDifference < 0)) {
        // Do not promote a corrupt sample to the anchor for the next bracket.
        warnings.push(`Cut candidate ending at frame ${frame} had an invalid coarse difference; no boundary inferred.`);
        continue;
      }
      const cut = coarseDifference !== null && coarseDifference > CUT_DIFFERENCE_THRESHOLD;
      let boundary: number | null = null;
      let transitionType: ReferenceTransitionEvidence["type"] = "unknown";
      let transitionConfidence = 0.45;
      if (cut) {
        try {
          const refined = await refineCutFrameByPeak({
            startFrame: previousFrame, endFrame: frame + 1,
            read: readFrame, difference: guard, threshold: CUT_DIFFERENCE_THRESHOLD,
          });
          boundary = refined.frame;
          transitionType = refined.isHardCut ? "hard-cut" : "unknown";
          transitionConfidence = refined.isHardCut ? 0.9 : 0.55;
          if (!refined.isHardCut) warnings.push(
            `Shot boundary near frame ${refined.frame} looks like a gradual transition (fade/dissolve) rather than a hard cut; boundary position is lower-confidence.`,
          );
        } catch (error) {
          // Cancellation must escape both estimator fallbacks.
          throwIfAborted(signal);
          // Only a malformed numeric measurement gets the conservative retry.
          // Real decoder/seek failures still propagate instead of inventing a cut.
          if (!(error instanceof InvalidCutDifferenceError)) throw error;
          try {
            let checkedFrame = previousFrame;
            boundary = await locateCutFrame(previousFrame, frame, readFrame, (a, b) => {
              checkedFrame++;
              throwIfAborted(signal);
              const value = difference(a, b);
              if (!Number.isFinite(value) || value < 0) throw new InvalidCutDifferenceError(checkedFrame);
              return value;
            }, CUT_DIFFERENCE_THRESHOLD);
            transitionConfidence = boundary === null ? 0 : 0.5;
            warnings.push(boundary === null
              ? `Peak refinement near frame ${frame} had an invalid difference; the first-crossing retry found no verified boundary.`
              : `Peak refinement near frame ${frame} had an invalid difference; using first threshold crossing at frame ${boundary} (lower-confidence).`);
          } catch (retryError) {
            throwIfAborted(signal);
            if (!(retryError instanceof InvalidCutDifferenceError)) throw retryError;
            // A persistently invalid signal cannot support either estimator.
            // Keep shots contiguous, but do not publish a fabricated boundary.
            boundary = null;
            warnings.push(`Cut candidate between frames ${previousFrame} and ${frame} had persistently invalid differences; no boundary inferred.`);
          }
        }
      }
      if (boundary !== null) {
        transitions.push({
          startFrame: Math.max(0, boundary - 1),
          endFrame: Math.min(durationFrames, boundary + 1),
          type: transitionType,
          source: "local-pixel-analysis",
          confidence: transitionConfidence,
          ...(transitionType === "unknown" && {
            note: "A boundary was located, but the available sample evidence does not establish the transition type.",
          }),
        });
        finish(boundary);
      }
      else if (previous) {
        let sample: CameraMotionSample | null = null;
        if (motionReady) {
          sample = await abortable(motionClient.sample({
            prev: previous, curr: pixels, width, height, frame,
            scaleX: video.videoWidth / width, scaleY: video.videoHeight / height,
          }), signal);
        }
        motion.push(sample ?? estimateMotion(previous, pixels, width, height, frame, video.videoWidth / width));
      }
      if (!grade) grade = computeLabStats(excludeMaskedPixels(pixels));
      previous = pixels;
      previousFrame = frame;
      sliceFrames++;
      progress.report(i + 1, frames);
    }
    finish(durationFrames);
    const coarseShotLengths = shots
      .map((shot) => shot.endFrame - shot.startFrame)
      .sort((left, right) => left - right);
    const middle = Math.floor(coarseShotLengths.length / 2);
    const medianShotFrames = coarseShotLengths.length === 0
      ? 0
      : coarseShotLengths.length % 2 === 0
        ? (coarseShotLengths[middle - 1]! + coarseShotLengths[middle]!) / 2
        : coarseShotLengths[middle]!;
    const transitionsBeforeRescan = transitions.length;
    const longShots = shots.filter((shot) =>
      medianShotFrames > 0 &&
      shot.endFrame - shot.startFrame > medianShotFrames * LONG_SHOT_MEDIAN_MULTIPLIER,
    );
    let ffmpegSceneFrames: number[] = [];
    if (longShots.length > 0 && typeof File !== "undefined" && file instanceof File) {
      const bridge = window["kove-advanced"]?.media;
      if (bridge?.detectSceneChanges && bridge.getPathForFile) {
        try {
          const srcPath = bridge.getPathForFile(file);
          if (srcPath) {
            const candidateFrames: number[] = [];
            for (const shot of longShots) {
              const startTimeSeconds = frameToSeconds(shot.startFrame, fps);
              const shotDurationSeconds = frameToSeconds(shot.endFrame - shot.startFrame, fps);
              const streamStartTimeSeconds = clock.videoStartTimeSeconds ?? 0;
              try {
                const sceneTimes = await abortable(
                  bridge.detectSceneChanges({
                    srcPath,
                    threshold: FFMPEG_SCENE_THRESHOLD,
                    startTimeSeconds: streamStartTimeSeconds + startTimeSeconds,
                    durationSeconds: shotDurationSeconds,
                  }),
                  signal,
                );
                candidateFrames.push(...sceneTimesToFrames(sceneTimes, fps, streamStartTimeSeconds)
                  .filter((frame) => frame > shot.startFrame && frame < shot.endFrame));
              } catch (error) {
                throwIfAborted(signal);
                warnings.push(
                  `FFmpeg scene detection failed for long shot ${shot.startFrame}-${shot.endFrame}: ${error instanceof Error ? error.message : String(error)}. Browser rescan evidence may be inexact.`,
                );
              }
            }
            ffmpegSceneFrames = mergeAdjacentSceneFrames(candidateFrames);
          }
        } catch (error) {
          throwIfAborted(signal);
          warnings.push(
            `FFmpeg scene detection failed for long-shot recovery: ${error instanceof Error ? error.message : String(error)}. Browser rescan evidence may be inexact.`,
          );
        }
      }
    }
    let remainingRescanFrames = MAX_LONG_SHOT_RESCAN_FRAMES;
    let rescannedLongShots = 0;
    const rescannedShots: ShotProfile[] = [];
    for (const shot of shots) {
      const shotFrameLength = shot.endFrame - shot.startFrame;
      if (medianShotFrames > 0 && shotFrameLength > medianShotFrames * LONG_SHOT_MEDIAN_MULTIPLIER) {
        const framesToScan = shotFrameLength - 1;
        if (framesToScan > remainingRescanFrames) {
          warnings.push(
            `Long shot ${shot.startFrame}-${shot.endFrame} exceeded the ${MAX_LONG_SHOT_RESCAN_FRAMES}-frame pixel-rescan budget; unmeasured cuts or effects may remain.`,
          );
          const sceneBoundaries = ffmpegSceneFrames.filter(
            (frame) => frame > shot.startFrame && frame < shot.endFrame,
          );
          if (sceneBoundaries.length > 0) {
            const boundaries = [shot.startFrame, ...sceneBoundaries, shot.endFrame];
            for (let index = 0; index < boundaries.length - 1; index++) {
              const startFrame = boundaries[index]!;
              const endFrame = boundaries[index + 1]!;
              rescannedShots.push({
                ...shot,
                startFrame,
                endFrame,
                cameraMotion: shot.cameraMotion
                  ? {
                      ...shot.cameraMotion,
                      samples: shot.cameraMotion.samples.filter(
                        (sample) => sample.frame >= startFrame && sample.frame < endFrame,
                      ),
                    }
                  : undefined,
              });
            }
            for (const boundary of sceneBoundaries) {
              transitions.push({
                startFrame: Math.max(0, boundary - 1),
                endFrame: Math.min(durationFrames, boundary + 1),
                type: "unknown",
                source: "ffmpeg-scene-score",
                confidence: 0.55,
                note: "FFmpeg scene-score event candidate; it may be a cut, flash, or dip. Frame-by-frame pixel verification was skipped due to the rescan budget.",
              });
            }
            rescannedLongShots++;
            continue;
          }
          rescannedShots.push(shot);
          continue;
        }
        let previousPixels = await readFrame(shot.startFrame);
        const lumaSamples = [meanLuma(previousPixels)];
        let beforePreviousPixels: Uint8ClampedArray | null = null;
        const detectedBoundaries = ffmpegSceneFrames.filter(
          (frame) => frame > shot.startFrame && frame < shot.endFrame,
        );
        for (let frame = shot.startFrame + 1; frame < shot.endFrame; frame++) {
          throwIfAborted(signal);
          if (budget.expired(now()) || sliceFrames >= REFERENCE_MAX_FRAMES_PER_SLICE) {
            await yieldToEventLoop();
            throwIfAborted(signal);
            budget.reset(now());
            sliceFrames = 0;
          }
          const currentPixels = await readFrame(frame);
          lumaSamples.push(meanLuma(currentPixels));
          if (difference(previousPixels, currentPixels) > CUT_DIFFERENCE_THRESHOLD && frame + 1 < shot.endFrame) {
            const followingPixels = await readFrame(frame + 1);
            const priorPixels = beforePreviousPixels ?? previousPixels;
            // Require a stable new image across adjacent frames. This avoids
            // treating a one-frame flash as a cut on either its rise or return.
            if (
              difference(priorPixels, currentPixels) > CUT_DIFFERENCE_THRESHOLD &&
              difference(currentPixels, followingPixels) < CUT_DIFFERENCE_THRESHOLD &&
              !detectedBoundaries.some((boundary) => Math.abs(boundary - frame) <= 1)
            ) {
              detectedBoundaries.push(frame);
            }
          }
          beforePreviousPixels = previousPixels;
          previousPixels = currentPixels;
          remainingRescanFrames--;
          sliceFrames++;
        }
        effects.push(...detectTransientLumaEvents(shot.startFrame, lumaSamples, Boolean(activeIndexed)));
        detectedBoundaries.sort((left, right) => left - right);
        if (detectedBoundaries.length > 0) {
          const boundaries = [shot.startFrame, ...detectedBoundaries, shot.endFrame];
          for (let index = 0; index < boundaries.length - 1; index++) {
            const startFrame = boundaries[index]!;
            const endFrame = boundaries[index + 1]!;
            rescannedShots.push({
              ...shot,
              startFrame,
              endFrame,
              cameraMotion: shot.cameraMotion
                ? {
                    ...shot.cameraMotion,
                    samples: shot.cameraMotion.samples.filter(
                      (sample) => sample.frame >= startFrame && sample.frame < endFrame,
                    ),
                  }
                : undefined,
            });
          }
          for (const boundary of detectedBoundaries) {
            const ffmpegDetected = ffmpegSceneFrames.includes(boundary);
            transitions.push({
              startFrame: Math.max(0, boundary - 1),
              endFrame: Math.min(durationFrames, boundary + 1),
              type: ffmpegDetected ? "unknown" : "hard-cut",
              source: ffmpegDetected ? "ffmpeg-scene-score" : "local-pixel-analysis",
              confidence: ffmpegDetected ? 0.55 : activeIndexed ? 0.85 : 0.55,
              note: ffmpegDetected
                ? "FFmpeg scene-score event candidate; it may be a cut, flash, or dip."
                : activeIndexed
                ? "Detected by a frame-by-frame rescan of an unusually long shot."
                : "Detected by a frame-by-frame rescan using HTML seeking; verify because frame accuracy is not guaranteed.",
            });
          }
          rescannedLongShots++;
        } else {
          rescannedShots.push(shot);
        }
      } else {
        rescannedShots.push(shot);
      }
    }
    shots.splice(0, shots.length, ...rescannedShots);
    if (ffmpegSceneFrames.length > 0) {
      const trailingStartFrame = Math.max(0, durationFrames - MAX_TRAILING_RESCAN_FRAMES);
      const trailingLuma: number[] = [];
      for (let frame = trailingStartFrame; frame < durationFrames; frame++) {
        throwIfAborted(signal);
        if (budget.expired(now()) || sliceFrames >= REFERENCE_MAX_FRAMES_PER_SLICE) {
          await yieldToEventLoop();
          throwIfAborted(signal);
          budget.reset(now());
          sliceFrames = 0;
        }
        trailingLuma.push(meanLuma(await readFrame(frame)));
        sliceFrames++;
      }
      const endCardCut = detectTrailingEndCardCut(
        trailingStartFrame,
        trailingLuma,
        durationFrames,
        ffmpegSceneFrames,
      );
      if (endCardCut !== null) {
        analyzedDurationFrames = Math.min(analyzedDurationFrames, endCardCut);
        warnings.push(
          `Trimmed ${durationFrames - endCardCut} trailing non-edit frame(s) after a sustained end-card/black segment.`,
        );
      }
    }
    if (analyzedDurationFrames < durationFrames) {
      const trimmedShots = shots
        .filter((shot) => shot.startFrame < analyzedDurationFrames)
        .map((shot) => ({
          ...shot,
          endFrame: Math.min(shot.endFrame, analyzedDurationFrames),
          cameraMotion: shot.cameraMotion
            ? {
                ...shot.cameraMotion,
                samples: shot.cameraMotion.samples.filter((sample) => sample.frame < analyzedDurationFrames),
              }
            : undefined,
        }));
      shots.splice(0, shots.length, ...trimmedShots);
      for (let index = transitions.length - 1; index >= 0; index--) {
        if (transitions[index]!.endFrame > analyzedDurationFrames) transitions.splice(index, 1);
      }
      for (let index = effects.length - 1; index >= 0; index--) {
        if (effects[index]!.startFrame >= analyzedDurationFrames) effects.splice(index, 1);
        else if (effects[index]!.endFrame > analyzedDurationFrames) {
          effects[index] = { ...effects[index]!, endFrame: analyzedDurationFrames };
        }
      }
      for (let index = textObservations.length - 1; index >= 0; index--) {
        if (textObservations[index]!.frame >= analyzedDurationFrames) textObservations.splice(index, 1);
      }
    }
    if (rescannedLongShots > 0) {
      warnings.push(
        `Long-shot recovery added ${transitions.length - transitionsBeforeRescan} cut(s) from ${rescannedLongShots} unusually long shot(s).`,
      );
    }
    } finally { indexed?.close(); }
    progress.report(frames, frames, { force: true });
    if (textDetector && textDetectionMs >= OCR_TOTAL_BUDGET_MS) {
      warnings.push("Local OCR stopped after reaching its 10s analysis budget; later sampled frames were not checked for text.");
    }
    const profile = createReferenceProfile({
      aspectRatio: { width: video.videoWidth, height: video.videoHeight },
      fps,
      fpsSource: clock.fpsSource,
      durationFrames: analyzedDurationFrames,
      shots,
      beatGridMs: [],
      structure: buildEditorStructure({
        shots,
        styleEvidence: { transitions, textOverlays: [], effects },
        fps,
        durationFrames: analyzedDurationFrames,
      }),
      styleEvidence: {
        transitions,
        textOverlays: mergeTextObservations(
          textObservations,
          analyzedDurationFrames,
          Math.max(1, Math.ceil(fps.num / fps.den)),
        ),
        effects,
      },
      ...(clock.sampleAspectRatio && { sampleAspectRatio: clock.sampleAspectRatio }),
      ...(clock.codedDimensions && { codedDimensions: clock.codedDimensions }),
      ...(clock.rotationDegrees !== undefined && { rotationDegrees: clock.rotationDegrees }),
      warnings,
    });
    return profile;
  } finally { video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
}
function difference(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sum = 0;
  let channels = 0;
  for (let i = 0; i < a.length; i += 16) {
    if (a[i + 3] === 0 || b[i + 3] === 0) continue;
    for (let c = 0; c < 3; c++) {
      sum += Math.abs(a[i + c]! - b[i + c]!);
      channels++;
    }
  }
  return channels > 0 ? sum / (channels * 255) : 0;
}

/** Ignore common platform watermark locations without retaining source pixels. */
export function maskPersistentCornerOverlays(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  const masked = pixels.slice();
  const maskWidth = Math.max(1, Math.ceil(width * 0.16));
  const maskHeight = Math.max(1, Math.ceil(height * 0.12));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inCorner = (x < maskWidth || x >= width - maskWidth) &&
        (y < maskHeight || y >= height - maskHeight);
      if (!inCorner) continue;
      const index = (y * width + x) * 4;
      masked[index] = 0;
      masked[index + 1] = 0;
      masked[index + 2] = 0;
      masked[index + 3] = 0;
    }
  }
  return masked;
}

function excludeMaskedPixels(pixels: Uint8ClampedArray): Uint8ClampedArray {
  let visiblePixels = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] !== 0) visiblePixels++;
  }
  const visible = new Uint8ClampedArray(visiblePixels * 4);
  let outputIndex = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) continue;
    visible.set(pixels.subarray(i, i + 4), outputIndex);
    outputIndex += 4;
  }
  return visible;
}

export function mergeAdjacentSceneFrames(frames: readonly number[]): number[] {
  const sorted = [...new Set(frames.filter((frame) => Number.isSafeInteger(frame) && frame >= 0))]
    .sort((left, right) => left - right);
  const merged: number[] = [];
  let cluster: number[] = [];
  const flush = (): void => {
    if (!cluster.length) return;
    merged.push(Math.round(cluster.reduce((sum, frame) => sum + frame, 0) / cluster.length));
    cluster = [];
  };
  for (const frame of sorted) {
    if (cluster.length && frame - cluster[cluster.length - 1]! > 1) flush();
    cluster.push(frame);
  }
  flush();
  return merged;
}

export function sceneTimesToFrames(
  sceneTimes: readonly number[],
  fps: FrameRate,
  videoStartTimeSeconds = 0,
): number[] {
  if (!Number.isFinite(videoStartTimeSeconds)) {
    throw new RangeError("Video start time must be finite.");
  }
  return mergeAdjacentSceneFrames(
    sceneTimes
      .filter(Number.isFinite)
      .map((time) => secondsToFrame(time - videoStartTimeSeconds, fps)),
  );
}

export function detectTrailingEndCardCut(
  startFrame: number,
  lumaSamples: readonly number[],
  durationFrames: number,
  sceneCandidateFrames: readonly number[],
): number | null {
  const minimumTrailingFrame = Math.floor(durationFrames * 0.7);
  const minimumBlackFrames = 18;
  const blackLumaThreshold = 0.035;
  for (let index = Math.max(1, minimumTrailingFrame - startFrame); index + minimumBlackFrames <= lumaSamples.length; index++) {
    if (lumaSamples[index - 1]! <= blackLumaThreshold || lumaSamples[index]! > blackLumaThreshold) continue;
    let sustainedBlack = true;
    for (let offset = 1; offset < minimumBlackFrames; offset++) {
      if (lumaSamples[index + offset]! > blackLumaThreshold) {
        sustainedBlack = false;
        break;
      }
    }
    if (!sustainedBlack) continue;
    const blackStartFrame = startFrame + index;
    const precedingScene = sceneCandidateFrames
      .filter((frame) => frame <= blackStartFrame && blackStartFrame - frame <= 20)
      .sort((left, right) => right - left)[0];
    return precedingScene ?? null;
  }
  return null;
}

function meanLuma(pixels: Uint8ClampedArray): number {
  let sum = 0;
  let samples = 0;
  for (let i = 0; i < pixels.length; i += 16) {
    if (pixels[i + 3] === 0) continue;
    sum += pixels[i]! * 0.299 + pixels[i + 1]! * 0.587 + pixels[i + 2]! * 0.114;
    samples++;
  }
  return samples > 0 ? sum / (samples * 255) : 0;
}

function detectTransientLumaEvents(
  startFrame: number,
  lumaSamples: readonly number[],
  indexed: boolean,
): ReferenceEffectEvidence[] {
  const events: ReferenceEffectEvidence[] = [];
  for (let beforeIndex = 0; beforeIndex + 2 < lumaSamples.length; beforeIndex++) {
    const baseline = lumaSamples[beforeIndex]!;
    for (let returnIndex = beforeIndex + 2; returnIndex <= Math.min(beforeIndex + 3, lumaSamples.length - 1); returnIndex++) {
      if (Math.abs(lumaSamples[returnIndex]! - baseline) > 0.08) continue;
      let excursion = 0;
      let eventIndex = -1;
      for (let index = beforeIndex + 1; index < returnIndex; index++) {
        const delta = lumaSamples[index]! - baseline;
        if (Math.abs(delta) > Math.abs(excursion)) {
          excursion = delta;
          eventIndex = index;
        }
      }
      if (Math.abs(excursion) < 0.25) continue;
      const start = startFrame + eventIndex;
      const end = startFrame + returnIndex;
      events.push({
        source: "local-pixel-analysis",
        confidence: indexed ? 0.8 : 0.55,
        startFrame: start,
        endFrame: end,
        name: excursion > 0 ? "flash" : "dip",
        parameterEstimates: { brightness: Math.round(Math.max(-100, Math.min(100, excursion * 100))) },
        note: indexed
          ? "Detected as a transient luma excursion that returned to baseline within three frames."
          : "Transient luma event detected using HTML seeking; verify because frame accuracy is not guaranteed.",
      });
      beforeIndex = returnIndex - 1;
      break;
    }
  }
  return events;
}
function estimateMotion(a: Uint8ClampedArray, b: Uint8ClampedArray, w: number, h: number, frame: number, scale: number): CameraMotionSample {
  const points: Array<[number, number, number, number]> = [];
  const luminance = (p: Uint8ClampedArray, x: number, y: number) => {
    const index = (y * w + x) * 4;
    return p[index + 3] === 0
      ? Number.NaN
      : p[index]! * 0.299 + p[index + 1]! * 0.587 + p[index + 2]! * 0.114;
  };
  for (let y = 9; y < h - 9; y += 12) for (let x = 9; x < w - 9; x += 12) {
    let best = Infinity, dxBest = 0, dyBest = 0;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      let error = 0;
      for (let py = -2; py <= 2; py += 2) for (let px = -2; px <= 2; px += 2)
        error += Math.abs(luminance(a, x + px, y + py) - luminance(b, x + dx + px, y + dy + py));
      if (error < best) { best = error; dxBest = dx; dyBest = dy; }
    }
    if (best < 110) points.push([x, y, x + dxBest, y + dyBest]);
  }
  if (points.length < 6) return { frame, translateX: 0, translateY: 0, rotationRad: 0, scale: 1 };
  // Fit partial affine x' = ax - by + tx, y' = bx + ay + ty via centered covariance.
  const mean = (index: number) => points.reduce((sum, p) => sum + p[index], 0) / points.length;
  const mx = mean(0), my = mean(1), nx = mean(2), ny = mean(3);
  let denom = 0, real = 0, imag = 0;
  for (const [x, y, xx, yy] of points) {
    const u = x - mx, v = y - my, U = xx - nx, V = yy - ny;
    denom += u*u + v*v; real += u*U + v*V; imag += u*V - v*U;
  }
  const A = denom ? real / denom : 1, B = denom ? imag / denom : 0;
  return { frame, translateX: (nx - A*mx + B*my) * scale, translateY: (ny - B*mx - A*my) * scale, rotationRad: Math.atan2(B, A), scale: Math.hypot(A, B) };
}

function waitForSourceVideoEvent(
  video: HTMLVideoElement,
  eventName: "loadedmetadata" | "loadeddata" | "seeked",
  timeoutMessage: string,
  readyState = 0,
  signal?: AbortSignal,
  deadline = Date.now() + SOURCE_FRAME_TIMEOUT_MS,
): Promise<void> {
  if (video.readyState >= readyState && readyState > 0) return Promise.resolve();
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timeout);
      video.removeEventListener(eventName, onEvent);
      video.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error): void => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onEvent = (): void => finish();
    const onError = (): void => finish(new Error("Source video could not be decoded"));
    const onAbort = (): void => finish(abortError(signal));
    const timeout = setTimeout(
      () => finish(new Error(timeoutMessage)),
      Math.max(0, deadline - Date.now()),
    );
    video.addEventListener(eventName, onEvent, { once: true });
    video.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** Samples the source in-point to initialize a per-shot Lab LUT. */
export async function sampleVideoStats(
  file: Blob,
  sourceTime = 0.25,
  signal?: AbortSignal,
): Promise<NonNullable<ShotProfile["colorStats"]>> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  const deadline = Date.now() + SOURCE_FRAME_TIMEOUT_MS;
  video.muted = true;
  video.preload = "auto";
  try {
    const metadataLoaded = waitForSourceVideoEvent(
      video,
      "loadedmetadata",
      "Timed out loading source video metadata",
      1,
      signal,
      deadline,
    );
    video.src = url;
    await metadataLoaded;
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error("Source video has invalid duration");
    }

    const time = Math.min(Math.max(0, sourceTime), video.duration / 2);
    if (Math.abs(video.currentTime - time) > 0.005) {
      const seeked = waitForSourceVideoEvent(
        video,
        "seeked",
        "Timed out seeking to the source frame",
        0,
        signal,
        deadline,
      );
      video.currentTime = time;
      await seeked;
    }
    if (video.readyState < 2) {
      await waitForSourceVideoEvent(
        video,
        "loadeddata",
        "Timed out decoding the source frame",
        2,
        signal,
        deadline,
      );
    }
    throwIfAborted(signal);

    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 72;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Canvas unavailable");
    ctx.drawImage(video, 0, 0, 128, 72);
    return computeLabStats(ctx.getImageData(0, 0, 128, 72).data);
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
