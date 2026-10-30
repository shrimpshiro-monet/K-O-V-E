import { describe, expect, it } from "vitest";
import {
  createReferenceProfile,
  parseReferenceProfile,
  serializeReferenceProfile,
  validateReferenceProfile,
  type ReferenceProfile,
} from "./reference-profile";

function profile(): ReferenceProfile {
  return createReferenceProfile({
    fps: { num: 30, den: 1 },
    fpsSource: "ffprobe",
    durationFrames: 60,
    aspectRatio: { width: 1920, height: 1080 },
    shots: [{ startFrame: 0, endFrame: 60, captionWindows: [] }],
    beatGridMs: [],
    styleEvidence: {
      transitions: [{
        startFrame: 29,
        endFrame: 31,
        type: "hard-cut",
        source: "local-pixel-analysis",
        confidence: 0.9,
      }],
      textOverlays: [{
        startFrame: 10,
        endFrame: 30,
        bounds: { x: 0.1, y: 0.75, width: 0.8, height: 0.1 },
        text: "Sample caption",
        style: { fontSizeRatio: 0.04, fontWeight: 700, alignment: "center" },
        source: "local-ocr",
        confidence: 0.8,
      }],
      effects: [{
        startFrame: 35,
        endFrame: 45,
        name: "motion-blur-candidate",
        parameterEstimates: { strength: 0.4 },
        source: "vision-model",
        confidence: 0.5,
      }],
    },
  });
}

describe("EditDNA v3 reference profiles", () => {
  it("creates, validates, and serializes typed style evidence", () => {
    const value = profile();
    expect(value.version).toBe("kove.mirror.v3");
    expect(() => validateReferenceProfile(value)).not.toThrow();
    expect(JSON.parse(serializeReferenceProfile(value)).styleEvidence.textOverlays).toHaveLength(1);
  });

  it("migrates v2 profiles with an explicit note and empty inferred evidence", () => {
    const value = profile();
    const legacy = { ...value, version: "kove.mirror.v2", styleEvidence: undefined };
    const migrated = parseReferenceProfile(legacy);
    expect(migrated.version).toBe("kove.mirror.v3");
    expect(migrated.styleEvidence).toEqual({ transitions: [], textOverlays: [], effects: [] });
    expect(migrated.warnings?.some((warning) => warning.includes("migrated to v3"))).toBe(true);
  });

  it("rejects confidence and out-of-frame geometry that cannot be trusted", () => {
    const invalidConfidence = profile();
    const invalidConfidenceProfile = {
      ...invalidConfidence,
      styleEvidence: {
        transitions: [{
          startFrame: 1,
          endFrame: 2,
          type: "hard-cut" as const,
          source: "local-pixel-analysis" as const,
          confidence: 1.1,
        }],
        textOverlays: [],
        effects: [],
      },
    };
    expect(() => validateReferenceProfile(invalidConfidenceProfile)).toThrow(/confidence/);

    const invalidBounds = profile();
    const invalidBoundsProfile = {
      ...invalidBounds,
      styleEvidence: {
        transitions: [],
        textOverlays: [{
          startFrame: 1,
          endFrame: 2,
          bounds: { x: 0.9, y: 0.9, width: 0.2, height: 0.2 },
          source: "local-ocr" as const,
          confidence: 0.9,
        }],
        effects: [],
      },
    };
    expect(() => validateReferenceProfile(invalidBoundsProfile)).toThrow(/normalized/);
  });

  it("rejects a v3 profile that omits its evidence contract", () => {
    const value = profile();
    const missingEvidence = { ...value, styleEvidence: undefined };
    expect(() => validateReferenceProfile(missingEvidence)).toThrow(/requires style evidence/);
  });
});
