/** The EditDNA clock is a reduced rational number of frames per second. */
export interface FrameRate { num: number; den: number }

export function frameRate(num: number, den: number): FrameRate {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0 || num / den > 1000) {
    throw new Error("Invalid rational frame rate");
  }
  let a = num, b = den;
  while (b) [a, b] = [b, a % b];
  return { num: num / a, den: den / a };
}

export function frameToSeconds(frame: number, fps: FrameRate): number {
  frameRate(fps.num, fps.den);
  if (!Number.isSafeInteger(frame) || frame < 0) throw new Error("Frame must be a nonnegative safe integer");
  return frame * (fps.den / fps.num);
}

/** Quantize once at the media/timeline boundary. Never accumulate rounded milliseconds. */
export function secondsToFrame(seconds: number, fps: FrameRate, rounding: "nearest" | "floor" | "ceil" = "nearest"): number {
  frameRate(fps.num, fps.den);
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Time must be finite and nonnegative");
  const raw = seconds * fps.num / fps.den;
  const result = rounding === "floor" ? Math.floor(raw + 1e-9) : rounding === "ceil" ? Math.ceil(raw - 1e-9) : Math.round(raw);
  if (!Number.isSafeInteger(result)) throw new Error("Frame index exceeds safe integer range");
  return result;
}

export const shotDurationFrames = (shot: { startFrame: number; endFrame: number }): number => shot.endFrame - shot.startFrame;
export function shotSampleFrame(shot: { startFrame: number; endFrame: number }): number {
  return shot.startFrame + Math.floor((shot.endFrame - shot.startFrame - 1) / 2);
}
