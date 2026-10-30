import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { hasBrowser } from "../playwright.config";

interface CorpusCase {
  readonly id: string;
  readonly source: string;
  readonly sha256: string;
  readonly media: {
    readonly width: number;
    readonly height: number;
    readonly fps: { readonly num: number; readonly den: number };
    readonly durationFrames: number;
  };
  readonly labels: {
    readonly status: string;
    readonly shotBoundariesFrames: number[] | null;
  };
}

const repoRoot = resolve(process.cwd(), "../..");
const corpusPath = resolve(repoRoot, "evaluation-files/reference/known-cut-corpus.json");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as {
  readonly cases: readonly CorpusCase[];
};
const fixture = corpus.cases.find((entry) => entry.id === "synthetic-three-scene-h264");

test.describe("reference EditDNA in real Chromium", () => {
  test.skip(
    !hasBrowser(),
    "No Chromium available: set KOVE_E2E_CHROMIUM or install Playwright Chromium.",
  );

  test("finds the known cuts in the hashed H.264 fixture through the browser decoder", async ({ page }) => {
    if (!fixture || fixture.labels.status !== "verified-synthetic" ||
        !fixture.labels.shotBoundariesFrames) {
      throw new Error("The synthetic reference case must have verified cut labels.");
    }
    const sourcePath = resolve(repoRoot, fixture.source);
    const bytes = readFileSync(sourcePath);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(fixture.sha256);
    await page.goto("/");

    const result = await page.evaluate(async ({ base64, media }) => {
      const binary = atob(base64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const { extractReference } = await import("/src/services/mirror/extract-reference.ts");
      const profile = await extractReference(
        new Blob([bytes], { type: "video/mp4" }),
        { fps: media.fps, fpsSource: "user", durationSeconds: media.durationFrames / media.fps.num },
      );
      return {
        boundaries: profile.shots.slice(1).map((shot) => shot.startFrame),
        durationFrames: profile.durationFrames,
        warnings: profile.warnings ?? [],
        transitions: profile.styleEvidence?.transitions ?? [],
      };
    }, {
      base64: bytes.toString("base64"),
      media: fixture.media,
    });

    expect(result.durationFrames).toBe(fixture.media.durationFrames);
    expect(result.boundaries).toEqual(fixture.labels.shotBoundariesFrames);
    expect(result.warnings).not.toContain(
      "Indexed WebCodecs decoder unavailable: HTML video seeks may not decode exact requested frames. Verify critical cuts manually.",
    );
    expect(result.transitions).toHaveLength(fixture.labels.shotBoundariesFrames.length);
    expect(result.transitions.every((transition) =>
      transition.type === "hard-cut" && transition.confidence >= 0.75,
    )).toBe(true);
  });
});
