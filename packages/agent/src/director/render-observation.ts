import type {
  EditPlan,
  PlannedSegment,
  RenderedFrameObservation,
} from "@kove-advanced/creation-schema";
import { computePlanPlacement } from "@kove-advanced/creation-schema";
import type { EditingHost, TimelineFrame } from "../host";
import type { DirectorFrameImage } from "../turn-context";

/**
 * Rendered-draft sampling for the director.
 *
 * After a plan_edit commit, we render a small, spread selection of timeline
 * instants through the host's real `renderTimelineFrame` capability and
 * measure the decoded pixels (luminance / texture gradients). The
 * measurements feed `reviewRenderedDraft` from creation-schema. A host
 * without the capability yields NO data — never a synthetic score.
 *
 * Pixel decoding uses fetch + ImageBitmap + OffscreenCanvas: browser hosts.
 * In pure Node (tests, headless runs) decoding is unavailable and the
 * sampler reports nothing instead of failing loudly.
 */

/** Max rendered frames sampled per review pass (same budget class as extract previews). */
export const MAX_RENDER_SAMPLE_TIMES = 8;

/** Seconds after the opening position: skips a pure fade-from-black start. */
const OPENING_OFFSET_SECONDS = 0.15;

export interface RenderedDraftSampling {
  /** Timeline instants rendered (deduped, sorted). */
  readonly sampleTimes: readonly number[];
  /** Per-instant measurements, indexed like `sampleTimes`. */
  readonly observations: readonly RenderedFrameObservation[];
  /** Rendered thumbnails (for the rendered-repair pass / UI surfacing). */
  readonly frames: readonly DirectorFrameImage[];
}

function segmentPlacedDuration(segment: PlannedSegment): number {
  const source = Math.max(0, segment.sourceEndTime - segment.sourceStartTime);
  const speed =
    typeof segment.speed === "number" && Number.isFinite(segment.speed) && segment.speed > 0
      ? segment.speed
      : 1;
  return source / speed;
}

/**
 * Choose which timeline instants to render: the opening, the middle of every
 * segment (catches gaps / black frames / badly placed shots), the middle of
 * each text overlay window (catches unreadable text), and the first moments
 * after a transition junction (catches wrong-side placement). Priority order
 * beats spread when the budget forces a cut.
 */
export function computeRenderSampleTimes(plan: EditPlan, placement: readonly number[]): number[] {
  type Candidate = { readonly time: number; readonly priority: number };
  const candidates: Candidate[] = [];
  const push = (time: number, priority: number): void => {
    if (Number.isFinite(time)) candidates.push({ time: Math.max(0, time), priority });
  };

  const placed = plan.segments.map(segmentPlacedDuration);

  if (placed.length > 0) {
    push((placement[0] ?? 0) + Math.min(OPENING_OFFSET_SECONDS, (placed[0] ?? 1) / 4), 0);
  }
  placed.forEach((duration, index) => {
    push((placement[index] ?? 0) + duration / 2, 1);
  });

  // Text overlays: sample the middle of each window, where the text has
  // settled (in-animation done, out-animation not started).
  plan.textElements.forEach((text) => {
    const duration = typeof text.duration === "number" && text.duration > 0 ? text.duration : 0;
    if (duration > 0) push(text.startTime + duration / 2, 2);
  });

  // Junction posts: just after a transition should have blended into the
  // incoming shot.
  plan.transitions.forEach((transition) => {
    const index = transition.afterSegmentIndex + 1;
    if (index < plan.segments.length) {
      push((placement[index] ?? 0) + Math.min(0.25, (placed[index] ?? 1) / 4), 2);
    }
  });

  const byPriority = new Map<number, Candidate[]>();
  for (const candidate of candidates) {
    const bucket = byPriority.get(candidate.priority) ?? [];
    bucket.push(candidate);
    byPriority.set(candidate.priority, bucket);
  }
  const kept: Candidate[] = [];
  for (let priority = 0; priority <= 2 && kept.length < MAX_RENDER_SAMPLE_TIMES; priority += 1) {
    const bucket = byPriority.get(priority) ?? [];
    const remaining = MAX_RENDER_SAMPLE_TIMES - kept.length;
    if (bucket.length <= remaining) {
      kept.push(...bucket);
    } else {
      for (let i = 0; i < remaining; i += 1) {
        const pick =
          remaining === 1
            ? bucket[Math.round((bucket.length - 1) / 2)]
            : bucket[Math.round((i * (bucket.length - 1)) / (remaining - 1))];
        if (pick) kept.push(pick);
      }
    }
  }

  const unique = [...new Set(kept.map((entry) => entry.time))];
  return unique.sort((a, b) => a - b).slice(0, MAX_RENDER_SAMPLE_TIMES);
}

/** The overlay on screen at `time`, with its explicit position when stated. */
function activeTextAt(plan: EditPlan, time: number): { x: number; y: number } | undefined {
  const overlay = plan.textElements.find(
    (text) => time >= text.startTime && time <= text.startTime + Math.max(0, text.duration ?? 0),
  );
  if (!overlay) return undefined;
  const position = overlay.position as { x?: unknown; y?: unknown } | undefined;
  const x = typeof position?.x === "number" && Number.isFinite(position.x) ? position.x : undefined;
  const y = typeof position?.y === "number" && Number.isFinite(position.y) ? position.y : undefined;
  // Only trust explicit positions; overshooting a guessed position punishes
  // frames that are fine.
  return x !== undefined && y !== undefined ? { x, y } : undefined;
}

/** Luma plane extracted from RGBA pixel data. */
function lumaPlane(pixels: Uint8ClampedArray, count: number): Float32Array {
  const luma = new Float32Array(count);
  for (let i = 0, p = 0; p < count; i += 4, p += 1) {
    luma[p] = (0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]) / 255;
  }
  return luma;
}

function meanLaplacian(
  luma: Float32Array,
  width: number,
  height: number,
  step = 2,
  region?: { x0: number; y0: number; x1: number; y1: number },
): number {
  const x0 = region?.x0 ?? 1;
  const y0 = region?.y0 ?? 1;
  const x1 = region?.x1 ?? width - 1;
  const y1 = region?.y1 ?? height - 1;
  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const c = luma[y * width + x];
      sum += Math.abs(
        4 * c -
          luma[y * width + (x - 1)] -
          luma[y * width + (x + 1)] -
          luma[(y - 1) * width + x] -
          luma[(y + 1) * width + x],
      );
      count += 1;
    }
  }
  return count > 0 ? sum / count : 0;
}

interface FrameChannels {
  readonly meanLuma: number;
  readonly stddevLuma: number;
  readonly sharpness: number;
  readonly textureCoverage: number;
  readonly textPatchContrast: number;
}

/** Downsampled gradient statistics for one rendered frame. */
function channelsFromLuma(luma: Float32Array, width: number, height: number): FrameChannels {
  let sum = 0;
  for (let p = 0; p < luma.length; p += 1) sum += luma[p];
  const mean = luma.length > 0 ? sum / luma.length : 0;
  let variance = 0;
  for (let p = 0; p < luma.length; p += 1) {
    const d = luma[p] - mean;
    variance += d * d;
  }
  const stddev = luma.length > 0 ? Math.sqrt(variance / luma.length) : 0;

  const meanLap = meanLaplacian(luma, width, height, 2);

  // Aggregate gradient energy into 4x4 cells; "textured" cells are what a
  // real subject looks like, vs a flat/failed render.
  const cellEdge = 4;
  const cols = Math.max(1, Math.floor(width / cellEdge));
  const rows = Math.max(1, Math.floor(height / cellEdge));
  let textured = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const cellLap = meanLaplacian(luma, width, height, 2, {
        x0: Math.max(1, col * cellEdge),
        y0: Math.max(1, row * cellEdge),
        x1: Math.max(2, Math.min(width - 1, (col + 1) * cellEdge)),
        y1: Math.max(2, Math.min(height - 1, (row + 1) * cellEdge)),
      });
      if (cellLap > 0.015) textured += 1;
    }
  }
  const textureCoverage = Math.max(0, Math.min(1, (textured / (cols * rows)) * 2.2));

  // Text patch: contrast where the overlay should be (center patch covers
  // typical title/lower-third footprints).
  const patchWidth = Math.max(8, Math.floor(width * 0.36));
  const patchHeight = Math.max(4, Math.floor(height * 0.12));
  const centerX = Math.floor(width * 0.5);
  const centerY = Math.floor(height * 0.5);
  const textPatchContrast = meanLaplacian(luma, width, height, 1, {
    x0: Math.max(1, centerX - Math.floor(patchWidth / 2)),
    y0: Math.max(1, centerY - Math.floor(patchHeight / 2)),
    x1: Math.max(2, Math.min(width - 1, centerX + Math.floor(patchWidth / 2))),
    y1: Math.max(2, Math.min(height - 1, centerY + Math.floor(patchHeight / 2))),
  });

  return { meanLuma: mean, stddevLuma: stddev, sharpness: clamp01(meanLap / 0.08), textureCoverage, textPatchContrast };
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

async function decodeFramebuffer(dataUrl: string): Promise<{ pixels: Uint8ClampedArray; width: number; height: number } | undefined> {
  const scope = globalThis as {
    fetch?: typeof fetch;
    createImageBitmap?: (image: Blob | ImageBitmapSource) => Promise<ImageBitmap>;
    OffscreenCanvas?: typeof OffscreenCanvas;
  };
  if (typeof scope.fetch !== "function" || typeof scope.createImageBitmap !== "function" || typeof scope.OffscreenCanvas !== "function") {
    return undefined;
  }
  try {
    const response = await scope.fetch(dataUrl);
    const blob = await response.blob();
    const bitmap = await scope.createImageBitmap(blob);
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = longest > 0 ? Math.min(1, 256 / longest) : 1;
    const width = Math.max(8, Math.floor(bitmap.width * scale));
    const height = Math.max(8, Math.floor(bitmap.height * scale));
    const canvas = new scope.OffscreenCanvas!(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return undefined;
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    return { pixels: ctx.getImageData(0, 0, width, height).data, width, height };
  } catch {
    return undefined;
  }
}

/**
 * Decode ONE rendered jpeg/png and measure it. Returns undefined when the
 * environment cannot decode images (Node) — the caller then simply reports
 * fewer/no observations instead of inventing metrics.
 */
async function measureRenderedFrame(
  dataUrl: string,
  overlayPosition: { x: number; y: number } | undefined,
): Promise<Omit<RenderedFrameObservation, "timestamp"> | undefined> {
  const framebuffer = await decodeFramebuffer(dataUrl);
  if (!framebuffer) return undefined;
  const luma = lumaPlane(framebuffer.pixels, framebuffer.width * framebuffer.height);
  const channels = channelsFromLuma(luma, framebuffer.width, framebuffer.height);
  const textLegibility =
    overlayPosition
      ? clamp01(
          meanLaplacian(luma, framebuffer.width, framebuffer.height, 1, {
            x0: Math.max(1, Math.floor(overlayPosition.x * framebuffer.width) - Math.floor(framebuffer.width * 0.18)),
            x1: Math.max(2, Math.floor(overlayPosition.x * framebuffer.width) + Math.floor(framebuffer.width * 0.18)),
            y0: Math.max(1, Math.floor(overlayPosition.y * framebuffer.height) - Math.floor(framebuffer.height * 0.06)),
            y1: Math.max(2, Math.floor(overlayPosition.y * framebuffer.height) + Math.floor(framebuffer.height * 0.06)),
          }) / 0.06,
        )
      : 1;
  return {
    sharpness: channels.sharpness,
    subjectVisibility: channels.textureCoverage,
    textLegibility,
    hasBlackFrame: channels.meanLuma < 0.06 && channels.stddevLuma < 0.035,
  };
}

/**
 * Render + measure sample instants for `plan`. Returns undefined when the
 * host cannot render timeline frames; callers must report "unavailable"
 * honestly instead of inventing a score.
 */
export async function sampleRenderedDraft(
  host: EditingHost,
  plan: EditPlan,
): Promise<RenderedDraftSampling | undefined> {
  if (host.features?.().renderTimelineFrame !== true || typeof host.renderTimelineFrame !== "function") {
    return undefined;
  }

  let placement: readonly number[];
  try {
    placement = computePlanPlacement(plan);
  } catch {
    placement = plan.segments.map((_, index) => index);
  }

  const sampleTimes = computeRenderSampleTimes(plan, placement);
  if (sampleTimes.length === 0) return undefined;

  const frames: DirectorFrameImage[] = [];
  const observations: RenderedFrameObservation[] = [];
  for (const time of sampleTimes) {
    let frame: TimelineFrame | { readonly code: "unsupported_host"; readonly error: string };
    try {
      frame = await host.renderTimelineFrame({ time, maxDimension: 512, format: "jpeg" });
    } catch {
      continue;
    }
    if (!("dataUrl" in frame)) continue;
    const measured = await measureRenderedFrame(frame.dataUrl, activeTextAt(plan, time));
    if (!measured) continue;
    frames.push({
      videoId: "rendered-timeline",
      timestamp: time,
      dataUrl: frame.dataUrl,
      width: frame.width,
      height: frame.height,
    });
    observations.push({
      timestamp: time,
      sharpness: measured.sharpness,
      subjectVisibility: measured.subjectVisibility,
      textLegibility: measured.textLegibility,
      hasBlackFrame: measured.hasBlackFrame,
    });
  }

  if (frames.length === 0) return undefined;
  return { sampleTimes, observations, frames };
}
