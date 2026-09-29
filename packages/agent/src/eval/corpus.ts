import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export type PromptType = "detailed" | "vague" | "genre";

export interface EvalPrompt {
  readonly id: string;
  readonly type: PromptType;
  readonly text: string;
}

export interface EvalProject {
  readonly id: string;
  readonly category: string;
  readonly media: readonly string[];
  readonly music: string | null;
  readonly reference: string | null;
  readonly notes: string;
  readonly prompts: readonly EvalPrompt[];
}

const PROMPT_TYPES: readonly PromptType[] = ["detailed", "vague", "genre"];

export function parseCorpus(raw: string): EvalProject[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("corpus must be a JSON array");

  return parsed.map((entry, index) => {
    const project = entry as Partial<EvalProject>;
    const where = `projects[${index}]`;
    if (typeof project?.id !== "string" || !project.id) {
      throw new Error(`${where} is missing id`);
    }
    if (!Array.isArray(project.media) || project.media.length === 0) {
      throw new Error(`${where} (${project.id}) has no media`);
    }
    if (!Array.isArray(project.prompts) || project.prompts.length === 0) {
      throw new Error(`${where} (${project.id}) has no prompts`);
    }
    for (const prompt of project.prompts) {
      if (typeof prompt?.id !== "string" || !prompt.id) {
        throw new Error(`${where} (${project.id}) has a prompt without id`);
      }
      if (!PROMPT_TYPES.includes(prompt.type)) {
        throw new Error(`${where} prompt ${prompt.id} has unknown type "${String(prompt.type)}"`);
      }
      if (typeof prompt.text !== "string" || !prompt.text.trim()) {
        throw new Error(`${where} prompt ${prompt.id} has no text`);
      }
    }
    return {
      id: project.id,
      category: String(project.category ?? ""),
      media: project.media.map(String),
      music: project.music ?? null,
      reference: project.reference ?? null,
      notes: String(project.notes ?? ""),
      prompts: project.prompts,
    };
  });
}

export function loadCorpus(path: string): EvalProject[] {
  return parseCorpus(readFileSync(path, "utf8"));
}

export function corpusAssets(project: EvalProject): string[] {
  return [...project.media, ...(project.music ? [project.music] : []), ...(project.reference ? [project.reference] : [])];
}

export function resolveCorpusFile(root: string, relative: string): string {
  return isAbsolute(relative) ? relative : resolve(root, relative);
}

/**
 * Hard gate: every asset a project names must exist before any run.
 * `root` is the directory the corpus's relative paths resolve against —
 * the folder holding projects.json, not the repo root.
 */
export function missingAssets(corpus: readonly EvalProject[], root: string): string[] {
  const missing = new Set<string>();
  for (const project of corpus) {
    for (const asset of corpusAssets(project)) {
      if (!existsSync(resolveCorpusFile(root, asset))) {
        missing.add(`${project.id}: ${asset}`);
      }
    }
  }
  return [...missing];
}

export function promptIds(corpus: readonly EvalProject[]): string[] {
  return corpus.flatMap(project => project.prompts.map(prompt => `${project.id}/${prompt.id}`));
}

export const DEFAULT_CORPUS_PATH = join("evaluation-files", "projects.json");
