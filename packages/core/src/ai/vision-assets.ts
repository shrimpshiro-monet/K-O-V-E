/**
 * Asset locations for the browser vision engines (MediaPipe Tasks runtime,
 * face model, person-segmentation models).
 *
 * Defaults point at public CDNs. Deployments that cannot reach the internet —
 * or that prefer to pin/serve models themselves — can point every consumer at
 * self-hosted copies with `setVisionAssets()` (see `visionAssetsFromBaseUrl`
 * for the conventional directory layout). Callers that already accept explicit
 * URLs (for example `createMediaPipeFaceBackend`) still win over this config.
 */

export interface VisionAssetUrls {
  /** WASM directory passed to MediaPipe's FilesetResolver. */
  wasmBaseUrl: string;
  /** Classic (CJS) Tasks bundle loaded with `importScripts` inside the worker. */
  tasksVisionBundleUrl: string;
  /** Face detector model (`blaze-face`). */
  faceModelAssetPath: string;
  /** Face landmarker model (`face-landmarker`). */
  faceLandmarkerAssetPath: string;
  /** Person segmentation: high-quality multiclass model. */
  segmenterModelAssetPath: string;
  /** Person segmentation: fast fallback model. */
  segmenterFallbackModelAssetPath: string;
}

const TASKS_VISION_VERSION = "0.10.35";

export const DEFAULT_VISION_ASSET_URLS: Readonly<VisionAssetUrls> = Object.freeze({
  wasmBaseUrl: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`,
  tasksVisionBundleUrl: `https://unpkg.com/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/vision_bundle.cjs`,
  faceModelAssetPath:
    "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
  faceLandmarkerAssetPath:
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
  segmenterModelAssetPath:
    "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite",
  segmenterFallbackModelAssetPath:
    "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite",
});

let current: VisionAssetUrls = { ...DEFAULT_VISION_ASSET_URLS };

/** Resolved asset URLs; every consumer reads this so one call retargets all. */
export function getVisionAssets(): VisionAssetUrls {
  return { ...current };
}

/**
 * Merges overrides into the active asset config and returns the result.
 * Unknown/undefined keys keep their previous value, so callers can retarget a
 * single model.
 */
export function setVisionAssets(overrides: Partial<VisionAssetUrls>): VisionAssetUrls {
  const next: VisionAssetUrls = { ...current };
  for (const key of Object.keys(DEFAULT_VISION_ASSET_URLS) as (keyof VisionAssetUrls)[]) {
    const value = overrides[key];
    if (typeof value === "string" && value.length > 0) next[key] = value;
  }
  current = next;
  return { ...current };
}

/** Restores the public-CDN defaults. Mostly useful for tests. */
export function resetVisionAssets(): void {
  current = { ...DEFAULT_VISION_ASSET_URLS };
}

/**
 * Derive every URL from a single self-hosted base, using the layout produced by
 * `apps/web/e2e/setup-assets.mjs` and documented in docs/AGENT-VISION.md:
 *
 * ```
 * {base}/wasm/…                                  MediaPipe tasks-vision WASM
 * {base}/vision_bundle.cjs                       classic Tasks bundle
 * {base}/models/blaze_face_short_range.tflite
 * {base}/models/face_landmarker.task
 * {base}/models/selfie_multiclass_256x256.tflite
 * {base}/models/selfie_segmenter.tflite
 * ```
 */
export function visionAssetsFromBaseUrl(baseUrl: string): VisionAssetUrls {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    wasmBaseUrl: `${base}/wasm`,
    tasksVisionBundleUrl: `${base}/vision_bundle.cjs`,
    faceModelAssetPath: `${base}/models/blaze_face_short_range.tflite`,
    faceLandmarkerAssetPath: `${base}/models/face_landmarker.task`,
    segmenterModelAssetPath: `${base}/models/selfie_multiclass_256x256.tflite`,
    segmenterFallbackModelAssetPath: `${base}/models/selfie_segmenter.tflite`,
  };
}
