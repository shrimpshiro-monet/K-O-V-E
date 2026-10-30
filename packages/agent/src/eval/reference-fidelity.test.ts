import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseReferenceProfile, type ReferenceProfile } from "@kove-advanced/core/mirror/reference-profile";
import {
  evaluateReferenceProfiles,
  scoreCameraMotion,
  scoreIntervals,
  scoreShotBoundaries,
} from "./reference-fidelity";

describe("objective reference fidelity metrics", () => {
  it("measures tolerant one-to-one shot-boundary matches and cut timing error", () => {
    expect(scoreShotBoundaries([10, 20, 30], [11, 20, 40], 1)).toEqual({
      truePositives: 2,
      precision: 0.6667,
      recall: 0.6667,
      f1: 0.6667,
      meanAbsoluteErrorFrames: 0.5,
    });
    expect(scoreShotBoundaries([], [], 0).f1).toBe(1);
    expect(() => scoreShotBoundaries([10, 10], [], 1)).toThrow(/strictly increasing/);
    expect(scoreShotBoundaries([0, 3], [2, 3], 2)).toMatchObject({
      truePositives: 2,
      meanAbsoluteErrorFrames: 1,
    });
  });

  it("measures caption temporal IoU with one-to-one matching", () => {
    expect(scoreIntervals(
      [{ start: 0, end: 2 }, { start: 3, end: 4 }],
      [{ start: 0.5, end: 2.5 }, { start: 3, end: 4 }],
    )).toMatchObject({
      referenceCount: 2,
      predictedCount: 2,
      precision: 1,
      recall: 1,
      f1: 1,
      meanMatchedIoU: 0.8,
    });
    expect(scoreIntervals(
      [{ start: 0, end: 10 }, { start: 1, end: 11 }],
      [{ start: 0, end: 11 }, { start: 0, end: 9 }],
      0.8,
    )).toMatchObject({
      referenceCount: 2,
      predictedCount: 2,
      precision: 1,
      recall: 1,
      f1: 1,
      meanMatchedIoU: 0.9045,
    });
  });

  it("measures camera-curve error after normalizing translations to frame size", () => {
    const shots = [{
      startFrame: 0,
      endFrame: 30,
      captionWindows: [],
      cameraMotion: {
        dominantMove: "push" as const,
        samples: [
          { frame: 0, translateX: 0, translateY: 0, rotationRad: 0, scale: 1 },
          { frame: 29, translateX: 100, translateY: 50, rotationRad: 0.1, scale: 1.1 },
        ],
      },
    }];
    const result = scoreCameraMotion(shots, shots, 30, { width: 1000, height: 500 }, 10);
    expect(result).toMatchObject({
      sampleCount: 10,
      normalizedRmse: 0,
      correlation: 1,
      similarity: 1,
    });
  });

  it("checks the stored multi-reference corpus and reports its self-consistency baseline", () => {
    const directory = resolve(process.cwd(), "../../evaluation-files/reference");
    const names = readdirSync(directory).filter((name) => name.endsWith("-profile.json")).sort();
    expect(names.length).toBeGreaterThanOrEqual(2);
    const report = names.map((name) => {
      const parsed = JSON.parse(readFileSync(resolve(directory, name), "utf8")) as unknown;
      const reference = parseReferenceProfile(
        isProfileWrapper(parsed) ? parsed.profile : parsed,
      );
      const measured = evaluateReferenceProfiles(reference, reference);
      return { name, reference, measured };
    });
    expect(report.map((item) => item.name)).toEqual([
      "real-captain-price-profile.json",
      "real-spiderman-profile.json",
    ]);
    for (const item of report) {
      expect(item.measured.shotBoundaries.f1).toBe(1);
      expect(item.measured.cutTimingMaeFrames).toBe(0);
      expect(item.measured.textOverlayWindows.f1).toBe(1);
      expect(item.reference.shots.length).toBeGreaterThan(0);
    }
  });

  it("pins source identity and keeps unannotated real clips out of accuracy claims", () => {
    const root = resolve(process.cwd(), "../../");
    const manifest = JSON.parse(readFileSync(
      resolve(root, "evaluation-files/reference/known-cut-corpus.json"),
      "utf8",
    )) as {
      cases: Array<{
        id: string;
        source: string;
        sourceAvailability?: string;
        sha256: string;
        labels: { status: string; shotBoundariesFrames: number[] | null };
      }>;
    };
    for (const item of manifest.cases) {
      expect(item.sha256, item.id).toMatch(/^[a-f0-9]{64}$/);
      const sourcePath = resolve(root, item.source);
      if (existsSync(sourcePath)) {
        const digest = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
        expect(digest, item.id).toBe(item.sha256);
      } else {
        expect(item.sourceAvailability, item.id).toBe("local-only");
      }
    }
    expect(manifest.cases.find((item) => item.id === "synthetic-three-scene-h264")?.labels)
      .toMatchObject({ status: "verified-synthetic", shotBoundariesFrames: [30, 60] });
    for (const item of manifest.cases.filter((entry) => entry.id !== "synthetic-three-scene-h264")) {
      expect(item.labels.status, item.id).toBe("pending-human-annotation");
      expect(item.labels.shotBoundariesFrames, item.id).toBeNull();
    }
  });

  it("scores OCR overlay intervals from style evidence instead of empty shot placeholders", () => {
    const profile = parseReferenceProfile({
      version: "kove.mirror.v3",
      fps: { num: 30, den: 1 },
      fpsSource: "user",
      durationFrames: 30,
      aspectRatio: { width: 1920, height: 1080 },
      shots: [{ startFrame: 0, endFrame: 30, captionWindows: [] }],
      rhythmCurve: [30],
      beatGridMs: [],
      styleEvidence: {
        transitions: [],
        textOverlays: [{
          source: "local-ocr",
          confidence: 0.6,
          startFrame: 3,
          endFrame: 20,
          bounds: { x: 0.2, y: 0.7, width: 0.5, height: 0.1 },
        }],
        effects: [],
      },
    });
    const report = evaluateReferenceProfiles(profile, {
      ...profile,
      styleEvidence: {
        ...profile.styleEvidence!,
        textOverlays: profile.styleEvidence!.textOverlays.map((overlay) => ({
          ...overlay,
          startFrame: 4,
          endFrame: 21,
        })),
      },
    });
    expect(report.textOverlayWindows).toMatchObject({
      referenceCount: 1,
      predictedCount: 1,
      precision: 1,
      recall: 1,
      f1: 1,
      meanMatchedIoU: 0.8889,
    });
  });
});

function isProfileWrapper(value: unknown): value is { readonly profile: ReferenceProfile } {
  return typeof value === "object" && value !== null &&
    "profile" in value && typeof value.profile === "object" && value.profile !== null;
}
