import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { corpusAssets, loadCorpus, missingAssets, promptIds } from "./corpus";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const CORPUS_DIR = resolve(REPO_ROOT, "evaluation-files");
const CORPUS = resolve(CORPUS_DIR, "projects.json");

const corpusAvailable = existsSync(CORPUS);
const skipReason = "skipped: evaluation corpus not present; see docs/AGENT-EVAL-CORPUS.md";

describe.skipIf(!corpusAvailable)(`eval corpus${corpusAvailable ? "" : ` (${skipReason})`}`, () => {
  const corpus = corpusAvailable ? loadCorpus(CORPUS) : [];

  it("loads 9 projects with one prompt of each type", () => {
    expect(corpus).toHaveLength(9);
    expect(promptIds(corpus)).toHaveLength(27);
    for (const project of corpus) {
      const types = project.prompts.map(p => p.type).sort();
      expect(types).toEqual(["detailed", "genre", "vague"]);
    }
  });

  it("covers the five categories in the spec", () => {
    expect([...new Set(corpus.map(p => p.category))].sort()).toEqual([
      "game",
      "multi",
      "speech",
      "sport",
      "stream",
    ]);
  });

  it("resolves every referenced media, music and reference file on disk", () => {
    expect(missingAssets(corpus, CORPUS_DIR)).toEqual([]);
  });

  it("lists media plus optional music and reference per project", () => {
    const multi = corpus.find(p => p.id === "multi-03");
    expect(multi).toBeDefined();
    expect(corpusAssets(multi!)).toHaveLength(4);
  });
});
