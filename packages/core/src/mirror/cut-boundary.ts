/** Resolve a coarse cut candidate by reading every integer source frame between
 * samples. A decoder must actually return the requested frame; HTML video seeks
 * cannot guarantee that, so browser results are labelled best-effort. */
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
