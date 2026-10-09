/**
 * Offline stitcher: merges >=2 baseline reports into one per-combo verdict table.
 *
 * Reports may come from different corpora (a clean-clone synthetic corpus vs a
 * local real-media corpus) that share project ids, so the stitch refuses any
 * input whose `corpusFingerprint` differs, and refuses unpinned reports (v0
 * predates the pin) unless `--allow-legacy` is passed for at most one file.
 *
 * Node-runnable standalone: only type-only imports from `./baseline`, so
 * `node --experimental-strip-types src/eval/stitch.ts` never resolves TS.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { BaselineGates, BaselineSummary } from "./baseline";

export class StitchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StitchError";
  }
}

export interface StitchInput {
  readonly file: string;
  readonly summary: BaselineSummary;
}

export interface StitchOptions {
  /**
   * Permit reports that predate the corpus pin. At most one file may be
   * unpinned: its attribution is established out-of-band, so a second one
   * would make the stitch's corpus claim unverifiable.
   */
  readonly allowLegacy?: boolean;
}

export type Verdict = "allPass" | "allFail" | "mixed" | "inconclusive";

export interface StitchSample {
  readonly file: string;
  readonly run: number;
  readonly ok: boolean;
  readonly gates: BaselineGates;
}

export interface ComboVerdict {
  readonly id: string;
  readonly verdict: Verdict;
  /** Distinct (id, run) samples surviving the dedupe; >=2 before a combo is conclusive. */
  readonly validRuns: number;
  readonly samples: readonly StitchSample[];
}

export interface ResampleDisagreement {
  readonly id: string;
  readonly run: number;
  readonly fileA: string;
  readonly outcomeA: "pass" | "fail";
  readonly fileB: string;
  readonly outcomeB: "pass" | "fail";
  readonly gatesA: BaselineGates;
  readonly gatesB: BaselineGates;
  /** Precedence winner (pinned first, then later file): the row the verdict used. */
  readonly keptFile: string;
}

export interface StitchResult {
  readonly files: readonly {
    readonly file: string;
    readonly corpusFingerprint: string | null;
  }[];
  /** Rows dropped before merging: quota is a transport event, not evidence. */
  readonly droppedQuotaRows: number;
  readonly combos: readonly ComboVerdict[];
  /**
   * Valid rows sharing an (id, run) key whose outcome or gates disagree.
   * Never merged silently: with temperature 0 and a pinned seed a repeated key
   * should reproduce, so a disagreement is a stability signal in itself.
   */
  readonly resampleDisagreements: readonly ResampleDisagreement[];
  readonly counts: Readonly<Record<Verdict, number>>;
}

interface Candidate {
  readonly id: string;
  readonly run: number;
  readonly file: string;
  readonly fileIndex: number;
  readonly pinned: boolean;
  readonly ok: boolean;
  readonly gates: BaselineGates;
}

const gatesKey = (gates: BaselineGates): string =>
  `${gates.planValidates}|${gates.materializes}|${gates.noClipOverlaps}`;

const outcome = (row: { readonly ok: boolean }): "pass" | "fail" => (row.ok ? "pass" : "fail");

export function readReport(file: string): BaselineSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new StitchError(
      `${file}: not readable as JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as BaselineSummary).results)) {
    throw new StitchError(`${file}: not a baseline report (missing results[])`);
  }
  return parsed as BaselineSummary;
}

export function stitchReports(
  inputs: readonly StitchInput[],
  opts: StitchOptions = {},
): StitchResult {
  if (inputs.length < 2) {
    throw new StitchError(`stitch needs at least 2 reports, got ${inputs.length}`);
  }
  for (const input of inputs) {
    if (!Array.isArray(input.summary?.results)) {
      throw new StitchError(`${input.file}: not a baseline report (missing results[])`);
    }
  }

  const allowLegacy = opts.allowLegacy === true;
  const legacy = inputs.filter(input => !input.summary.corpusFingerprint);
  if (!allowLegacy && legacy.length > 0) {
    throw new StitchError(
      `unpinned report(s) refused: ${legacy.map(input => input.file).join(", ")}. ` +
        `Pass --allow-legacy only when that report's corpus attribution is established out-of-band.`,
    );
  }
  if (allowLegacy && legacy.length > 1) {
    throw new StitchError(
      `--allow-legacy tolerates at most one unpinned report, got ${legacy.length}: ` +
        legacy.map(input => input.file).join(", "),
    );
  }

  const pinned = inputs.filter(input => Boolean(input.summary.corpusFingerprint));
  const expected = pinned[0]?.summary.corpusFingerprint;
  if (pinned.some(input => input.summary.corpusFingerprint !== expected)) {
    throw new StitchError(
      "corpus fingerprints differ - refusing to stitch reports measured against different corpora:\n" +
        inputs
          .map(input => `  ${input.file}: ${input.summary.corpusFingerprint ?? "(unpinned)"}`)
          .join("\n"),
    );
  }

  let droppedQuotaRows = 0;
  const ids = new Set<string>();
  const byKey = new Map<string, Candidate[]>();
  inputs.forEach((input, fileIndex) => {
    const isPinned = Boolean(input.summary.corpusFingerprint);
    for (const row of input.summary.results) {
      ids.add(row.id);
      if (row.quotaExhausted) {
        droppedQuotaRows += 1;
        continue;
      }
      const candidate: Candidate = {
        id: row.id,
        run: row.run,
        file: input.file,
        fileIndex,
        pinned: isPinned,
        ok: row.ok,
        gates: row.gates,
      };
      const key = `${row.id}#${row.run}`;
      const bucket = byKey.get(key);
      if (bucket) bucket.push(candidate);
      else byKey.set(key, [candidate]);
    }
  });

  // Dedupe: a repeated (id, run) is the same request under T=0 + a pinned seed,
  // so counting it twice would fake agreement. Precedence: pinned, then later file.
  const keptByKey = new Map<string, Candidate>();
  const resampleDisagreements: ResampleDisagreement[] = [];
  for (const [key, candidates] of byKey) {
    const ranked = [...candidates].sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || b.fileIndex - a.fileIndex,
    );
    const kept = ranked[0];
    if (kept) keptByKey.set(key, kept);

    const first = candidates[0];
    if (!first) continue;
    const clash = candidates.find(
      candidate =>
        candidate.ok !== first.ok || gatesKey(candidate.gates) !== gatesKey(first.gates),
    );
    if (clash && kept) {
      resampleDisagreements.push({
        id: first.id,
        run: first.run,
        fileA: first.file,
        outcomeA: outcome(first),
        fileB: clash.file,
        outcomeB: outcome(clash),
        gatesA: first.gates,
        gatesB: clash.gates,
        keptFile: kept.file,
      });
    }
  }

  const byCombo = new Map<string, Candidate[]>();
  for (const candidate of keptByKey.values()) {
    const bucket = byCombo.get(candidate.id);
    if (bucket) bucket.push(candidate);
    else byCombo.set(candidate.id, [candidate]);
  }

  const combos: ComboVerdict[] = [...ids].sort().map(id => {
    const rows = (byCombo.get(id) ?? []).sort((a, b) => a.run - b.run);
    const verdict: Verdict =
      rows.length < 2
        ? "inconclusive"
        : rows.every(row => row.ok)
          ? "allPass"
          : rows.every(row => !row.ok)
            ? "allFail"
            : "mixed";
    return {
      id,
      verdict,
      validRuns: rows.length,
      samples: rows.map(row => ({ file: row.file, run: row.run, ok: row.ok, gates: row.gates })),
    };
  });

  const counts: Record<Verdict, number> = { allPass: 0, allFail: 0, mixed: 0, inconclusive: 0 };
  for (const combo of combos) counts[combo.verdict] += 1;

  return {
    files: inputs.map(input => ({
      file: input.file,
      corpusFingerprint: input.summary.corpusFingerprint ?? null,
    })),
    droppedQuotaRows,
    combos,
    resampleDisagreements,
    counts,
  };
}

export function formatStitchMarkdown(result: StitchResult): string {
  const lines: string[] = [];
  lines.push("## Stitched baseline verdicts");
  lines.push("");
  for (const file of result.files) {
    lines.push(`- \`${file.file}\` — fingerprint \`${file.corpusFingerprint ?? "(unpinned)"}\``);
  }
  lines.push("");
  lines.push(
    `quota rows dropped: ${result.droppedQuotaRows} · ` +
      `allPass ${result.counts.allPass} · allFail ${result.counts.allFail} · ` +
      `mixed ${result.counts.mixed} · inconclusive ${result.counts.inconclusive}`,
  );
  lines.push("");
  lines.push("| combo | verdict | valid runs | samples |");
  lines.push("| --- | --- | --- | --- |");
  for (const combo of result.combos) {
    const samples = combo.samples
      .map(sample => `run${sample.run} ${sample.ok ? "pass" : "fail"} @${sample.file}`)
      .join("<br>");
    lines.push(`| ${combo.id} | ${combo.verdict} | ${combo.validRuns} | ${samples} |`);
  }
  if (result.resampleDisagreements.length > 0) {
    lines.push("");
    lines.push(`### resample disagreements (${result.resampleDisagreements.length})`);
    lines.push("");
    lines.push("| combo | run | A | B | kept |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const row of result.resampleDisagreements) {
      lines.push(
        `| ${row.id} | ${row.run} | ${row.outcomeA} @${row.fileA} | ` +
          `${row.outcomeB} @${row.fileB} | ${row.keptFile} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export interface CliOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function renderCli(argv: readonly string[]): CliOutput {
  const flags = new Set(argv.filter(arg => arg.startsWith("--")));
  const files = argv.filter(arg => !arg.startsWith("--"));
  const unknown = [...flags].filter(flag => flag !== "--allow-legacy");
  if (unknown.length > 0) {
    return { exitCode: 2, stdout: "", stderr: `unknown flag(s): ${unknown.join(", ")}\n` };
  }
  if (files.length < 2) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "usage: stitch [--allow-legacy] <report.json> <report.json> [more.json ...]\n",
    };
  }
  try {
    const inputs = files.map(file => ({ file, summary: readReport(file) }));
    const result = stitchReports(inputs, { allowLegacy: flags.has("--allow-legacy") });
    return { exitCode: 0, stdout: formatStitchMarkdown(result), stderr: "" };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const output = renderCli(process.argv.slice(2));
  if (output.stdout) process.stdout.write(output.stdout);
  if (output.stderr) process.stderr.write(output.stderr);
  process.exitCode = output.exitCode;
}
