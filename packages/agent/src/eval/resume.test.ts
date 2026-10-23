import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LLMClient } from "../llm";
import { CORPUS_PATH, runBaseline, type BaselineCaseResult } from "./baseline";

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
  it("skips measured case-runs, re-runs prior quota rows, and merges to complete", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kove-eval-resume-"));
    const reportPath = join(dir, "report.json");
    const quotaRow: BaselineCaseResult = {
      ...measuredRow("pod-01/pod-01-detailed"),
      ok: false,
      quotaExhausted: true,
      gates: { planValidates: false, materializes: false, noClipOverlaps: false },
      failures: ["quota"],
    };
    writeFileSync(
      reportPath,
      JSON.stringify({
        results: [measuredRow("pod-01/pod-01-genre"), measuredRow("pod-01/pod-01-vague"), quotaRow],
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
    expect(seen).not.toContain("pod-01/pod-01-genre|0");
    expect(seen).not.toContain("pod-01/pod-01-vague|0");
    // The quota row was never measured, so resume re-runs it.
    expect(seen).toContain("pod-01/pod-01-detailed|0");

    expect(summary.status).toBe("complete");
    expect(summary.total).toBe(summary.cases);
    expect(summary.quotaExcluded).toBe(0);

    const written = JSON.parse(readFileSync(reportPath, "utf8")) as {
      results: BaselineCaseResult[];
    };
    expect(written.results).toHaveLength(summary.cases);
    expect(written.results.filter(r => r.quotaExhausted)).toHaveLength(0);
    expect(written.results.find(r => r.id === "pod-01/pod-01-genre")?.ok).toBe(true);
  }, 300_000);
});
