/**
 * Scheduling policy for local reference measurement.
 *
 * Measuring a reference is the one part of the editor that touches every
 * sampled frame of a user-supplied file, so its cost must be bounded by policy
 * rather than by the resolution of that file. This module owns the three
 * bounds the sampler relies on:
 *
 * 1. a resolution cap on the analysis buffer (a 4K source is analysed at the
 *    same bounded size as a 1080p one),
 * 2. a wall-clock work budget per slice, so a slice can never grow with the
 *    number of frames — the sampler yields between slices,
 * 3. a progress throttle, so progress notices repaint at a human rate instead
 *    of once per decoded frame (which floods the store and starves paint).
 *
 * Everything here is pure and DOM-free so the policy itself is unit-testable.
 */

/**
 * Longest edge of the analysis buffer. Measurement only needs enough detail to
 * compare adjacent frames and to fit a similarity transform, so analysis never
 * happens at native resolution: a 4K frame is 3840x2160 at the source and at
 * most 160x90 here. The cut-difference threshold in `extract-reference.ts` is
 * calibrated on frames at this scale, so do not raise it without recalibrating.
 */
export const REFERENCE_ANALYSIS_MAX_DIMENSION = 160;

/**
 * Work a single synchronous slice may do before it must yield to the event
 * loop. One frame of analysis costs well under this at the bounded analysis
 * size, so a slice is "up to one frame" — never a resolution- or
 * frame-count-proportional batch. 8ms keeps a yielded tab comfortably inside
 * a 60Hz frame budget.
 */
export const REFERENCE_FRAME_BUDGET_MS = 8;

/**
 * Hard cap on frames per slice, independent of the time budget. Sub-millisecond
 * slices (cached decodes, synthetic media in tests) would otherwise never trip
 * the clock, and the tab must still get a turn between slices.
 */
export const REFERENCE_MAX_FRAMES_PER_SLICE = 8;

/**
 * Minimum spacing between progress notices: 4 updates per second, which is the
 * slowest rate that still reads as live progress while leaving the main thread
 * to paint and to handle a Stop click.
 */
export const REFERENCE_PROGRESS_INTERVAL_MS = 250;

/** Analysis buffer size, capped on the long edge and kept even. */
export interface AnalysisDimensions {
  readonly width: number;
  readonly height: number;
}

function evenDimension(value: number): number {
  return Math.max(16, Math.round(value / 2) * 2);
}

/**
 * Chooses the bounded analysis buffer for a source frame.
 *
 * Never returns dimensions derived from the full-resolution frame: the long
 * edge is capped at `maxDimension`, so the per-frame cost of grayscale
 * conversion, frame differencing and the block matcher is constant regardless
 * of whether the reference is 720p or 4K.
 */
export function analysisDimensions(
  sourceWidth: number,
  sourceHeight: number,
  maxDimension: number = REFERENCE_ANALYSIS_MAX_DIMENSION,
): AnalysisDimensions {
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    throw new RangeError(`analysisDimensions: invalid source frame ${sourceWidth}x${sourceHeight}`);
  }
  if (!Number.isFinite(maxDimension) || maxDimension < 16) {
    throw new RangeError(`analysisDimensions: invalid max dimension ${maxDimension}`);
  }
  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
  return {
    width: evenDimension(sourceWidth * scale),
    height: evenDimension(sourceHeight * scale),
  };
}

/** A time slice that is spent after `budgetMs` of wall clock. */
export interface WorkBudget {
  readonly budgetMs: number;
  /** True when the current slice has spent its budget and must yield. */
  expired(nowMs: number): boolean;
  /** Starts a new slice at `nowMs`. */
  reset(nowMs: number): void;
}

/**
 * Wall-clock work budget. Unlike a frames-per-batch counter, this bounds the
 * main thread by time: a cheap frame keeps the slice going, an expensive one
 * (a 4K decode drawn into the analysis canvas) stops the slice immediately, so
 * no single batch can block the tab for seconds.
 */
export function createWorkBudget(
  budgetMs: number = REFERENCE_FRAME_BUDGET_MS,
  startedAtMs: number = 0,
): WorkBudget {
  const limit = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : REFERENCE_FRAME_BUDGET_MS;
  let sliceStart = startedAtMs;
  return {
    budgetMs: limit,
    expired(nowMs: number) {
      return nowMs - sliceStart >= limit;
    },
    reset(nowMs: number) {
      sliceStart = nowMs;
    },
  };
}

/** Throttled, monotonic progress notices. */
export interface ReferenceProgressReporter {
  /** Reports `done` of `total` samples; the final report should be forced. */
  report(done: number, total: number, options?: { force?: boolean }): void;
  /** Samples reported so far (never decreases). */
  readonly reported: number;
}

/**
 * Coalesces sample progress into at most one notice per `intervalMs`.
 *
 * The first report and any forced (final) report are emitted immediately, so a
 * caller always sees the start and the completion of the measurement; the
 * reports in between keep moving at >= 4/s without re-rendering the chat panel
 * once per decoded frame.
 */
export function createReferenceProgressReporter(
  onProgress: ((done: number, total: number) => void) | undefined,
  intervalMs: number = REFERENCE_PROGRESS_INTERVAL_MS,
  now: () => number = () => Date.now(),
): ReferenceProgressReporter {
  const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : REFERENCE_PROGRESS_INTERVAL_MS;
  let lastEmittedAt = Number.NEGATIVE_INFINITY;
  let reported = 0;
  return {
    get reported() {
      return reported;
    },
    report(done, total, options = {}) {
      if (!onProgress) {
        reported = Math.max(reported, done);
        return;
      }
      const value = Math.max(reported, done);
      const at = now();
      if (!options.force && value === reported && reported > 0) return;
      if (!options.force && at - lastEmittedAt < interval && reported > 0) return;
      reported = value;
      lastEmittedAt = at;
      onProgress(value, total);
    },
  };
}

/**
 * The error a cancelled measurement rejects with.
 *
 * Normalized to an `Error` named `AbortError` whatever the signal carries: a
 * `DOMException` from `controller.abort()`, a plain reason string, or an
 * arbitrary reason object. Callers can therefore use `isAbortError` without
 * caring which runtime produced the cancellation.
 */
export function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason as unknown;
  const custom =
    typeof reason === "string"
      ? reason.trim()
      : reason instanceof Error
        ? reason.message.trim()
        : "";
  const message =
    custom && custom !== "signal is aborted without reason"
      ? custom
      : "Reference measurement was cancelled";
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/** True for cancellation, including the DOMException an AbortSignal produces. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Throws the signal's abort reason when the measurement has been cancelled. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

/**
 * Settles `promise` early when `signal` aborts.
 *
 * A decoder seek or a `getCanvas` call can take seconds on a 4K file and never
 * settle after cancellation; without this race the awaiting measurement would
 * stay pending forever — a zombie loop that keeps the turn wedged even though
 * the user pressed Stop.
 */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    // The caller still owns the underlying promise; swallow its settlement so
    // a late rejection cannot surface as an unhandled rejection.
    promise.catch(() => undefined);
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
