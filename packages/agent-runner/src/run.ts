import {
  HeadlessHost,
  runTurn,
  toAnthropicTools,
  toOpenAITools,
  buildSystemPrompt,
  selectToolsForPrompt,
  executeTool,
  parseReferenceIntent,
  referenceIntentDirective,
} from "@kove-advanced/agent";
import type {
  LLMClient,
  RunTurnResult,
  JobRunner,
  ReferenceApplication,
} from "@kove-advanced/agent";
import type { Project } from "@kove-advanced/core/types/project";
import { fitProfileToFootage } from "@kove-advanced/core/mirror/fit-profile-to-footage";
import { makeNodeLLMClient, resolveLlmProvider, type LlmProvider } from "./node-llm";
import { loadProjectFile, saveProjectFile } from "./project-io";
import { createCompositorMirrorFrameRunner } from "./mirror-frame-runner";

export interface HeadlessEditOptions {
  readonly project: Project;
  readonly prompt: string;
  readonly provider: LlmProvider;
  /** Defaults to the provider's configured model (gateway) or requires --model. */
  readonly model?: string;
  readonly apiKey: string;
  /** Inject a client directly (tests / custom transports); overrides BYOK build. */
  readonly llm?: LLMClient;
  readonly jobRunner?: JobRunner;
  readonly maxTokens?: number;
  readonly limits?: { maxSteps?: number; maxToolCalls?: number };
  readonly dryRun?: boolean;
  readonly fetchFn?: typeof fetch;
  /** Gateway→Workers failover notice (CLI logs it to stderr). */
  readonly onFallback?: (error: unknown) => void;
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

/**
 * Applies the reference intent before the model's turn, the same way the app
 * does: a 1:1 intent rebuilds the footage from the project's EditDNA, and the
 * directive states what is already on the timeline so the model adds craft
 * instead of planning a second timeline.
 */
async function prepareReferencePrompt(
  host: HeadlessHost,
  prompt: string,
): Promise<{ prompt: string; applied: ReferenceApplication }> {
  const parsed = parseReferenceIntent(prompt);
  const project = host.getProject();
  const reference = project.mediaLibrary.items.find(
    (item) => item.type === "video" && item.analysisRole === "reference",
  );
  const intent = parsed.intent ?? (reference ? "reference" : null);
  if (!intent) return { prompt, applied: "none" };

  let applied: ReferenceApplication = "none";
  const profile = project.mirrorProfile;
  const sourceItems = project.mediaLibrary.items.filter(
    (item) => item.type === "video" && item.analysisRole !== "reference",
  );
  if (intent !== "reference" && profile && sourceItems.length) {
    // A reference longer than the footage is fitted to it, exactly like the
    // app does, so the structure can always be rebuilt.
    const available = sourceItems.reduce((sum, item) => sum + item.metadata.duration, 0);
    const fitted = fitProfileToFootage(profile, available);
    const applied1to1 = await executeTool(
      "mirror_reference_1to1",
      { profile: fitted.profile, userMediaIds: sourceItems.map((item) => item.id) },
      host,
    );
    if (applied1to1.ok) applied = "structure";
  }

  const directive = referenceIntentDirective({
    intent,
    referenceName: reference?.name ?? "reference",
    referenceMediaId: reference?.id,
    attached: Boolean(reference),
    applied,
    warnings: profile?.warnings ?? [],
    ...(profile
      ? {
          fps: `${profile.fps.num}/${profile.fps.den}`,
          durationSeconds: (profile.durationFrames * profile.fps.den) / profile.fps.num,
          shotCount: profile.shots.length,
          aspectRatio: `${profile.aspectRatio.width}x${profile.aspectRatio.height}`,
          dominantMoves: profile.shots.map(
            (shot) => shot.cameraMotion?.dominantMove ?? "unknown",
          ),
          beatCount: profile.beatGridMs.length,
          captionWindowCount: profile.shots.reduce(
            (sum, shot) => sum + shot.captionWindows.length,
            0,
          ),
        }
      : {}),
  });
  return { prompt: `${parsed.prompt}\n\n${directive}`, applied };
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
    // Resolve `auto` up front: the tool format must match the side the
    // ladder actually picked (anthropic vs OpenAI schemas).
    const provider = resolveLlmProvider(opts.provider);
    const llm =
      opts.llm ??
      makeNodeLLMClient({
        provider,
        model: opts.model,
        apiKey: opts.apiKey,
        maxTokens: opts.maxTokens,
        fetchFn: opts.fetchFn,
        onFallback: opts.onFallback,
      });
    const prepared = await prepareReferencePrompt(host, opts.prompt);
    const prompt = prepared.prompt;
    const selectedToolNames = selectToolsForPrompt(prompt);
    const tools =
      provider === "anthropic"
        ? toAnthropicTools(selectedToolNames)
        : toOpenAITools(selectedToolNames);

    const result = await runTurn({
      host,
      llm,
      tools,
      system: buildSystemPrompt(host, selectedToolNames),
      messages: [{ role: "user", content: prompt }],
      limits: opts.limits,
      dryRun: opts.dryRun,
      turnLabel: "Headless edit",
      directorPlanApplied: prepared.applied === "structure",
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
