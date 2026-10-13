import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BaselineCaseResult, BaselineSummary } from "./baseline";
import { fingerprintCorpusFile } from "./baseline";
import { formatStitchMarkdown, readReport, renderCli, stitchReports, StitchError } from "./stitch";

const PASS_GATES = { planValidates: true, materializes: true, noClipOverlaps: true };
const FAIL_GATES = { planValidates: false, materializes: true, noClipOverlaps: true };

function row(
  id: string,
  run: number,
  ok: boolean,
  overrides: Partial<BaselineCaseResult> = {},
): BaselineCaseResult {
  return {
    id,
    run,
    projectId: id.split("/")[0] ?? id,
    promptId: id.split("/")[1] ?? "d",
    promptType: "detailed",
    ok,
    toolCode: ok ? null : "INVALID_EDIT_PLAN",
    quotaExhausted: false,
    gates: ok ? PASS_GATES : FAIL_GATES,
    failures: ok ? [] : ["plan_edit failed [INVALID_EDIT_PLAN]: boom"],
    warnings: [],
    stats: {
      durationMs: 1,
      clipCount: ok ? 4 : 0,
      transitionCount: 0,
      effectCount: 0,
      audioCount: 0,
      textCount: 0,
      planScore: null,
      timelineDuration: ok ? 45 : 0,
    },
    ...overrides,
  };
}

function quotaRow(id: string, run: number): BaselineCaseResult {
  return row(id, run, false, {
    toolCode: "TOOL_ERROR",
    quotaExhausted: true,
    failures: ["plan_edit failed [TOOL_ERROR]: cloudflare-ai 429 ..."],
  });
}

const rate = (mean: number) => ({
  mean,
  min: mean,
  max: mean,
  stdev: 0,
  perRun: [mean],
  validPerRun: [1],
});

function summary(
  fingerprint: string | undefined,
  results: readonly BaselineCaseResult[],
): BaselineSummary {
  return {
    generatedAt: "2026-10-09T00:00:00.000Z",
    model: "@cf/test",
    sampling: { temperature: 0, seed: 1234 },
    runsPerCombo: 3,
    ...(fingerprint ? { corpusFingerprint: fingerprint } : {}),
    cases: new Set(results.map(result => result.id)).size,
    total: results.length,
    passed: results.filter(result => result.ok && !result.quotaExhausted).length,
    status: "complete",
    quotaExcluded: results.filter(result => result.quotaExhausted).length,
    gateRates: {
      planValidates: rate(1),
      materializes: rate(1),
      noClipOverlaps: rate(1),
      allGates: rate(1),
    },
    determinism: { allPass: 0, allFail: 0, mixed: 0, mixedIds: [], incomplete: 0, incompleteIds: [] },
    results,
  } as BaselineSummary;
}

/** Two distinct corpus files → two fingerprints that must never be equated. */
function twoFingerprints(root: string): [string, string] {
  const a = join(root, "corpus-a.json");
  const b = join(root, "corpus-b.json");
  writeFileSync(a, JSON.stringify([{ id: "p" }], null, 2));
  writeFileSync(b, `${JSON.stringify([{ id: "p" }], null, 2)}\n`);
  return [fingerprintCorpusFile(a), fingerprintCorpusFile(b)];
}

describe("stitchReports", () => {
  it("refuses reports measured against different corpora", () => {
    const root = mkdtempSync(join(tmpdir(), "kove-stitch-fp-"));
    try {
      const [fpA, fpB] = twoFingerprints(root);
      expect(fpA).not.toBe(fpB);
      const inputs = [
        { file: "one.json", summary: summary(fpA, [row("a/d", 0, true)]) },
        { file: "two.json", summary: summary(fpB, [row("a/d", 0, true)]) },
      ];
      expect(() => stitchReports(inputs)).toThrow(StitchError);
      expect(() => stitchReports(inputs)).toThrow(/corpus fingerprints differ/);
      expect(() => stitchReports(inputs)).toThrow(/one\.json: [\da-f]{64}/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses unpinned reports unless --allow-legacy", () => {
    const inputs = [
      { file: "baseline-v0.json", summary: summary(undefined, [row("a/d", 0, true)]) },
      { file: "baseline-r1-include-18.json", summary: summary("fp", [row("a/d", 1, true)]) },
    ];
    expect(() => stitchReports(inputs)).toThrow(/unpinned report\(s\) refused: baseline-v0\.json/);
    expect(() => stitchReports(inputs, { allowLegacy: true })).not.toThrow();
  });

  it("tolerates at most one unpinned report even with --allow-legacy", () => {
    const inputs = [
      { file: "legacy-a.json", summary: summary(undefined, [row("a/d", 0, true)]) },
      { file: "legacy-b.json", summary: summary(undefined, [row("a/d", 1, true)]) },
    ];
    expect(() => stitchReports(inputs, { allowLegacy: true })).toThrow(
      /at most one unpinned report, got 2/,
    );
  });

  it("needs at least two reports", () => {
    expect(() =>
      stitchReports([{ file: "only.json", summary: summary("fp", [row("a/d", 0, true)]) }]),
    ).toThrow(/at least 2 reports/);
  });

  it("drops quota rows before merging so a legacy quota row cannot mask a valid one", () => {
    const results = [quotaRow("a/d", 0), row("a/d", 0, true)];
    const stitched = stitchReports([
      { file: "legacy.json", summary: summary(undefined, results) },
      { file: "new.json", summary: summary("fp", [row("a/d", 0, true)]) },
    ], { allowLegacy: true });
    expect(stitched.droppedQuotaRows).toBe(1);
    const combo = stitched.combos.find(candidate => candidate.id === "a/d");
    expect(combo?.samples).toHaveLength(1);
    expect(combo?.samples[0]?.file).toBe("new.json");
    expect(combo?.verdict).toBe("inconclusive"); // one distinct run is not evidence
  });

  it("dedupes colliding (id, run): pinned beats unpinned, later file beats earlier", () => {
    const legacy = {
      file: "baseline-v0.json",
      summary: summary(undefined, [row("a/d", 0, false), row("a/d", 1, false)]),
    };
    const pinnedOld = {
      file: "runA.json",
      summary: summary("fp", [row("a/d", 0, false), row("a/d", 1, false)]),
    };
    const pinnedNew = {
      file: "runB.json",
      summary: summary("fp", [row("a/d", 0, true), row("a/d", 1, true)]),
    };

    // pinned wins over unpinned even when the legacy file comes later in CLI order
    const pinnedFirst = stitchReports([pinnedOld, legacy], { allowLegacy: true });
    const before = pinnedFirst.combos.find(combo => combo.id === "a/d");
    expect(before?.samples.map(sample => sample.file)).toEqual(["runA.json", "runA.json"]);
    expect(before?.verdict).toBe("allFail");

    // among pinned reports the later file wins, for every colliding key
    const laterWins = stitchReports([pinnedOld, pinnedNew]);
    const after = laterWins.combos.find(combo => combo.id === "a/d");
    expect(after?.samples.map(sample => sample.file)).toEqual(["runB.json", "runB.json"]);
    expect(after?.validRuns).toBe(2); // 2 keys, not 4 rows
    expect(after?.verdict).toBe("allPass");
  });

  it("reports rather than silently merges a resample disagreement", () => {
    const a = row("a/d", 0, false);
    const b = row("a/d", 0, true);
    const stitched = stitchReports([
      { file: "one.json", summary: summary("fp", [a]) },
      { file: "two.json", summary: summary("fp", [b]) },
    ]);
    expect(stitched.resampleDisagreements).toHaveLength(1);
    expect(stitched.resampleDisagreements[0]).toEqual({
      id: "a/d",
      run: 0,
      fileA: "one.json",
      outcomeA: "fail",
      fileB: "two.json",
      outcomeB: "pass",
      gatesA: FAIL_GATES,
      gatesB: PASS_GATES,
      keptFile: "two.json",
    });
    // ...and the disagreement surfaces in the rendered output
    expect(formatStitchMarkdown(stitched)).toContain("resample disagreements (1)");
  });

  it("flags a gate-only disagreement even when both rows pass", () => {
    const a = row("a/d", 0, true, { gates: FAIL_GATES });
    const b = row("a/d", 0, true);
    const stitched = stitchReports([
      { file: "one.json", summary: summary("fp", [a]) },
      { file: "two.json", summary: summary("fp", [b]) },
    ]);
    expect(stitched.resampleDisagreements).toHaveLength(1);
    expect(stitched.resampleDisagreements[0]?.outcomeA).toBe("pass");
    expect(stitched.resampleDisagreements[0]?.outcomeB).toBe("pass");
  });

  it("classifies verdicts only at >=2 distinct valid runs", () => {
    const stitched = stitchReports([
      {
        file: "one.json",
        summary: summary("fp", [
          row("p/all-pass", 0, true),
          row("p/all-pass", 1, true),
          row("p/all-fail", 0, false),
          row("p/all-fail", 1, false),
          row("p/mixed", 0, true),
          row("p/mixed", 1, false),
          row("p/single", 0, true),
        ]),
      },
      { file: "two.json", summary: summary("fp", [row("p/single", 0, true)]) },
    ]);
    const verdicts = Object.fromEntries(stitched.combos.map(combo => [combo.id, combo.verdict]));
    expect(verdicts).toEqual({
      "p/all-pass": "allPass",
      "p/all-fail": "allFail",
      "p/mixed": "mixed",
      "p/single": "inconclusive",
    });
    expect(stitched.counts).toEqual({ allPass: 1, allFail: 1, mixed: 1, inconclusive: 1 });
    expect(stitched.droppedQuotaRows).toBe(0);
  });
});

describe("stitch CLI", () => {
  const writeReport = (root: string, name: string, fp: string | undefined, results: readonly BaselineCaseResult[]): string => {
    const file = join(root, name);
    writeFileSync(file, `${JSON.stringify(summary(fp, results), null, 2)}\n`, "utf8");
    return file;
  };

  it("stitches two on-disk reports and prints the verdict table", () => {
    const root = mkdtempSync(join(tmpdir(), "kove-stitch-cli-"));
    try {
      const a = writeReport(root, "baseline-v0.json", undefined, [row("a/d", 0, false)]);
      const b = writeReport(root, "baseline-r1-include-18.json", "fp", [row("a/d", 0, true)]);
      expect(readReport(a).results).toHaveLength(1);

      const refused = renderCli([a, b]);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toMatch(/unpinned report\(s\) refused/);

      const ok = renderCli(["--allow-legacy", a, b]);
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout).toContain("| a/d | inconclusive | 1 |");
      expect(ok.stdout).toContain("baseline-v0.json` — fingerprint `(unpinned)`");
      expect(ok.stdout).toContain("resample disagreements (1)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects bad invocations without touching the filesystem", () => {
    expect(renderCli([]).exitCode).toBe(2);
    expect(renderCli(["only.json"]).exitCode).toBe(2);
    expect(renderCli(["--fancy", "a.json", "b.json"])).toMatchObject({
      exitCode: 2,
      stderr: expect.stringContaining("unknown flag"),
    });
    expect(renderCli(["missing-a.json", "missing-b.json"]).exitCode).toBe(1);
  });
});
