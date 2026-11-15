import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { hasBrowser } from "../playwright.config";
import { extractHeadlessTextOverlays } from "./headless-ocr";

interface FrameRate {
  readonly num: number;
  readonly den: number;
}

interface DecodePath {
  readonly kind: "native" | "h264-proxy";
  readonly codec: string;
  readonly proxy?: string;
  readonly proxySha256?: string;
  readonly reason?: string;
}

interface BaselineCase {
  readonly id: string;
  readonly styleFamily: string;
  readonly source: string;
  readonly sourceAvailability: string;
  readonly sha256: string;
  readonly decodePath: DecodePath;
  readonly media: {
    readonly width: number;
    readonly height: number;
    readonly fps: FrameRate;
    readonly durationFrames: number;
    readonly streamStartSeconds?: number;
  };
  readonly notes?: readonly string[];
}

interface BaselineManifest {
  readonly schemaVersion: number;
  readonly extraction: {
    readonly backend: string;
    readonly includeReferenceText: boolean;
    readonly ffmpegSceneDetection: boolean;
    readonly endCardTrim: boolean;
  };
  readonly cases: readonly BaselineCase[];
}

const repoRoot = resolve(process.cwd(), "../..");
const manifestPath = resolve(repoRoot, "evaluation-files/reference/mirror-baseline-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BaselineManifest;
const outDir = resolve(repoRoot, "evaluation-files/mirror-baseline/profiles");
const enabled = process.env.KOVE_MIRROR_BASELINE === "1";
const headlessOcr = process.env.KOVE_MIRROR_OCR_MODE === "headless";
const only = process.env.KOVE_MIRROR_BASELINE_IDS?.split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test.describe("Mirror baseline extraction (local references)", () => {
  test.skip(!hasBrowser(), "No Chromium available: set KOVE_E2E_CHROMIUM or install Playwright Chromium.");

  for (const entry of manifest.cases) {
    test(`extract ${entry.id}`, async ({ page }) => {
      test.skip(!enabled, "Set KOVE_MIRROR_BASELINE=1 to run the 10-reference baseline.");
      test.skip(only !== undefined && !only.includes(entry.id), "Filtered by KOVE_MIRROR_BASELINE_IDS.");
      const sourcePath = resolve(repoRoot, entry.source);
      test.skip(!existsSync(sourcePath), `Local-only source absent: ${entry.source}`);
      test.setTimeout(900_000);

      expect(sha256(readFileSync(sourcePath))).toBe(entry.sha256);

      let mediaPath = sourcePath;
      if (entry.decodePath.kind === "h264-proxy") {
        if (!entry.decodePath.proxy || !entry.decodePath.proxySha256) {
          throw new Error(`Missing proxy metadata for ${entry.id}`);
        }
        mediaPath = resolve(repoRoot, entry.decodePath.proxy);
        if (!existsSync(mediaPath)) throw new Error(`Local-only proxy absent: ${entry.decodePath.proxy}`);
        expect(sha256(readFileSync(mediaPath))).toBe(entry.decodePath.proxySha256);
      }

      await page.goto("/");
      await page.evaluate(() => {
        const input = document.createElement("input");
        input.type = "file";
        input.id = "kove-mirror-baseline-input";
        document.body.appendChild(input);
      });
      await page.setInputFiles("#kove-mirror-baseline-input", mediaPath);

      const clock = {
        fps: entry.media.fps,
        fpsSource: "ffprobe",
        durationSeconds: (entry.media.durationFrames * entry.media.fps.den) / entry.media.fps.num,
        ...(entry.media.streamStartSeconds !== undefined && {
          videoStartTimeSeconds: entry.media.streamStartSeconds,
        }),
      };

      const result = await page.evaluate(
        async ({ caseClock, includeText, disablePortableOcr }) => {
          const input = document.querySelector<HTMLInputElement>("#kove-mirror-baseline-input");
          const file = input?.files?.[0];
          if (!file) throw new Error("Baseline file input is empty");
          const { extractReference } = await import("/src/services/mirror/extract-reference.ts");
          const started = performance.now();
          const profile = await extractReference(file, caseClock, {
            includeReferenceText: includeText,
            ocrMode: disablePortableOcr ? "disabled" : "auto",
          });
          return { profile, elapsedMs: Math.round(performance.now() - started) };
        },
        { caseClock: clock, includeText: manifest.extraction.includeReferenceText, disablePortableOcr: headlessOcr },
      );

      if (
        manifest.extraction.includeReferenceText &&
        result.profile.warnings?.some((warning) => warning.includes("Local OCR is unavailable"))
      ) {
        const fallback = await extractHeadlessTextOverlays({
          videoPath: mediaPath,
          fps: entry.media.fps.num / entry.media.fps.den,
          durationFrames: result.profile.durationFrames,
          ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
        });
        if (fallback) {
          result.profile.styleEvidence!.textOverlays = fallback.overlays;
          result.profile.warnings = [
            ...(result.profile.warnings ?? []).filter((warning) => !warning.includes("Local OCR is unavailable")),
            ...fallback.warnings,
          ];
        }
      }

      mkdirSync(outDir, { recursive: true });
      writeFileSync(
        resolve(outDir, `${entry.id}.json`),
        `${JSON.stringify(result.profile, null, 2)}\n`,
      );
      writeFileSync(
        resolve(outDir, `${entry.id}.meta.json`),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            id: entry.id,
            styleFamily: entry.styleFamily,
            source: entry.source,
            sourceSha256: entry.sha256,
            decodePath: entry.decodePath,
            clock,
            clockProvenance: "external-ffprobe-manifest",
            extraction: manifest.extraction,
            media: entry.media,
            elapsedMs: result.elapsedMs,
            generatedAt: new Date().toISOString(),
            profilePath: `evaluation-files/mirror-baseline/profiles/${entry.id}.json`,
            fps: result.profile.fps,
            fpsSource: result.profile.fpsSource,
            durationFrames: result.profile.durationFrames,
            shotCount: result.profile.shots.length,
            textOverlayCount: result.profile.styleEvidence?.textOverlays.length ?? 0,
            ocrBackend: headlessOcr ? "headless-fallback" : "portable",
            transitionCount: result.profile.styleEvidence?.transitions?.length ?? 0,
            warnings: result.profile.warnings ?? [],
            notes: entry.notes ?? [],
          },
          null,
          2,
        )}\n`,
      );
    });
  }
});
