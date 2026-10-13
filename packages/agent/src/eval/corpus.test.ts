import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { corpusAssets, loadCorpus, missingAssets, promptIds } from "./corpus";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const CORPUS_DIR = resolve(REPO_ROOT, "evaluation-files");
const CORPUS = resolve(CORPUS_DIR, "projects.json");

// The corpus is real media metadata and is never committed (standing rule 2):
// it exists only on machines set up for evaluation. Skip — don't fail — where
// it is absent, so restricted environments still get a green signal. The
// corpus loads lazily inside each test because vitest still collects the
// describe body for skipped suites.
const HAS_CORPUS = existsSync(CORPUS);
const loadCorpusIfExists = () => loadCorpus(CORPUS);

describe.skipIf(!HAS_CORPUS)("eval corpus", () => {
  it("loads 9 projects with one prompt of each type", () => {
    const corpus = loadCorpusIfExists();
    expect(corpus).toHaveLength(9);
    expect(promptIds(corpus)).toHaveLength(27);
    for (const project of corpus) {
      const types = project.prompts.map(p => p.type).sort();
      expect(types).toEqual(["detailed", "genre", "vague"]);
    }
  });

  it("covers the five categories in the spec", () => {
    const corpus = loadCorpusIfExists();
    expect([...new Set(corpus.map(p => p.category))].sort()).toEqual([
      "game",
      "multi",
      "speech",
      "sport",
      "stream",
    ]);
  });

  it("resolves every referenced media, music and reference file on disk", () => {
    const corpus = loadCorpusIfExists();
    expect(missingAssets(corpus, CORPUS_DIR)).toEqual([]);
  });

  it("lists media plus optional music and reference per project", () => {
    const corpus = loadCorpusIfExists();
    const multi = corpus.find(p => p.id === "multi-03");
    expect(multi).toBeDefined();
    expect(corpusAssets(multi!)).toHaveLength(4);
  });
});
