import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { hasBrowser } from "../playwright.config";

const ocrAssets = resolve(process.cwd(), "public/ocr");
const assetsReady = ["worker.min.js", "tesseract-core-simd-lstm.wasm.js", "tesseract-core-simd-lstm.wasm", "eng.traineddata"]
  .every((file) => existsSync(resolve(ocrAssets, file)));

test.describe("portable OCR backend", () => {
  test.skip(!hasBrowser(), "No Chromium available: set KOVE_E2E_CHROMIUM or install Playwright Chromium.");
  test.skip(!assetsReady, "Vendored OCR assets are absent.");

  test("recognizes text through the WASM worker without TextDetector", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/");
    const result = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 800;
      canvas.height = 200;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("2D canvas unavailable");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#000000";
      context.font = "bold 64px sans-serif";
      context.fillText("SALE 50% OFF", 40, 120);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const { createPortableTextDetector } = await import("/src/services/mirror/reference-text.ts");
      const backend = await createPortableTextDetector();
      if (!backend) return { kind: null, text: "", hasNativeDetector: typeof globalThis.TextDetector !== "undefined" };
      try {
        const blocks = await backend.detect(pixels, canvas.width, canvas.height);
        return {
          kind: backend.kind,
          text: blocks.map((block) => block.rawValue ?? "").join(" "),
          hasNativeDetector: typeof globalThis.TextDetector !== "undefined",
        };
      } finally {
        await backend.dispose();
      }
    });
    expect(result.hasNativeDetector).toBe(false);
    expect(result.kind).toBe("wasm");
    expect(result.text.toUpperCase()).toContain("SALE");
    expect(result.text).toMatch(/50/);
  });
});
