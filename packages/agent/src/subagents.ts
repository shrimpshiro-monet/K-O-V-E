/**
 * Subagents: scoped, context-isolated workers the director can fan out to.
 *
 * Why they exist at all — the same two reasons coding agents grew them:
 *
 * 1. **Context isolation.** Every tool result the director makes is appended to
 *    its own conversation forever. Surveying a timeline, reading every clip and
 *    probing the audio can bury the actual request in tens of thousands of
 *    tokens before any edit happens. A subagent does that work in a fresh
 *    conversation and returns a paragraph; only the paragraph lands in the
 *    parent's history.
 *
 * 2. **Specialization.** One model holding all ~330 tool schemas spends part of
 *    its attention deciding which of them not to use. A subagent is handed the
 *    six tools its job needs and a system prompt that says what "done" looks
 *    like, which is a much easier problem.
 *
 * Speed comes from both: less context per completion, and independent scouts
 * running at the same time instead of one after another.
 *
 * Each subagent is a real `runTurn` — same host, same undo transaction
 * discipline, same retry and budget machinery — with its own system prompt,
 * tool allowlist, message list and budget. It cannot see the parent's history
 * and the parent only sees what it reports back.
 */

import { runTurn, type StopReason } from "./loop";
import type { EditingHost } from "./host";
import type { LLMClient, LLMUsage } from "./llm";

/** Turns a tool allowlist into provider-formatted tool defs. */
export type ToolFormatter = (names: readonly string[]) => unknown[];

export interface SubagentSpec {
  /** Stable id the orchestrator passes in `delegate_tasks`. */
  readonly name: string;
  /** Human label for logs and digests. */
  readonly title: string;
  /** What this worker is for — read by whoever delegates. */
  readonly description: string;
  /** Role prompt. This is the whole point of a subagent. */
  readonly system: string;
  /** Tool allowlist. Anything not listed is unreachable from the subagent. */
  readonly tools: readonly string[];
  /**
   * True when the subagent only reads. Read-only subagents are safe to run
   * alongside each other, so they are the ones that actually go parallel.
   */
  readonly readOnly?: boolean;
  readonly limits?: {
    readonly maxSteps?: number;
    readonly maxToolCalls?: number;
    readonly maxTokens?: number;
  };
}

export interface SubagentTask {
  /** A registered subagent name. */
  readonly agent: string;
  /** What to accomplish. Self-contained: the subagent sees nothing else. */
  readonly goal: string;
}

export type SubagentStopReason =
  | StopReason
  | "unknown_agent"
  | "no_tools"
  | "no_llm"
  | "error";

export interface SubagentOutcome {
  readonly agent: string;
  readonly goal: string;
  readonly ok: boolean;
  /** The subagent's final answer. Truncated before it reaches the parent. */
  readonly text: string;
  readonly toolCalls: number;
  readonly stoppedReason: SubagentStopReason;
  readonly usage: LLMUsage;
  readonly error?: string;
}

export interface RunSubagentsOptions {
  readonly host: EditingHost;
  readonly llm: LLMClient;
  /** `toAnthropicTools` or `toOpenAITools`, depending on the provider. */
  readonly formatTools: ToolFormatter;
  readonly specs: readonly SubagentSpec[];
  readonly tasks: readonly SubagentTask[];
  /**
   * "auto" (default) parallelizes only when every task is read-only, because
   * two writers holding transactions on one timeline is how you get torn edits.
   */
  readonly mode?: "auto" | "parallel" | "serial";
  /** Total token ceiling shared across every subagent in this fan-out. */
  readonly budget?: { readonly maxTokens?: number };
  readonly onOutcome?: (outcome: SubagentOutcome) => void;
}

const ZERO_USAGE: LLMUsage = { inputTokens: 0, outputTokens: 0 };

const DEFAULT_LIMITS = { maxSteps: 6, maxToolCalls: 16 };

/** Hard cap on how much of a subagent's answer reaches the parent's context. */
const DIGEST_TEXT_LIMIT = 1200;

const truncate = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
};

/**
 * Runs every task and returns one outcome per task, in the order asked.
 *
 * A task that names an unknown agent (or one whose tools are all missing)
 * fails as its own outcome rather than aborting the fan-out: one bad delegation
 * should cost one scout, not the whole request.
 */
export async function runSubagents(
  options: RunSubagentsOptions,
): Promise<SubagentOutcome[]> {
  const { host, llm, formatTools, specs, tasks, budget, onOutcome } = options;

  const byName = new Map(specs.map((spec) => [spec.name, spec]));

  const fail = (
    task: SubagentTask,
    stoppedReason: SubagentStopReason,
    error: string,
  ): SubagentOutcome => ({
    agent: task.agent,
    goal: task.goal,
    ok: false,
    text: "",
    toolCalls: 0,
    stoppedReason,
    usage: ZERO_USAGE,
    error,
  });

  // Shared ceiling: split evenly so a chatty scout cannot starve the rest.
  const total = budget?.maxTokens;
  const share =
    total !== undefined && tasks.length > 0
      ? Math.max(1, Math.floor(total / tasks.length))
      : undefined;

  const runOne = async (task: SubagentTask): Promise<SubagentOutcome> => {
    const spec = byName.get(task.agent);
    if (!spec) {
      const known = specs.map((entry) => entry.name).join(", ");
      return fail(task, "unknown_agent", `No subagent named "${task.agent}". Available: ${known}`);
    }

    let toolDefs: unknown[];
    try {
      toolDefs = formatTools(spec.tools);
    } catch (error) {
      return fail(task, "no_tools", `Could not resolve tools: ${message(error)}`);
    }
    if (toolDefs.length === 0) {
      return fail(task, "no_tools", `Subagent "${spec.name}" has no usable tools.`);
    }

    try {
      const result = await runTurn({
        host,
        llm,
        tools: toolDefs,
        system: spec.system,
        // The subagent's entire world: no parent history, no sibling traffic.
        messages: [{ role: "user", content: task.goal }],
        limits: {
          maxSteps: spec.limits?.maxSteps ?? DEFAULT_LIMITS.maxSteps,
          maxToolCalls: spec.limits?.maxToolCalls ?? DEFAULT_LIMITS.maxToolCalls,
          ...(spec.limits?.maxTokens ?? share
            ? { maxTokens: spec.limits?.maxTokens ?? share }
            : {}),
        },
        turnLabel: `subagent:${spec.name}`,
      });

      const outcome: SubagentOutcome = {
        agent: spec.name,
        goal: task.goal,
        ok: result.stoppedReason === "end_turn",
        text: truncate(result.text, DIGEST_TEXT_LIMIT),
        toolCalls: result.toolCalls,
        stoppedReason: result.stoppedReason,
        usage: result.usage,
      };
      onOutcome?.(outcome);
      return outcome;
    } catch (error) {
      return fail(task, "error", message(error));
    }
  };

  const anyWriter = tasks.some((task) => byName.get(task.agent)?.readOnly !== true);
  const parallel =
    options.mode === "parallel" ||
    (options.mode !== "serial" && !anyWriter && tasks.length > 1);

  if (!parallel) {
    const results: SubagentOutcome[] = [];
    for (const task of tasks) results.push(await runOne(task));
    return results;
  }

  return Promise.all(tasks.map(runOne));
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Collapses outcomes into the few hundred tokens the parent actually sees.
 *
 * This is the context-isolation payoff: N subagents may have made dozens of
 * tool calls and read thousands of tokens each, and the parent's history grows
 * by this string — not by any of it.
 */
export function formatSubagentDigest(outcomes: readonly SubagentOutcome[]): string {
  if (outcomes.length === 0) return "No subagent tasks ran.";

  const lines = outcomes.map((outcome, index) => {
    const status = outcome.ok ? "ok" : `FAILED (${outcome.stoppedReason})`;
    const head = `${index + 1}. [${outcome.agent}] ${status} · ${outcome.toolCalls} tool call(s)`;
    const body = outcome.ok
      ? outcome.text || "(no report)"
      : (outcome.error ?? outcome.text ?? "unknown error");
    // Truncated here as well as at the source: this string is what actually
    // enters the parent's history, so the ceiling belongs to the thing that
    // writes it rather than to whoever happened to build the outcome.
    return `${head}\n   ${truncate(body, DIGEST_TEXT_LIMIT)}`;
  });

  const failures = outcomes.filter((outcome) => !outcome.ok).length;
  const toolCalls = outcomes.reduce((sum, outcome) => sum + outcome.toolCalls, 0);
  const usage = outcomes.reduce<LLMUsage>(
    (sum, outcome) => ({
      inputTokens: sum.inputTokens + outcome.usage.inputTokens,
      outputTokens: sum.outputTokens + outcome.usage.outputTokens,
    }),
    ZERO_USAGE,
  );

  return [
    `${outcomes.length} subagent task(s): ${outcomes.length - failures} ok, ${failures} failed · ${toolCalls} tool call(s) · ${usage.inputTokens + usage.outputTokens} tokens.`,
    "",
    ...lines,
  ].join("\n");
}

/** One-line-per-agent catalogue for prompts and tool descriptions. */
export function describeSubagents(specs: readonly SubagentSpec[]): string {
  return specs
    .map((spec) => `- ${spec.name} (${spec.readOnly === true ? "read-only" : "can edit"}): ${spec.description}`)
    .join("\n");
}
