import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Vision e2e config (real Chromium driving the real editor).
 *
 * Browser selection:
 *   KOVE_E2E_CHROMIUM=/path/to/chrome   use a browser already on the machine
 *                                       (sandboxes: see e2e/README.md)
 *   otherwise                           Playwright's bundled Chromium, if
 *                                       `pnpm exec playwright install chromium`
 *                                       has been run
 *
 * The suite is skipped (not failed) when neither is available, so `pnpm test`
 * stays green on machines without a browser.
 */
const APP_PORT = Number(process.env.KOVE_E2E_APP_PORT ?? 5199);
const ASSET_PORT = Number(process.env.KOVE_E2E_ASSET_PORT ?? 8788);

export function hasBrowser(): boolean {
  if (process.env.KOVE_E2E_CHROMIUM) return true;
  const cacheDir = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache", "ms-playwright");
  try {
    return readdirSync(cacheDir).some((entry) => entry.startsWith("chromium"));
  } catch {
    return false;
  }
}

/** Flags a headless CI/sandbox browser needs; harmless for a normal install. */
const CHROMIUM_ARGS = [
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
];

const use: PlaywrightTestConfig["use"] = {
  baseURL: `http://127.0.0.1:${APP_PORT}`,
  headless: true,
  viewport: { width: 1440, height: 900 },
  trace: "retain-on-failure",
  launchOptions: {
    args: CHROMIUM_ARGS,
    ...(process.env.KOVE_E2E_CHROMIUM ? { executablePath: process.env.KOVE_E2E_CHROMIUM } : {}),
  },
};

export default defineConfig({
  testDir: "./e2e",
  testMatch: "*.spec.ts",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use,
  webServer: [
    {
      // MediaPipe runtime + face model, no CDN involved.
      command: "node e2e/asset-server.mjs",
      port: ASSET_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: {
        // Serve the synthetic segmentation model (see stub-segmenter-runtime.cjs).
        KOVE_E2E_STUB_SEGMENTER: process.env.KOVE_E2E_STUB_SEGMENTER ?? "1",
      },
    },
    {
      command: `pnpm exec vite --host 127.0.0.1 --port ${APP_PORT} --strictPort`,
      port: APP_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        // Point the app's vision engines at the local assets instead of the CDN.
        // The offline asset set carries the landmarker task model (see
        // e2e/setup-assets.mjs), so ask the app for that face model.
        VITE_VISION_ASSET_BASE_URL: `http://127.0.0.1:${ASSET_PORT}`,
        VITE_VISION_FACE_MODEL: process.env.KOVE_E2E_FACE_MODEL ?? "face-landmarker",
      },
    },
  ],
});
