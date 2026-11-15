import type {
  NormalizedFrameRect,
  ReferenceTextOverlay,
} from "@kove-advanced/core/mirror/reference-profile";

export interface TextDetectorBlock {
  readonly rawValue?: string;
  readonly boundingBox?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** Normalized 0..1 confidence when the backend exposes one. */
  readonly confidence?: number;
}

interface LocalTextDetector {
  detect(source: ImageBitmap): Promise<readonly TextDetectorBlock[]>;
}

interface TextDetectorConstructor {
  new (): LocalTextDetector;
}

export interface TextObservation {
  readonly frame: number;
  readonly endFrame: number;
  readonly text: string;
  readonly bounds: NormalizedFrameRect;
  readonly confidence?: number;
}

export interface OcrBackend {
  readonly kind: "native" | "wasm";
  detect(pixels: Uint8ClampedArray, width: number, height: number): Promise<readonly TextDetectorBlock[]>;
  dispose(): Promise<void>;
}

export interface OcrBackendOptions {
  readonly assetBaseUrl?: string;
  readonly signal?: AbortSignal;
}

export function createLocalTextDetector(): LocalTextDetector | null {
  const constructor = (globalThis as typeof globalThis & {
    TextDetector?: TextDetectorConstructor;
  }).TextDetector;
  return constructor ? new constructor() : null;
}

export async function createPortableTextDetector(options: OcrBackendOptions = {}): Promise<OcrBackend | null> {
  let native: LocalTextDetector | null = null;
  try {
    native = createLocalTextDetector();
  } catch {
    native = null;
  }
  if (native) {
    return {
      kind: "native",
      detect: (pixels, width, height) => detectTextInPixels(native, pixels, width, height),
      dispose: async () => {},
    };
  }
  try {
    return await createWasmTextDetector(options);
  } catch {
    return null;
  }
}

async function createWasmTextDetector(options: OcrBackendOptions): Promise<OcrBackend> {
  const { createWorker, PSM } = await import("tesseract.js");
  const assetBaseUrl = (
    options.assetBaseUrl ??
    (import.meta.env.VITE_OCR_ASSET_BASE_URL as string | undefined) ??
    "/ocr"
  ).replace(/\/$/, "");
  const worker = await createWorker("eng", 1, {
    workerPath: `${assetBaseUrl}/worker.min.js`,
    corePath: assetBaseUrl,
    langPath: assetBaseUrl,
    gzip: false,
    logger: () => {},
    errorHandler: () => {},
  });
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SPARSE_TEXT,
    preserve_interword_spaces: "1",
  });
  if (options.signal?.aborted) {
    await worker.terminate();
    throw new DOMException("Portable OCR initialization was aborted.", "AbortError");
  }
  return {
    kind: "wasm",
    async detect(pixels, width, height) {
      const canvas = pixelsToCanvas(pixels, width, height);
      const { data } = await worker.recognize(canvas);
      const lines = data.blocks?.flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines)) ?? [];
      return lines.flatMap((line) => {
        const text = line.text.trim();
        const alphanumeric = text.replace(/[^A-Za-z0-9]/g, "").length;
        if (!text || alphanumeric < 2 || line.confidence < 55 || isPlatformChromeText(text)) return [];
        return [{
          rawValue: text,
          boundingBox: {
            x: line.bbox.x0,
            y: line.bbox.y0,
            width: line.bbox.x1 - line.bbox.x0,
            height: line.bbox.y1 - line.bbox.y0,
          },
          confidence: line.confidence / 100,
        }];
      });
    },
    async dispose() {
      await worker.terminate();
    },
  };
}

export async function detectTextInPixels(
  detector: LocalTextDetector,
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<readonly TextDetectorBlock[]> {
  const canvas = pixelsToCanvas(pixels, width, height);
  const bitmap = await createImageBitmap(canvas);
  try {
    return await detector.detect(bitmap);
  } finally {
    bitmap.close();
  }
}

function pixelsToCanvas(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): HTMLCanvasElement | OffscreenCanvas {
  const canvas = typeof OffscreenCanvas === "undefined"
    ? document.createElement("canvas")
    : new OffscreenCanvas(width, height);
  if (canvas instanceof HTMLCanvasElement) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!context) throw new Error("Offscreen canvas 2D context is unavailable for local text detection.");
  const image = context.createImageData(width, height);
  image.data.set(pixels);
  context.putImageData(image, 0, 0);
  return canvas;
}

export function normalizeTextObservations(
  blocks: readonly TextDetectorBlock[],
  frame: number,
  endFrame: number,
  width: number,
  height: number,
): TextObservation[] {
  return blocks.flatMap((block) => {
    const text = block.rawValue?.trim();
    const box = block.boundingBox;
    if (!text || !box || ![box.x, box.y, box.width, box.height].every(Number.isFinite)) return [];
    const x = Math.max(0, box.x / width);
    const y = Math.max(0, box.y / height);
    const right = Math.min(1, (box.x + box.width) / width);
    const bottom = Math.min(1, (box.y + box.height) / height);
    if (right <= x || bottom <= y) return [];
    const confidence = typeof block.confidence === "number" && Number.isFinite(block.confidence)
      ? Math.min(1, Math.max(0, block.confidence))
      : undefined;
    return [{
      frame,
      endFrame,
      text,
      bounds: {
        x: round4(x),
        y: round4(y),
        width: round4(right - x),
        height: round4(bottom - y),
      },
      ...(confidence !== undefined && { confidence }),
    }];
  });
}

export function mergeTextObservations(
  observations: readonly TextObservation[],
  durationFrames: number,
  maxGapFrames: number,
): ReferenceTextOverlay[] {
  const clusters: TextObservation[][] = [];
  for (const observation of [...observations].sort((a, b) => a.frame - b.frame)) {
    const normalizedText = observation.text.toLocaleLowerCase();
    const cluster = clusters.find((candidate) => {
      const last = candidate[candidate.length - 1]!;
      return last.text.toLocaleLowerCase() === normalizedText &&
        observation.frame <= last.endFrame + maxGapFrames &&
        intersectionOverUnion(last.bounds, observation.bounds) >= 0.5;
    });
    if (cluster) cluster.push(observation);
    else clusters.push([observation]);
  }

  return clusters.map((cluster) => {
    const first = cluster[0]!;
    const mergedBounds = cluster.reduce((current, observation) => ({
      x: Math.min(current.x, observation.bounds.x),
      y: Math.min(current.y, observation.bounds.y),
      width: Math.max(current.x + current.width, observation.bounds.x + observation.bounds.width) -
        Math.min(current.x, observation.bounds.x),
      height: Math.max(current.y + current.height, observation.bounds.y + observation.bounds.height) -
        Math.min(current.y, observation.bounds.y),
    }), first.bounds);
    const bounds = {
      x: round4(mergedBounds.x),
      y: round4(mergedBounds.y),
      width: round4(mergedBounds.width),
      height: round4(mergedBounds.height),
    };
    const startFrame = Math.max(0, first.frame);
    const endFrame = Math.min(durationFrames, Math.max(...cluster.map((item) => item.endFrame)));
    const center = bounds.x + bounds.width / 2;
    const measuredConfidence = cluster
      .map((observation) => observation.confidence)
      .filter((value): value is number => value !== undefined);
    const confidence = measuredConfidence.length > 0
      ? round4(measuredConfidence.reduce((sum, value) => sum + value, 0) / measuredConfidence.length)
      : 0.55;
    return {
      startFrame,
      endFrame,
      bounds,
      text: first.text,
      style: {
        fontSizeRatio: round4(bounds.height),
        alignment: center < 0.4 ? "left" as const : center > 0.6 ? "right" as const : "center" as const,
      },
      source: "local-ocr" as const,
      confidence,
      note: "Local text detection is sampled sparsely; bounds, alignment, and relative size are estimates, and the detector does not expose a calibrated confidence score.",
    };
  });
}

const PLATFORM_CHROME_LABELS = /^(tiktok|instagram|youtube|shorts|reels|capcut|full screen)$/i;

/** Platform UI and creator handles are chrome, not editable reference text. */
export function isPlatformChromeText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized.startsWith("@") || normalized.includes("full screen") || PLATFORM_CHROME_LABELS.test(normalized);
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function intersectionOverUnion(a: NormalizedFrameRect, b: NormalizedFrameRect): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const intersection = width * height;
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}
