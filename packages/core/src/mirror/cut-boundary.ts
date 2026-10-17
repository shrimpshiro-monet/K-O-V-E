/** Resolve a coarse cut candidate by reading every integer source frame between
 * samples. A decoder must actually return the requested frame; HTML video seeks
 * cannot guarantee that, so browser results are labelled best-effort.
 * @deprecated for shot-boundary selection: returns the FIRST threshold crossing,
 * not the strongest one. Retained for callers needing first-crossing semantics;
 * use refineCutFrameByPeak to select a shot boundary. */
export async function locateCutFrame<T>(
  previousFrame: number,
  currentFrame: number,
  read: (frame: number) => Promise<T>,
  difference: (a: T, b: T) => number,
  threshold: number,
): Promise<number | null> {
  if (!Number.isSafeInteger(previousFrame) || !Number.isSafeInteger(currentFrame) || previousFrame < 0 || currentFrame <= previousFrame) throw new Error("Invalid frame search interval");
  let previous = await read(previousFrame);
  for (let frame = previousFrame + 1; frame <= currentFrame; frame++) {
    const next = await read(frame);
    if (difference(previous, next) > threshold) return frame;
    previous = next;
  }
  // The coarse difference was cumulative motion, not a hard cut.
  return null;
}

/** A malformed measurement, not a decoder/read failure. Callers may retry with
 * a conservative strategy, but must never use this value as a peak. */
export class InvalidCutDifferenceError extends Error {
  constructor(frame: number) {
    super(`refineCutFrameByPeak: difference at frame ${frame} must be finite and nonnegative`);
    this.name = "InvalidCutDifferenceError";
  }
}

export interface PeakRefinementOptions<T> {
  /** Inclusive anchor frame of the candidate bracket. */
  startFrame: number;
  /** Exclusive end of the bracket (the former currentFrame + 1). */
  endFrame: number;
  read: (frame: number) => Promise<T>;
  difference: (a: T, b: T) => number;
  /** Threshold on the existing adjacent-frame difference signal. */
  threshold: number;
}

export interface PeakRefinementResult {
  /** Index of the frame AFTER the strongest adjacent-frame difference. */
  frame: number;
  peakDifference: number;
  /** False when a wide coarse crossing contained no adjacent hard cut. */
  isHardCut: boolean;
}

/** Scan EVERY adjacent pair in [startFrame, endFrame), rather than stopping at
 * the first crossing. Ties choose the earliest frame. For the existing
 * locateCutFrame(previousFrame, currentFrame) bracket, use endFrame = currentFrame + 1.
 * At most one boundary is returned; two distinct cuts in one bracket remain
 * an acknowledged detection limitation. */
export async function refineCutFrameByPeak<T>(
  options: PeakRefinementOptions<T>,
): Promise<PeakRefinementResult> {
  const { startFrame, endFrame, read, difference, threshold } = options;
  if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame) ||
      startFrame < 0 || endFrame <= startFrame + 1 ||
      !Number.isFinite(threshold) || threshold < 0) {
    throw new Error(`refineCutFrameByPeak: invalid bracket [${startFrame}, ${endFrame}) or threshold`);
  }
  let previous = await read(startFrame);
  let bestFrame = startFrame + 1;
  let bestDifference = -Infinity;
  for (let frame = startFrame + 1; frame < endFrame; frame++) {
    const current = await read(frame);
    const value = difference(previous, current);
    if (!Number.isFinite(value) || value < 0) throw new InvalidCutDifferenceError(frame);
    if (value > bestDifference) {
      bestDifference = value;
      bestFrame = frame;
    }
    previous = current;
  }
  return { frame: bestFrame, peakDifference: bestDifference, isHardCut: bestDifference > threshold };
}
