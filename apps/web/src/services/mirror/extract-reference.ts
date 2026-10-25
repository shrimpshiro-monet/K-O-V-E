import { openIndexedVideoFrames } from "@kove-advanced/core/mirror/decoded-frames";
import { InvalidCutDifferenceError, locateCutFrame, refineCutFrameByPeak } from "@kove-advanced/core/mirror/cut-boundary";
import { frameToSeconds, secondsToFrame, type FrameRate } from "@kove-advanced/core/mirror/timebase";
import { computeLabStats } from "@kove-advanced/core/color/reinhard-transfer";
import { loadOpenCv, extractFrameMotion } from "@kove-advanced/core/vision/opencv-camera-motion";
import { classifyDominantMove, type CameraMotionSample } from "@kove-advanced/core/vision/camera-motion-extractor";
import { createReferenceProfile, type ReferenceProfile, type ShotProfile } from "@kove-advanced/core/mirror/reference-profile";
import {
  abortable,
  analysisDimensions,
  createReferenceProgressReporter,
  createWorkBudget,
  REFERENCE_FRAME_BUDGET_MS,
  REFERENCE_MAX_FRAMES_PER_SLICE,
  REFERENCE_PROGRESS_INTERVAL_MS,
  throwIfAborted,
} from "./reference-measurement";

/** Tuned against the existing normalized, sampled-RGB difference signal.
 * Never reuse this value for luma or another signal without recalibration. */
const CUT_DIFFERENCE_THRESHOLD = 0.23;

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
}

interface YieldingScheduler {
  yield?: () => Promise<void>;
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
 * Cuts use frame difference; camera motion uses sparse patch correspondences + least-squares similarity fit.
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
        if (metadata.fps) return { status: "known", clock: { fps: metadata.fps, fpsSource: "ffprobe", ...(metadata.durationSeconds && { durationSeconds: metadata.durationSeconds }), ...(metadata.sampleAspectRatio && { sampleAspectRatio: metadata.sampleAspectRatio }), codedDimensions: { width: metadata.width, height: metadata.height }, ...(metadata.rotationDegrees !== null && { rotationDegrees: metadata.rotationDegrees }) } };
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
  // WASM backend is lazy and optional. Start the import before metadata and
  // decoder setup so a cold fetch overlaps that work instead of the sample loop.
  const openCvReady = loadOpenCv().catch(() => null);
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
    const readFrame = async (frame: number): Promise<Uint8ClampedArray> => {
      throwIfAborted(signal);
      if (indexed) {
        const data = await abortable(indexed.read(frame, fps).then((image) => image.data), signal);
        throwIfAborted(signal);
        return data;
      }
      const target = Math.min(video.duration - 0.001, frameToSeconds(frame, fps) + fps.den / fps.num / 4);
      if (Math.abs(video.currentTime - target) > 0.0001) await abortable(new Promise<void>((resolve, reject) => {
        video.onseeked = () => resolve(); video.onerror = () => reject(new Error("Reference frame seek failed")); video.currentTime = target;
      }), signal);
      ctx.drawImage(video, 0, 0, width, height);
      throwIfAborted(signal);
      return ctx.getImageData(0, 0, width, height).data;
    };
    // An unavailable OpenCV build does not block extraction: the sparse JS
    // matcher below remains available.
    let cv: Awaited<ReturnType<typeof loadOpenCv>> | null = await abortable(openCvReady, signal);
    let previousMat: InstanceType<NonNullable<typeof cv>["Mat"]> | null = null;
    const stepFrames = indexed && durationFrames <= 600 ? 1 : Math.max(1, Math.ceil(durationFrames / 600), Math.ceil(fps.num / fps.den / 4));
    // One warnings path for decoder precision, sparse sampling and low-confidence cuts.
    const warnings: string[] = !indexed
      ? ["Indexed WebCodecs decoder unavailable: HTML video seeks may not decode exact requested frames. Verify critical cuts manually."]
      : stepFrames > 1
        ? ["Long reference sampled at up to 600 positions: rapid cuts between samples may be missed; detected cut candidates are resolved at integer frames."]
        : [];
    const frames = Math.ceil(durationFrames / stepFrames);
    const shots: ShotProfile[] = [];
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
      // A sampled frame's grade is measured; each shot keeps the first non-boundary sample.
      const coarseDifference = previous ? difference(previous, pixels) : null;
      if (coarseDifference !== null && (!Number.isFinite(coarseDifference) || coarseDifference < 0)) {
        // Do not promote a corrupt sample to the anchor for the next bracket.
        warnings.push(`Cut candidate ending at frame ${frame} had an invalid coarse difference; no boundary inferred.`);
        continue;
      }
      const cut = coarseDifference !== null && coarseDifference > CUT_DIFFERENCE_THRESHOLD;
      let boundary: number | null = null;
      if (cut) {
        try {
          const refined = await refineCutFrameByPeak({
            startFrame: previousFrame, endFrame: frame + 1,
            read: readFrame, difference: guard, threshold: CUT_DIFFERENCE_THRESHOLD,
          });
          boundary = refined.frame;
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
      if (boundary !== null) finish(boundary);
      else if (previous) {
        let sample: CameraMotionSample | null = null;
        if (cv && previousMat) {
          const activeCv = cv;
          const gray = makeGray(activeCv, pixels, width, height);
          try {
            sample = extractFrameMotion(activeCv, previousMat, gray, frame);
            if (sample) { sample.translateX *= video.videoWidth / width; sample.translateY *= video.videoHeight / height; }
          } catch { cv = null; }
          finally { gray.delete(); }
        }
        motion.push(sample ?? estimateMotion(previous, pixels, width, height, frame, video.videoWidth / width));
      }
      previousMat?.delete(); previousMat = cv ? makeGray(cv, pixels, width, height) : null;
      if (!grade) grade = computeLabStats(pixels);
      previous = pixels;
      previousFrame = frame;
      sliceFrames++;
      progress.report(i + 1, frames);
    }
    } finally { previousMat?.delete(); indexed?.close(); }
    progress.report(frames, frames, { force: true });
    finish(durationFrames);
    const profile = createReferenceProfile({ aspectRatio: { width: video.videoWidth, height: video.videoHeight }, fps, fpsSource: clock.fpsSource, durationFrames, shots, beatGridMs: [], ...(clock.sampleAspectRatio && { sampleAspectRatio: clock.sampleAspectRatio }), ...(clock.codedDimensions && { codedDimensions: clock.codedDimensions }), ...(clock.rotationDegrees !== undefined && { rotationDegrees: clock.rotationDegrees }), warnings });
    return profile;
  } finally { video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
}
function makeGray(cv: Awaited<ReturnType<typeof loadOpenCv>>, pixels: Uint8ClampedArray, width: number, height: number) {
  const gray = new cv.Mat(height, width, cv.CV_8UC1);
  for (let i = 0; i < gray.data.length; i++) gray.data[i] = Math.round(pixels[i*4] * 0.299 + pixels[i*4+1] * 0.587 + pixels[i*4+2] * 0.114);
  return gray;
}
function difference(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 16) for (let c = 0; c < 3; c++) sum += Math.abs(a[i + c] - b[i + c]);
  return sum / (Math.ceil(a.length / 16) * 3 * 255);
}
function estimateMotion(a: Uint8ClampedArray, b: Uint8ClampedArray, w: number, h: number, frame: number, scale: number): CameraMotionSample {
  const points: Array<[number, number, number, number]> = [];
  const luminance = (p: Uint8ClampedArray, x: number, y: number) => p[(y * w + x) * 4] * 0.299 + p[(y * w + x) * 4 + 1] * 0.587 + p[(y * w + x) * 4 + 2] * 0.114;
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

/** Samples the source in-point to initialize a per-shot Lab LUT. */
export async function sampleVideoStats(file: Blob, sourceTime = 0.25): Promise<NonNullable<ShotProfile["colorStats"]>> {
  const url = URL.createObjectURL(file), video = document.createElement("video");
  video.muted = true; video.src = url;
  try {
    await new Promise<void>((resolve, reject) => { video.onloadedmetadata = () => resolve(); video.onerror = () => reject(new Error("Video could not be decoded")); });
    const time = Math.min(sourceTime, video.duration / 2);
    if (Math.abs(video.currentTime - time) > 0.005) await new Promise<void>((resolve, reject) => { video.onseeked = () => resolve(); video.onerror = () => reject(new Error("Could not seek source")); video.currentTime = time; });
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) await new Promise<void>((resolve, reject) => { video.onloadeddata = () => resolve(); video.onerror = () => reject(new Error("Source frame unavailable")); });
    const canvas = document.createElement("canvas"); canvas.width = 128; canvas.height = 72;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Canvas unavailable");
    ctx.drawImage(video, 0, 0, 128, 72);
    return computeLabStats(ctx.getImageData(0, 0, 128, 72).data);
  } finally { video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
}
