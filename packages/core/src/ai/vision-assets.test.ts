import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_VISION_ASSET_URLS,
  getVisionAssets,
  resetVisionAssets,
  setVisionAssets,
  visionAssetsFromBaseUrl,
} from "./vision-assets";

describe("vision assets config", () => {
  afterEach(() => {
    resetVisionAssets();
  });

  it("defaults to the public CDN assets", () => {
    const assets = getVisionAssets();
    expect(assets).toEqual(DEFAULT_VISION_ASSET_URLS);
    expect(assets.wasmBaseUrl).toContain("@mediapipe/tasks-vision");
    expect(assets.faceModelAssetPath).toContain("blaze_face_short_range.tflite");
    expect(assets.faceLandmarkerAssetPath).toContain("face_landmarker.task");
    expect(assets.segmenterModelAssetPath).toContain("selfie_multiclass_256x256.tflite");
    expect(assets.segmenterFallbackModelAssetPath).toContain("selfie_segmenter.tflite");
  });

  it("returns a copy, so callers cannot mutate the active config", () => {
    const assets = getVisionAssets();
    assets.wasmBaseUrl = "https://example.com/wasm";
    expect(getVisionAssets().wasmBaseUrl).toBe(DEFAULT_VISION_ASSET_URLS.wasmBaseUrl);
  });

  it("merges partial overrides and keeps untouched keys", () => {
    setVisionAssets({ wasmBaseUrl: "http://localhost:8788/wasm" });
    const assets = getVisionAssets();
    expect(assets.wasmBaseUrl).toBe("http://localhost:8788/wasm");
    expect(assets.faceModelAssetPath).toBe(DEFAULT_VISION_ASSET_URLS.faceModelAssetPath);

    setVisionAssets({ faceModelAssetPath: "http://localhost:8788/models/blaze.tflite" });
    expect(getVisionAssets().wasmBaseUrl).toBe("http://localhost:8788/wasm");
  });

  it("ignores empty strings and unknown keys", () => {
    setVisionAssets({ wasmBaseUrl: "" });
    expect(getVisionAssets().wasmBaseUrl).toBe(DEFAULT_VISION_ASSET_URLS.wasmBaseUrl);
    setVisionAssets({ nope: "x" } as never);
    expect(getVisionAssets()).toEqual(DEFAULT_VISION_ASSET_URLS);
  });

  it("resets back to the defaults", () => {
    setVisionAssets({ tasksVisionBundleUrl: "http://localhost:8788/vision_bundle.cjs" });
    resetVisionAssets();
    expect(getVisionAssets()).toEqual(DEFAULT_VISION_ASSET_URLS);
  });

  it("derives every URL from one self-hosted base", () => {
    const base = "http://localhost:8788/";
    const derived = visionAssetsFromBaseUrl(base);
    expect(derived.wasmBaseUrl).toBe("http://localhost:8788/wasm");
    expect(derived.tasksVisionBundleUrl).toBe("http://localhost:8788/vision_bundle.cjs");
    expect(derived.faceModelAssetPath).toBe(
      "http://localhost:8788/models/blaze_face_short_range.tflite",
    );
    expect(derived.segmenterFallbackModelAssetPath).toBe(
      "http://localhost:8788/models/selfie_segmenter.tflite",
    );
    for (const url of Object.values(derived)) expect(url.startsWith("http://localhost:8788/")).toBe(true);
  });

  it("feeds the derived config into the active one", () => {
    setVisionAssets(visionAssetsFromBaseUrl("http://127.0.0.1:8788"));
    expect(getVisionAssets().wasmBaseUrl).toBe("http://127.0.0.1:8788/wasm");
    resetVisionAssets();
    expect(getVisionAssets()).toEqual(DEFAULT_VISION_ASSET_URLS);
  });
});
