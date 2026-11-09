/**
 * Test-only pixel-decode shim for `renderTimelineFrame` review paths.
 *
 * `sampleRenderedDraft` decodes rendered frames with fetch + ImageBitmap +
 * OffscreenCanvas — browser-only APIs. In Node the decoder reports
 * "unavailable" and reviews honestly report nothing. This shim polyfills the
 * three globals so the REAL measurement code (luma, gradients, coverage)
 * runs over synthetic pixels: each `renderTimelineFrame` data URL carries a
 * base64 JSON pattern; the shim turns it back into a pixel buffer.
 *
 * Without an image codec dependency, this decouples "what pixels to measure"
 * from "how they were encoded" — tests exercise the measurement pipeline,
 * not JPEG decoding.
 */

export type PixelPattern = "black" | "flat" | "noise";

export interface PixelSpec {
  readonly pattern: PixelPattern;
  readonly width?: number;
  readonly height?: number;
  /** Overlay rect (normalized 0..1) painted with uncorrelated noise. */
  readonly overlay?: { readonly x: number; readonly y: number };
}

const DEFAULT_WIDTH = 96;
const DEFAULT_HEIGHT = 64;

/** Pre-decoded spec of the last createImageBitmap call. drawImage binds it
 * to the next-created canvas; sampling happens strictly one frame at a time. */
let currentSpec: PixelSpec = { pattern: "flat" };

/** Encode a synthetic frame for a test `renderTimelineFrame` to return. */
export function patternFrameDataUrl(spec: PixelSpec): string {
  const payload = {
    pattern: spec.pattern,
    width: spec.width ?? DEFAULT_WIDTH,
    height: spec.height ?? DEFAULT_HEIGHT,
    ...(spec.overlay ? { overlay: spec.overlay } : {}),
  };
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  return `data:image/jpeg;base64,${json.toString("base64")}`;
}

function pixelBuffer(spec: PixelSpec, width: number, height: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const overlay = spec.overlay
    ? {
        x0: Math.max(0, Math.floor(spec.overlay.x * width) - Math.floor(width * 0.18)),
        x1: Math.min(width, Math.floor(spec.overlay.x * width) + Math.floor(width * 0.18)),
        y0: Math.max(0, Math.floor(spec.overlay.y * height) - Math.floor(height * 0.06)),
        y1: Math.min(height, Math.floor(spec.overlay.y * height) + Math.floor(height * 0.06)),
      }
    : undefined;
  // Deterministic pseudo-noise so repeated runs measure identically.
  let seed = 0x9e3779b9;
  const nextByte = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed >>> 16) & 0xff;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const inside =
        overlay !== undefined &&
        x >= overlay.x0 &&
        x < overlay.x1 &&
        y >= overlay.y0 &&
        y < overlay.y1;
      const value = inside || spec.pattern === "noise" ? nextByte() : spec.pattern === "flat" ? 128 : 0;
      pixels[index] = value;
      pixels[index + 1] = value;
      pixels[index + 2] = value;
      pixels[index + 3] = 255;
    }
  }
  return pixels;
}

interface ShimOriginals {
  readonly fetch: unknown;
  readonly createImageBitmap: unknown;
  readonly OffscreenCanvas: unknown;
  readonly defined: readonly string[];
}

let originals: ShimOriginals | undefined;

/**
 * Polyfill fetch/createImageBitmap/OffscreenCanvas for the current test file.
 * Only the `patternFrameDataUrl` data URLs the tests feed renderTimelineFrame
 * are expected; every other URL delegates to the original host fetch.
 */
export function installPixelShim(): void {
  if (originals) return;
  const scope = globalThis as unknown as Record<string, unknown>;
  const defined = (["fetch", "createImageBitmap", "OffscreenCanvas"] as const).filter(
    (name) => typeof scope[name] !== "undefined",
  );
  originals = {
    fetch: scope.fetch,
    createImageBitmap: scope.createImageBitmap,
    OffscreenCanvas: scope.OffscreenCanvas,
    defined,
  };

  const priorFetch = defined.includes("fetch") ? (scope.fetch as typeof fetch) : undefined;
  scope.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (!url.startsWith("data:")) {
      if (!priorFetch) throw new Error("pixel shim: no host fetch for non-data URL");
      return priorFetch(new Request(input, init) as Request);
    }
    const base64 = url.slice(url.indexOf(",") + 1);
    const bytes = new Uint8Array(Buffer.from(base64, "base64"));
    return { blob: async () => new Blob([bytes]) } as unknown as Response;
  }) as typeof fetch;

  const bitmapShim = async (image: Blob | ImageBitmapSource) => {
    const blob = image instanceof Blob ? image : undefined;
    if (!blob) throw new Error("pixel shim: only Blob inputs are supported");
    const parsed = JSON.parse(await blob.text()) as PixelSpec;
    currentSpec = {
      pattern: parsed.pattern,
      width: parsed.width ?? DEFAULT_WIDTH,
      height: parsed.height ?? DEFAULT_HEIGHT,
      ...(parsed.overlay ? { overlay: parsed.overlay } : {}),
    };
    return {
      width: currentSpec.width,
      height: currentSpec.height,
      close: () => undefined,
    };
  };
  scope.createImageBitmap = bitmapShim;

  scope.OffscreenCanvas = class {
    constructor(
      public readonly width: number,
      public readonly height: number,
    ) {}
    getContext(): {
      drawImage: (bitmap: unknown, x: number, y: number, w: number, h: number) => void;
      getImageData: (
        x: number,
        y: number,
        w: number,
        h: number,
      ) => { data: Uint8ClampedArray; width: number; height: number };
    } {
      return {
        drawImage: (bitmap: { width?: number; height?: number } | unknown) => {
          void bitmap;
          // currentSpec was bound by the createImageBitmap call immediately
          // preceding this canvas's drawImage (sequential per frame).
        },
        getImageData: (_x: number, _y: number, w: number, h: number) => ({
          data: pixelBuffer(currentSpec, w, h),
          width: w,
          height: h,
        }),
      };
    }
  };
}

/** Remove the shim and restore the previous globals. */
export function restorePixelShim(): void {
  if (!originals) return;
  const scope = globalThis as unknown as Record<string, unknown>;
  for (const name of ["fetch", "createImageBitmap", "OffscreenCanvas"] as const) {
    const value = originals[name];
    if (originals.defined.includes(name) && value !== undefined) scope[name] = value;
    else delete scope[name];
  }
  originals = undefined;
  currentSpec = { pattern: "flat" };
}

/** True when the shim is active (tests may assert they ran over real pixels). */
export function isPixelShimActive(): boolean {
  return originals !== undefined;
}
