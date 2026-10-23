import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LLMClient } from "../llm";
import { CORPUS_PATH, rowsPathFor, runBaseline, type BaselineCaseResult } from "./baseline";

function measuredRow(id: string): BaselineCaseResult {
  const [projectId, promptId] = id.split("/");
  return {
    id,
    run: 0,
    projectId: projectId!,
    promptId: promptId!,
    promptType: "vague",
    ok: true,
    toolCode: null,
    quotaExhausted: false,
    infraFailure: false,
    gates: { planValidates: true, materializes: true, noClipOverlaps: true },
    failures: [],
    warnings: [],
    stats: {
      durationMs: 1,
      clipCount: 12,
      transitionCount: 2,
      effectCount: 1,
      audioCount: 0,
      textCount: 0,
      planScore: null,
      timelineDuration: 45,
    },
  };
}

describe.skipIf(!existsSync(CORPUS_PATH))("runBaseline resume", () => {
  it("skips measured case-runs, re-runs prior quota and infra rows, and merges to complete", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kove-eval-resume-"));
    const reportPath = join(dir, "report.json");
    const quotaRow: BaselineCaseResult = {
      ...measuredRow("pod-01/pod-01-detailed"),
      ok: false,
      quotaExhausted: true,
      gates: { planValidates: false, materializes: false, noClipOverlaps: false },
      failures: ["quota"],
    };
    const infraRow: BaselineCaseResult = {
      ...measuredRow("pod-01/pod-01-genre"),
      id: "pod-01/pod-01-genre",
      ok: false,
      toolCode: "TOOL_ERROR",
      infraFailure: true,
      gates: { planValidates: false, materializes: false, noClipOverlaps: false },
      failures: ["plan_edit failed [TOOL_ERROR]: fetch failed"],
    };
    writeFileSync(
      reportPath,
      JSON.stringify({
        model: "injected-client",
        results: [measuredRow("pod-01/pod-01-vague"), quotaRow, infraRow],
      }),
      "utf8",
    );

    const client = {
      complete: async () => ({ text: "no plan here", toolUses: [], stopReason: "stop" }),
    } as unknown as LLMClient;
    const seen: string[] = [];
    const summary = await runBaseline({
      client,
      resume: true,
      runsPerCombo: 1,
      reportPath,
      concurrency: 3,
      onCase: result => seen.push(`${result.id}|${result.run}`),
    });

    // Already-measured case-runs are never re-sent to the model.
    expect(seen).not.toContain("pod-01/pod-01-vague|0");
    // Quota and infra rows were never measured, so resume re-runs them.
    expect(seen).toContain("pod-01/pod-01-detailed|0");
    expect(seen).toContain("pod-01/pod-01-genre|0");

    expect(summary.status).toBe("complete");
    expect(summary.total).toBe(summary.cases);
    expect(summary.quotaExcluded).toBe(0);
    expect(summary.infraExcluded).toBe(0);

    const written = JSON.parse(readFileSync(reportPath, "utf8")) as {
      results: BaselineCaseResult[];
    };
    expect(written.results).toHaveLength(summary.cases);
    expect(written.results.filter(r => r.quotaExhausted || r.infraFailure)).toHaveLength(0);
    expect(written.results.find(r => r.id === "pod-01/pod-01-vague")?.ok).toBe(true);
  }, 300_000);

  it("recovers settled rows from the JSONL journal even when the report was never written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kove-eval-resume-journal-"));
    const reportPath = join(dir, "report.json");
    // Journal has one settled row; the (missing) report would have said zero.
    writeFileSync(rowsPathFor(reportPath), `${JSON.stringify(measuredRow("pod-01/pod-01-vague"))}\n`, "utf8");

    const client = {
      complete: async () => ({ text: "no plan here", toolUses: [], stopReason: "stop" }),
    } as unknown as LLMClient;
    const seen: string[] = [];
    const summary = await runBaseline({
      client,
      resume: true,
      runsPerCombo: 1,
      reportPath,
      concurrency: 3,
      onCase: result => seen.push(`${result.id}|${result.run}`),
    });
    expect(seen).not.toContain("pod-01/pod-01-vague|0");
    expect(summary.total).toBe(summary.cases);
  }, 300_000);

  it("refuses to merge rows measured with a different model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kove-eval-resume-model-"));
    const reportPath = join(dir, "report.json");
    writeFileSync(
      reportPath,
      JSON.stringify({ model: "vendor/other-model", results: [measuredRow("pod-01/pod-01-vague")] }),
      "utf8",
    );

    const priorKey = process.env.OMNIROUTE_KEY;
    const priorModel = process.env.OMNIROUTE_MODEL;
    process.env.OMNIROUTE_KEY = "test-key";
    process.env.OMNIROUTE_MODEL = "vendor/current-model";
    try {
      const client = {
        complete: async () => ({ text: "no plan here", toolUses: [], stopReason: "stop" }),
      } as unknown as LLMClient;
      // opts.client bypasses llmConfig, so the guard must fire on the
      // provider-selected path instead: call without an injected client.
      await expect(
        runBaseline({ resume: true, runsPerCombo: 1, reportPath, concurrency: 1 }),
      ).rejects.toThrow(/Refusing to resume/);
      // Sanity: with no client and no mismatch context the suite still has a
      // usable injected-client path (guard is config-driven only).
      expect(client).toBeDefined();
    } finally {
      if (priorKey === undefined) delete process.env.OMNIROUTE_KEY;
      else process.env.OMNIROUTE_KEY = priorKey;
      if (priorModel === undefined) delete process.env.OMNIROUTE_MODEL;
      else process.env.OMNIROUTE_MODEL = priorModel;
    }
  }, 60_000);
});
