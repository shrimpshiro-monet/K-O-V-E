export interface VideoStreamMetadata {
  fps: { num: number; den: number } | null;
  durationSeconds: number | null;
  width: number;
  height: number;
  sampleAspectRatio: { num: number; den: number } | null;
  rotationDegrees: number | null;
  /** Average vs nominal mismatch is VFR: do not pretend the source has one frame clock. */
  variableFrameRate: boolean;
}

function rational(value: unknown, separator: string): { num: number; den: number } | null {
  if (typeof value !== "string") return null;
  const match = new RegExp(`^(\\d+)${separator}(\\d+)$`).exec(value);
  if (!match) return null;
  const num = Number(match[1]), den = Number(match[2]);
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0) return null;
  let a = num, b = den;
  while (b) [a, b] = [b, a % b];
  return { num: num / a, den: den / a };
}

/** Parse only ffprobe JSON stream/container fields; no guessed FPS from packet count. */
export function parseVideoProbe(json: string): VideoStreamMetadata {
  const data = JSON.parse(json) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  const stream = data.streams?.find((item) => item.codec_type === "video");
  if (!stream) throw new Error("No video stream in reference");
  const avg = rational(stream.avg_frame_rate, "/");
  const nominal = rational(stream.r_frame_rate, "/");
  const variableFrameRate = Boolean(avg && nominal && avg.num * nominal.den !== nominal.num * avg.den);
  const fps = avg && !variableFrameRate && avg.num / avg.den >= 1 && avg.num / avg.den <= 240 ? avg : null;
  const streamDuration = Number(stream.duration);
  const containerDuration = Number(data.format?.duration);
  const durationSeconds = Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : containerDuration;
  const rotation = (stream.side_data_list as Array<Record<string, unknown>> | undefined)?.find((item) => item.rotation !== undefined)?.rotation ?? (stream.tags as Record<string, unknown> | undefined)?.rotate;
  const rotationDegrees = rotation === undefined || rotation === null ? null : Number(rotation);
  return {
    fps,
    durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null,
    width: Number(stream.width), height: Number(stream.height),
    sampleAspectRatio: rational(stream.sample_aspect_ratio, ":"),
    rotationDegrees: rotationDegrees !== null && Number.isFinite(rotationDegrees) ? rotationDegrees : null,
    variableFrameRate,
  };
}
