import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bestQuality,
  loadReferenceFingerprints,
  parseReferenceFingerprint,
  scoreProducedEdit,
  summarizeQuality,
  type ReferenceFingerprint,
} from "./quality";
import { summarizeBaseline, type BaselineCaseResult } from "./baseline";
import type { QualityScore } from "./quality";

/** A punchy short-form edit: sub-second chops around one hero shot. */
const punchyProfile = {
  profile: {
    fps: { num: 30, den: 1 },
    durationFrames: 615,
    beatGridMs: [0, 500, 1000],
    shots: [
      { startFrame: 0, endFrame: 57 },
      { startFrame: 57, endFrame: 111 },
      { startFrame: 111, endFrame: 153 },
      { startFrame: 153, endFrame: 450 },
      { startFrame: 450, endFrame: 615 },
    ],
  },
};

const bareFingerprint: ReferenceFingerprint = {
  source: "real-bare.json",
  shotCount: 5,
  shotDurationsSec: [1.9, 1.8, 1.4, 9.9, 5.5],
  beatCount: 3,
  durationSeconds: 20.5,
};

describe("reference fingerprints", () => {
  it("parses the browser-measurement wrapper", () => {
    const parsed = parseReferenceFingerprint("real-x.json", punchyProfile);
    expect(parsed).not.toBeNull();
    expect(parsed!.shotCount).toBe(5);
    expect(parsed!.beatCount).toBe(3);
    expect(parsed!.shotDurationsSec).toEqual([1.9, 1.8, 1.4, 9.9, 5.5]);
    expect(parsed!.durationSeconds).toBeCloseTo(20.5);
  });

  it("parses a bare profile and rejects unusable shapes", () => {
    expect(parseReferenceFingerprint("a.json", punchyProfile.profile)!.shotCount).toBe(5);
    expect(parseReferenceFingerprint("a.json", null)).toBeNull();
    expect(parseReferenceFingerprint("a.json", {})).toBeNull();
    expect(parseReferenceFingerprint("a.json", { profile: { fps: { num: 30, den: 1 }, shots: [] } })).toBeNull();
    expect(
      parseReferenceFingerprint("a.json", { profile: { fps: { num: 0, den: 1 }, shots: [{ startFrame: 0, endFrame: 10 }] } }),
    ).toBeNull();
    expect(
      parseReferenceFingerprint("a.json", { profile: { fps: { num: 30, den: 1 }, shots: [{ startFrame: 10, endFrame: 10 }] } }),
    ).toBeNull();
  });

  it("loads real-*.json from a directory and skips junk", () => {
    const dir = mkdtempSync(join(tmpdir(), "kove-refs-"));
    try {
      writeFileSync(join(dir, "real-captain-price-profile.json"), JSON.stringify(punchyProfile));
      writeFileSync(join(dir, "notes.txt"), "ignore me");
      writeFileSync(join(dir, "real-broken.json"), "{not json");
      const loaded = loadReferenceFingerprints(dir);
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.source).toBe("real-captain-price-profile.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns [] for a missing directory", () => {
    expect(loadReferenceFingerprints(join(tmpdir(), "kove-refs-missing"))).toEqual([]);
  });
});

describe("scoreProducedEdit", () => {
  it("scores a reference-shaped edit near 1", () => {
    const score = scoreProducedEdit(
      {
        clipCount: 5,
        clipDurationsSec: [1.9, 1.8, 1.4, 9.9, 5.5],
        timelineDuration: 20.5,
        transitionCount: 2,
        effectCount: 1,
        textCount: 3,
      },
      bareFingerprint,
    );
    expect(score.cutGranularity.score).toBe(1);
    expect(score.rhythmSimilarity.score).toBeCloseTo(1, 3);
    expect(score.craft.score).toBe(1);
    expect(score.overall).toBeCloseTo(1, 3);
  });

  it("scores a bare 7-clip chop with no craft low", () => {
    const score = scoreProducedEdit(
      {
        clipCount: 7,
        clipDurationsSec: [5, 5, 5, 5, 5, 5, 5],
        timelineDuration: 35,
        transitionCount: 0,
        effectCount: 0,
        textCount: 1,
      },
      bareFingerprint,
    );
    expect(score.cutGranularity.score).toBeLessThan(0.8);
    expect(score.craft.score).toBeCloseTo(0.3333, 3);
    expect(score.overall).toBeLessThan(0.75);
  });

  it("guards empty inputs", () => {
    const score = scoreProducedEdit(
      { clipCount: 0, clipDurationsSec: [], timelineDuration: 0, transitionCount: 0, effectCount: 0, textCount: 0 },
      bareFingerprint,
    );
    expect(score.cutGranularity.score).toBe(0);
    expect(score.rhythmSimilarity.score).toBe(0);
    expect(score.overall).toBe(0);
  });

  it("bestQuality picks the closer reference", () => {
    const shortEdit = {
      clipCount: 5,
      clipDurationsSec: [1.9, 1.8, 1.4, 9.9, 5.5],
      timelineDuration: 20.5,
      transitionCount: 1,
      effectCount: 1,
      textCount: 2,
    };
    const longRef: ReferenceFingerprint = {
      source: "real-long.json",
      shotCount: 40,
      shotDurationsSec: Array.from({ length: 40 }, () => 12),
      beatCount: 0,
      durationSeconds: 480,
    };
    const best = bestQuality(shortEdit, [longRef, bareFingerprint]);
    expect(best!.reference).toBe("real-bare.json");
    expect(bestQuality(shortEdit, [])).toBeNull();
  });

  it("summarizes per-reference means and nothing when empty", () => {
    const make = (reference: string, overall: number): QualityScore => ({
      reference,
      cutGranularity: { score: overall, detail: "" },
      rhythmSimilarity: { score: overall, detail: "" },
      craft: { score: overall, detail: "" },
      overall,
    });
    const summary = summarizeQuality([make("a.json", 0.5), make("a.json", 0.7), make("b.json", 1)]);
    expect(summary!.scored).toBe(3);
    expect(summary!.meanOverall).toBeCloseTo(0.7333, 3);
    expect(summary!.byReference["a.json"]).toBeCloseTo(0.6, 3);
    expect(summary!.references).toEqual(["a.json", "b.json"]);
    expect(summarizeQuality([])).toBeNull();
  });
});

describe("baseline summary carries quality", () => {
  const baseResult = (id: string, quality: QualityScore | null): BaselineCaseResult => ({
    id,
    run: 0,
    projectId: id.split("/")[0]!,
    promptId: id.split("/")[1]!,
    promptType: "detailed",
    ok: true,
    toolCode: null,
    quotaExhausted: false,
    gates: { planValidates: true, materializes: true, noClipOverlaps: true },
    failures: [],
    warnings: [],
    stats: {
      durationMs: 1000,
      clipCount: 5,
      transitionCount: 1,
      effectCount: 0,
      audioCount: 1,
      textCount: 2,
      planScore: null,
      timelineDuration: 20.5,
    },
    quality,
  });

  it("aggregates quality over passing results only", () => {
    const quality: QualityScore = {
      reference: "real-captain-price-profile.json",
      cutGranularity: { score: 0.9, detail: "" },
      rhythmSimilarity: { score: 0.8, detail: "" },
      craft: { score: 0.3333, detail: "" },
      overall: 0.6778,
    };
    const failing = { ...baseResult("p/d", null), ok: false };
    const summary = summarizeBaseline(
      [baseResult("p/d", quality), failing],
      { model: "m", cases: 1, runsPerCombo: 1, status: "complete", quotaExcluded: 0 },
    );
    expect(summary.quality).toBeTruthy();
    expect(summary.quality!.meanOverall).toBeCloseTo(0.6778, 4);
    expect(summary.quality!.byReference["real-captain-price-profile.json"]).toBeCloseTo(0.6778, 4);
  });

  it("omits quality when nothing scored", () => {
    const summary = summarizeBaseline(
      [baseResult("p/d", null)],
      { model: "m", cases: 1, runsPerCombo: 1, status: "complete", quotaExcluded: 0 },
    );
    expect(summary.quality).toBeUndefined();
  });
});
