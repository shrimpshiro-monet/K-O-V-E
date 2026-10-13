import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeClientFromSend } from "../llm";
import { CORPUS_PATH, runBaseline } from "./baseline";
import { loadCorpus } from "./corpus";

/**
 * Live rerun of the corpus through the director — with the model REPLACED by
 * the local llm-stub (e2e-harness/llm-stub.mjs, OpenAI-compatible on
 * 127.0.0.1:8799). The production live spec (`baseline.test.ts`, gated on
 * KOVE_EVAL_BASELINE=1) measures model output against Workers AI; this spec
 * measures the PIPELINE itself: every corpus combo (9 detailed, 9 vague,
 * 9 genre) receives a structurally valid plan built from its own segment-map
 * ids, so with the model controlled, every remaining failure localizes to a
 * project-shape / genre-branch plumbing bug by construction.
 *
 * This is the genre-combo hypothesis closure experiment: if live Workers AI
 * gate rates showed genre combos failing while this rerun is uniformly green,
 * the failure class is model output (the LLM producing bad plans for genre
 * briefs), NOT the plan_edit → validation → materialization path.
 *
 *   KOVE_EVAL_LIVE_STUB=1 pnpm vitest run src/eval/live-stub.test.ts
 *
 * Optional: KOVE_EVAL_STUB_URL (default http://127.0.0.1:8799/v1/chat/completions),
 * KOVE_EVAL_K (default 3), KOVE_EVAL_ROOT — a directory holding a corpus
 * `projects.json` + its media (e.g. a local real-media corpus that must never
 * be committed; see evaluation-files/README.md).
 */
const LIVE = process.env.KOVE_EVAL_LIVE_STUB === "1";
const STUB = process.env.KOVE_EVAL_STUB_URL ?? "http://127.0.0.1:8799/v1/chat/completions";
const K = Number(process.env.KOVE_EVAL_K ?? "3") || 3;
const EVAL_ROOT = process.env.KOVE_EVAL_ROOT;
const CORPUS_FILE = EVAL_ROOT ? join(EVAL_ROOT, "projects.json") : CORPUS_PATH;

describe.skipIf(!LIVE)("baseline genre-combo via local llm-stub (pipeline-controlled live rerun)", () => {
  it(
    "every corpus combo gates green with the model controlled",
    async () => {
      const send = async (body: unknown): Promise<unknown> => {
        const res = await fetch(STUB, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          throw new Error(`llm-stub HTTP ${res.status}: ${await res.text()}`);
        }
        return res.json();
      };
      const client = makeClientFromSend({
        provider: "openai",
        model: "mock-director-1",
        omitMaxTokens: true,
        send,
      });

      const summary = await runBaseline({
        runsPerCombo: K,
        concurrency: 1,
        client,
        ...(EVAL_ROOT ? { root: EVAL_ROOT } : {}),
        reportPath: process.env.KOVE_EVAL_STUB_REPORT ?? "/home/user/kove-e2e-harness/eval-live-stub-report.json",
        onCase: (result) => {
          const gateLabel = [
            result.gates.planValidates ? "plan✓" : "plan✗",
            result.gates.materializes ? "mat✓" : "mat✗",
            result.gates.noClipOverlaps ? "overlap✓" : "overlap✗",
          ].join(" ");
          console.log(
            `[live-stub] run ${result.run} ${result.id} (${result.promptType}): ` +
              `${result.quotaExhausted ? "QUOTA" : result.ok ? "PASS" : "FAIL"} ${gateLabel} ` +
              `${result.stats.clipCount} clips / ${result.stats.transitionCount} tr, ` +
              `${(result.stats.durationMs / 1000).toFixed(1)}s` +
              (result.failures.length ? ` — ${result.failures.join(" | ")}` : "") +
              (result.warnings.length ? ` [warn: ${result.warnings.join(" | ")}]` : ""),
          );
        },
      });

      // Same harness correctness assertions as the live spec.
      const corpusSize = loadCorpus(CORPUS_FILE).flatMap(p => p.prompts).length;
      expect(summary.cases).toBe(corpusSize);
      expect(summary.runsPerCombo).toBe(K);
      expect(summary.total).toBe(corpusSize * K);
      expect(summary.quotaExcluded).toBe(0);
      for (const result of summary.results) {
        expect(typeof result.gates.planValidates, result.id).toBe("boolean");
        expect(typeof result.gates.materializes, result.id).toBe("boolean");
        expect(typeof result.gates.noClipOverlaps, result.id).toBe("boolean");
        expect(
          result.ok,
          `${result.id} run ${result.run}: ${result.failures.join(" | ")}`,
        ).toBe(result.gates.planValidates && result.gates.materializes && result.gates.noClipOverlaps);
      }
      const valid = summary.results;
      for (const rate of Object.values(summary.gateRates)) {
        expect(rate.validPerRun.reduce((s, n) => s + n, 0)).toBe(valid.length);
      }

      const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
      const line = (
        label: string,
        rate: { mean: number; stdev: number; perRun: readonly number[]; validPerRun: readonly number[] },
      ): string =>
        `${label} ${pct(rate.mean)} ± ${pct(rate.stdev)} ` +
        `[${rate.perRun.map((v, i) => `${pct(v)}/${rate.validPerRun[i]}`).join(", ")}]`;
      console.log(
        `[live-stub] k=${K}; valid ${valid.length}/${summary.total}; gate rates: ` +
          line("plan_validates", summary.gateRates.planValidates) + "; " +
          line("materializes", summary.gateRates.materializes) + "; " +
          line("no_clip_overlaps", summary.gateRates.noClipOverlaps) + "; " +
          line("all_three", summary.gateRates.allGates),
      );
      console.log(
        `[live-stub] determinism across k=${K}: stable pass ${summary.determinism.allPass}, ` +
          `stable fail ${summary.determinism.allFail}, mixed ${summary.determinism.mixed}` +
          (summary.determinism.mixedIds.length ? ` → ${summary.determinism.mixedIds.join(", ")}` : ""),
      );

      // Prompt-type aware rows: detect genre combos by the corpus' declared
      // prompt type, not the prompt-id suffix — a corpus may name prompts
      // `pod-01-genre` instead of `genre` (a local real-media corpus does).
      const rows = [...valid.reduce((map, r) => {
        const row = map.get(r.id) ?? { pass: 0, total: 0, promptType: r.promptType, failures: [] as string[] };
        row.total += 1;
        if (r.ok) row.pass += 1;
        else row.failures.push(...r.failures);
        map.set(r.id, row);
        return map;
      }, new Map<string, { pass: number; total: number; promptType: string; failures: string[] }>()).entries()];
      const failedCombos: string[] = [];
      console.log("[live-stub] per-combo gate rates:");
      for (const [id, row] of rows) {
        const rate = row.pass / row.total;
        console.log(`  ${rate === 1 ? "    " : " ***"} ${id.padEnd(28)} ${pct(rate)} (${row.pass}/${row.total})`);
        for (const f of [...new Set(row.failures)].slice(0, 2)) console.log(`         ↑ ${f.slice(0, 170)}`);
        if (rate < 1) failedCombos.push(id);
      }
      console.log(
        failedCombos.length
          ? `[live-stub] ${failedCombos.length} combo(s) below 100% with the model controlled — ` +
              `pipeline bugs localised by project/genre shape: ${failedCombos.join(", ")}`
          : `[live-stub] every combo green with the model controlled → genre-combo failures are ` +
              `model-output failures, not pipeline. Hypothesis closed.`,
      );

      // The measurement: with a controlled-correct model, genre combos must
      // gate green too. A red genre combo here is a pipeline bug — report it,
      // don't paper over it.
      const genreCombos = rows.filter(([, row]) => row.promptType === "genre");
      console.log(`[live-stub] genre combos asserted: ${genreCombos.length}/${rows.length}`);
      for (const [id, row] of genreCombos) {
        expect(row.pass, `genre combo ${id} failed with a controlled model: ${row.failures.join(" | ")}`).toBe(row.total);
      }
      // (and a sane pipeline means NOTHING fails)
      expect(
        failedCombos,
        `combos failing with a controlled model: ${failedCombos.join(", ")}`,
      ).toEqual([]);
    },
    30 * 60 * 1000,
  );
});
