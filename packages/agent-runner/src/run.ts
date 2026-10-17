import {
  HeadlessHost,
  runTurn,
  toAnthropicTools,
  toOpenAITools,
  buildSystemPrompt,
  selectToolsForPrompt,
} from "@kove-advanced/agent";
import type { LLMClient, RunTurnResult, JobRunner } from "@kove-advanced/agent";
import type { Project } from "@kove-advanced/core/types/project";
import { makeNodeLLMClient, type LlmProvider } from "./node-llm";
import { loadProjectFile, saveProjectFile } from "./project-io";
import { createCompositorMirrorFrameRunner } from "./mirror-frame-runner";

export interface HeadlessEditOptions {
  readonly project: Project;
  readonly prompt: string;
  readonly provider: LlmProvider;
  readonly model: string;
  readonly apiKey: string;
  /** Inject a client directly (tests / custom transports); overrides BYOK build. */
  readonly llm?: LLMClient;
  readonly jobRunner?: JobRunner;
  readonly maxTokens?: number;
  readonly limits?: { maxSteps?: number; maxToolCalls?: number };
  readonly dryRun?: boolean;
  readonly fetchFn?: typeof fetch;
  /** Opt in to real FFmpeg reference + Chromium timeline sampling for mirror_refine.
   * mediaPaths binds serialized media IDs to local files; absent media fails. */
  readonly mirror?: {
    referencePath: string;
    mediaPaths?: Readonly<Record<string, string>>;
    ffmpegPath?: string;
    chromiumExecutablePath?: string;
  };
}

export interface HeadlessEditResult {
  readonly project: Project;
  readonly result: RunTurnResult;
  /** Whether runHeadlessEditFile persisted the project (false on error/dry-run). */
  readonly saved?: boolean;
}

/** Runs one headless agent editing turn against an in-memory project. */
export async function runHeadlessEdit(
  opts: HeadlessEditOptions,
): Promise<HeadlessEditResult> {
  const mirror = opts.mirror && createCompositorMirrorFrameRunner({
    ...opts.mirror,
    getProject: (): Project => host.getProject(),
  });
  const host: HeadlessHost = new HeadlessHost(opts.project, { jobRunner: opts.jobRunner, mirrorFrameRunner: mirror?.sample });
  try {
    const llm =
      opts.llm ??
      makeNodeLLMClient({
        provider: opts.provider,
        model: opts.model,
        apiKey: opts.apiKey,
        maxTokens: opts.maxTokens,
        fetchFn: opts.fetchFn,
      });
    const selectedToolNames = selectToolsForPrompt(opts.prompt);
    const tools =
      opts.provider === "anthropic"
        ? toAnthropicTools(selectedToolNames)
        : toOpenAITools(selectedToolNames);

    const result = await runTurn({
      host,
      llm,
      tools,
      system: buildSystemPrompt(host, selectedToolNames),
      messages: [{ role: "user", content: opts.prompt }],
      limits: opts.limits,
      dryRun: opts.dryRun,
      turnLabel: "Headless edit",
    });

    return { project: host.getProject(), result };
  } finally {
    await mirror?.close();
  }
}

export interface HeadlessEditFileOptions
  extends Omit<HeadlessEditOptions, "project"> {
  readonly projectPath: string;
  /** Where to write the result; defaults to in-place (projectPath). */
  readonly outPath?: string;
}

/** Loads a stored project, runs an editing turn, and saves the result. */
export async function runHeadlessEditFile(
  opts: HeadlessEditFileOptions,
): Promise<HeadlessEditResult> {
  const project = await loadProjectFile(opts.projectPath);
  const { project: edited, result } = await runHeadlessEdit({ ...opts, project });
  // Don't persist a failed turn (it rolled back) or a dry-run (no mutations applied).
  const saved =
    !opts.dryRun && result.stoppedReason !== "error" && result.committed;
  if (saved) {
    await saveProjectFile(opts.outPath ?? opts.projectPath, edited);
  }
  return { project: edited, result, saved };
}
