import { frameRate, type FrameRate } from "./timebase";

/** A frame clock measured from the reference file itself, not guessed by the user. */
export interface ReferenceClockProbe {
  /** The measured frame clock, snapped to a real rate (30/1, 30000/1001, …). */
  readonly fps: FrameRate;
  readonly durationSeconds: number;
  readonly width: number;
  readonly height: number;
  readonly rotationDegrees: number;
  /** The raw measured packet rate, kept so a non-CFR source stays visible. */
  readonly averagePacketRate: number;
}

/**
 * Rates that actually occur in camera and platform footage. A measured
 * packet rate is snapped onto one of these so the EditDNA clock stays a
 * reduced rational instead of a float that no encoder will ever match.
 */
const COMMON_FRAME_RATES: readonly FrameRate[] = [
  { num: 24000, den: 1001 },
  { num: 24, den: 1 },
  { num: 25, den: 1 },
  { num: 30000, den: 1001 },
  { num: 30, den: 1 },
  { num: 48, den: 1 },
  { num: 50, den: 1 },
  { num: 60000, den: 1001 },
  { num: 60, den: 1 },
  { num: 120, den: 1 },
];

/** How far a measured rate may sit from a standard rate and still count as it. */
const RATE_MATCH_TOLERANCE = 0.002;

/**
 * Snaps a measured packet rate onto a real frame clock. Returns null when the
 * measurement is unusable (empty file, undecodable track).
 */
export function snapFrameRate(rate: number): FrameRate | null {
  if (!Number.isFinite(rate) || rate <= 0) return null;
  let best: FrameRate | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const candidate of COMMON_FRAME_RATES) {
    const value = candidate.num / candidate.den;
    const delta = Math.abs(value - rate) / value;
    if (delta < bestDelta) {
      bestDelta = delta;
      best = candidate;
    }
  }
  if (best && bestDelta <= RATE_MATCH_TOLERANCE) return frameRate(best.num, best.den);
  // Not a standard rate: keep the measurement as an exact rational so the
  // value still round-trips instead of drifting into an unrepresentable float.
  const milli = Math.max(1, Math.round(rate * 1000));
  return frameRate(milli, 1000);
}

/**
 * Reads the reference's frame clock, duration and dimensions straight out of
 * the container. The browser cannot probe a frame rate from an HTMLVideoElement
 * and the desktop ffprobe bridge does not exist in the web build, so this is
 * what lets the user attach a reference without typing 30/1 by hand.
 */
export async function probeReferenceClock(file: Blob): Promise<ReferenceClockProbe> {
  const { ALL_FORMATS, BlobSource, Input } = await import("mediabunny");
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("The reference has no video track");
    const stats = await track.computePacketStats();
    const fps = snapFrameRate(stats.averagePacketRate);
    if (!fps) throw new Error("The reference's frame rate could not be measured");
    return {
      fps,
      durationSeconds: await track.computeDuration(),
      width: track.displayWidth,
      height: track.displayHeight,
      rotationDegrees: track.rotation,
      averagePacketRate: stats.averagePacketRate,
    };
  } finally {
    input.dispose();
  }
}
