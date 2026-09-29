import type { EditingHost } from "./host";
import type { AgentEvent, ConfirmDecision, ToolCall, ToolResult } from "./types";
import type {
  LLMClient,
  LoopMessage,
  LLMUsage,
  LoopToolResult,
  LoopToolResultBlock,
} from "./llm";
import { executeTool, isDestructive, isExpensive } from "./executor";
import { getTool, hasExistingDirectorPlan } from "./registry";

export interface RunTurnInput {
  readonly host: EditingHost;
  readonly llm: LLMClient;
  /** Provider-formatted tool defs (registry.toAnthropicTools()/toOpenAITools()). */
  readonly tools: unknown[];
  readonly system?: string;
  /** Conversation so far; the new user turn should already be appended. */
  readonly messages: LoopMessage[];
  readonly confirmGate?: (call: ToolCall) => Promise<ConfirmDecision> | ConfirmDecision;
  readonly onEvent?: (event: AgentEvent) => void;
  /**
   * maxTokens is a soft ceiling checked between steps: the turn stops before the
   * next completion once cumulative usage reaches it, so it can overshoot by at
   * most the step that crosses the threshold (it can't un-spend a completion).
   */
  readonly limits?: { maxSteps?: number; maxToolCalls?: number; maxTokens?: number };
  readonly dryRun?: boolean;
  readonly turnLabel?: string;
  /** Run the mandatory director checkup before editing turns. */
  readonly enforceDirectorWorkflow?: boolean;
}

export type StopReason =
  | "end_turn"
  | "max_steps"
  | "max_tool_calls"
  | "budget"
  | "error";

export interface RunTurnResult {
  readonly text: string;
  readonly messages: LoopMessage[];
  readonly toolCalls: number;
  readonly stoppedReason: StopReason;
  readonly committed: boolean;
  readonly usage: LLMUsage;
}

const isReadOnly = (name: string): boolean => getTool(name)?.readOnly ?? false;

const isDirectorDiscoveryTool = (name: string): boolean =>
  name === "extract_segments" || name === "create_project" || name === "list_media" || name === "import_media_from_url" || name === "get_capabilities" || name === "get_editor_state";

const DIRECTOR_REQUEST = /\b(edit|video|footage|clip|cut|trim|highlight|reel|montage|reference|b-roll|vlog|podcast|timeline|sequence|splice|join)\b/i;

/**
 * Transient error codes that warrant a single retry before giving up.
 * These typically indicate a temporary state issue rather than a real failure.
 */
const RETRYABLE_CODES = new Set([
  "NOT_FOUND",
  "CLIP_NOT_FOUND",
  "TRACK_NOT_FOUND",
  "INVALID_PARAMS",
]);

/**
 * Execute a tool with retry logic for transient failures.
 * On the first retryable failure, waits briefly and tries once more.
 * Non-retryable errors are returned immediately with enhanced context.
 */
async function executeToolWithRetry(
  name: string,
  args: Record<string, unknown> | undefined,
  host: EditingHost,
): Promise<ToolResult> {
  const result = await executeTool(name, args, host);
  if (result.ok || !result.error) return result;

  // Only retry on the first attempt for retryable codes
  if (RETRYABLE_CODES.has(result.error.code)) {
    // Brief pause to let state settle (e.g., clip IDs updating after a split)
    await new Promise((resolve) => setTimeout(resolve, 50));
    const retry = await executeTool(name, args, host);
    if (retry.ok) return retry;
    // Return the retry result (which may have a better error message)
    return enhanceToolError(name, retry);
  }

  return enhanceToolError(name, result);
}

/**
 * Enhance tool error results with actionable guidance for the LLM.
 * Instead of raw error codes, provide context that helps the model
 * understand what went wrong and what to try next.
 */
function enhanceToolError(name: string, result: ToolResult): ToolResult {
  if (result.ok || !result.error) return result;

  const { code, message } = result.error;
  let hint: string | undefined;

  switch (code) {
    case "NOT_FOUND":
    case "CLIP_NOT_FOUND":
      hint = "The referenced clip may have been split, moved, or deleted. Call list_clips to refresh clip IDs before retrying.";
      break;
    case "TRACK_NOT_FOUND":
      hint = "The track may have been removed. Call list_tracks to see available tracks.";
      break;
    case "INVALID_PARAMS":
      hint = `Check the parameters for ${name}. Use get_capabilities to see valid enum values and parameter ranges.`;
      break;
    case "NO_VIDEO_MEDIA":
      hint = "Import at least one video file before editing. Use import_media_from_url or drag files into the project.";
      break;
    case "PLAN_REQUIRED":
      hint = "Call plan_edit before any editing tools when working with footage.";
      break;
    case "UNKNOWN_TOOL":
      hint = `No tool named '${name}'. Check the available tools with get_capabilities.`;
      break;
    case "ACTION_FAILED":
      hint = `The action for ${name} failed. Check parameter values against get_capabilities and try again.`;
      break;
    default:
      // No hint for unknown error codes
      break;
  }

  if (hint) {
    return {
      ...result,
      error: {
        code,
        message: `${message}\n\nHint: ${hint}`,
      },
    };
  }

  return result;
}

function latestUserPrompt(messages: LoopMessage[]): string {
  return [...messages]
    .reverse()
    .find((message): message is Extract<LoopMessage, { role: "user" }> => message.role === "user")
    ?.content ?? "";
}

const DATA_URL_PREFIX = /^data:([^;,]+)?(?:;[^,]*)?,/;

function stripDataUrlPrefix(dataUrl: string): {
  base64: string;
  mimeType: string;
} {
  const match = DATA_URL_PREFIX.exec(dataUrl);
  if (match) {
    return {
      base64: dataUrl.slice(match[0].length),
      mimeType: match[1] || "image/png",
    };
  }
  return { base64: dataUrl, mimeType: "image/png" };
}

function buildToolResultContent(
  result: ToolResult,
): string | LoopToolResultBlock[] {
  const text = JSON.stringify({
    ok: result.ok,
    summary: result.summary,
    data: result.data,
    error: result.error,
  });
  if (!result.image) return text;
  const { base64, mimeType } = stripDataUrlPrefix(result.image.dataUrl);
  return [
    { type: "text", text },
    {
      type: "image",
      source: {
        type: "base64",
        media_type: result.image.mimeType ?? mimeType,
        data: base64,
      },
    },
  ];
}

export async function runTurn(input: RunTurnInput): Promise<RunTurnResult> {
  const {
    host,
    llm,
    tools,
    system,
    confirmGate,
    onEvent,
    dryRun = false,
    turnLabel = "AI edit",
    enforceDirectorWorkflow = false,
  } = input;
  const maxSteps = input.limits?.maxSteps ?? 12;
  const maxToolCalls = input.limits?.maxToolCalls ?? 64;
  const maxTokens = input.limits?.maxTokens;

  const emit = (event: AgentEvent): void => onEvent?.(event);
  const messages: LoopMessage[] = [...input.messages];
  let toolCalls = 0;
  let approveAll = false;
  let lastText = "";
  const usage: { inputTokens: number; outputTokens: number } = {
    inputTokens: 0,
    outputTokens: 0,
  };

  const projectId = host.getProject().id ?? "__default__";
  const hasExistingPlan = hasExistingDirectorPlan(projectId);
  // Only force a fresh plan_edit if there's no existing director plan for this
  // project. Follow-up editing requests ("make it shorter", "add a cut here")
  // should use clip/effect/text tools to modify the existing timeline rather
  // than rebuilding from scratch.
  const requiresDirectorPlan =
    enforceDirectorWorkflow && !hasExistingPlan && DIRECTOR_REQUEST.test(latestUserPrompt(messages));
  let directorPlanCompleted = !requiresDirectorPlan;
  let planEditApplied = false;

  const txn = host.beginTransaction(turnLabel);

  try {
    if (requiresDirectorPlan) {
      const checkup = ["get_capabilities", "get_editor_state", "list_media"] as const;
      const checkupUses = checkup.map((name, index) => ({
        id: `checkup-${index + 1}`,
        name,
        input: {},
      }));
      messages.push({ role: "assistant", content: "", toolUses: checkupUses });
      const checkupResults: LoopToolResult[] = [];
      for (const toolUse of checkupUses) {
        toolCalls++;
        const call: ToolCall = { id: toolUse.id, name: toolUse.name, args: {} };
        emit({ type: "tool_call", call });
        const result = await executeTool(toolUse.name, {}, host);
        emit({ type: "tool_result", call, result });
        checkupResults.push({
          toolUseId: toolUse.id,
          content: buildToolResultContent(result),
          isError: !result.ok,
        });
      }
      messages.push({ role: "tool", results: checkupResults });
    }

    for (let step = 0; step < maxSteps; step++) {
      if (
        maxTokens !== undefined &&
        usage.inputTokens + usage.outputTokens >= maxTokens
      ) {
        host.commitTransaction(txn, turnLabel);
        return {
          text: lastText,
          messages,
          toolCalls,
          stoppedReason: "budget",
          committed: true,
          usage,
        };
      }
      const response = await llm.complete({ system, messages, tools });
      lastText = response.text;
      if (response.usage) {
        usage.inputTokens += response.usage.inputTokens;
        usage.outputTokens += response.usage.outputTokens;
      }
      if (response.text) emit({ type: "text_delta", text: response.text });

      if (response.toolUses.length === 0) {
        messages.push({ role: "assistant", content: response.text, toolUses: [] });
        host.commitTransaction(txn, turnLabel);
        emit({ type: "turn_complete", text: response.text });
        return {
          text: response.text,
          messages,
          toolCalls,
          stoppedReason: response.stopReason === "max_tokens" ? "budget" : "end_turn",
          committed: true,
          usage,
        };
      }

      messages.push({
        role: "assistant",
        content: response.text,
        toolUses: response.toolUses,
      });

      const results: LoopToolResult[] = [];
      let hitToolCallLimit = false;
      for (let ti = 0; ti < response.toolUses.length; ti++) {
        const toolUse = response.toolUses[ti];
        if (toolCalls >= maxToolCalls) {
          // Answer every remaining tool_use so the transcript stays valid for
          // resumption (an unanswered tool_use is rejected by both providers).
          for (let ri = ti; ri < response.toolUses.length; ri++) {
            const pending = response.toolUses[ri];
            const capped = {
              ok: false as const,
              summary: "Tool-call budget reached",
              error: {
                code: "MAX_TOOL_CALLS",
                message: "Per-turn tool-call limit reached",
              },
            };
            emit({
              type: "tool_result",
              call: { id: pending.id, name: pending.name, args: pending.input },
              result: capped,
            });
            results.push({
              toolUseId: pending.id,
              content: JSON.stringify(capped),
              isError: true,
            });
          }
          hitToolCallLimit = true;
          break;
        }
        toolCalls++;
        const call: ToolCall = {
          id: toolUse.id,
          name: toolUse.name,
          args: toolUse.input,
        };
        emit({ type: "tool_call", call });

        if (
          requiresDirectorPlan &&
          !directorPlanCompleted &&
          call.name !== "plan_edit" &&
          !isReadOnly(call.name) &&
          !isDirectorDiscoveryTool(call.name)
        ) {
          const blocked = {
            ok: false as const,
            summary: "Planning is required before editing",
            error: {
              code: "PLAN_REQUIRED",
              message: "Call plan_edit directly before any editing tool. Do not wrap it in execute_action.",
            },
          };
          emit({ type: "tool_result", call, result: blocked });
          results.push({
            toolUseId: call.id,
            content: JSON.stringify(blocked),
            isError: true,
          });
          continue;
        }

        // One-shot: plan_edit may only be called once per turn. If the user
        // wants refinements they ask via chat and the AI edits the existing
        // timeline clips directly — it does NOT re-run plan_edit.
        if (call.name === "plan_edit" && planEditApplied) {
          const blocked = {
            ok: false as const,
            summary: "plan_edit already applied this turn",
            error: {
              code: "PLAN_EDIT_ALREADY_USED",
              message: "plan_edit was already applied this turn. To refine the edit, describe what you want changed and use clip/effect/text tools to modify the existing timeline — do not call plan_edit again.",
            },
          };
          emit({ type: "tool_result", call, result: blocked });
          results.push({
            toolUseId: call.id,
            content: JSON.stringify(blocked),
            isError: true,
          });
          continue;
        }

        const needsConfirm =
          !dryRun &&
          !approveAll &&
          (isDestructive(call.name) || isExpensive(call.name));
        if (needsConfirm && confirmGate) {
          emit({ type: "awaiting_confirmation", call });
          const decision = await confirmGate(call);
          if (decision === "approve_for_turn") approveAll = true;
          if (decision === "reject") {
            const rejected = {
              ok: false as const,
              summary: "Rejected by user",
              error: { code: "REJECTED", message: "User rejected this action" },
            };
            emit({ type: "tool_result", call, result: rejected });
            results.push({
              toolUseId: call.id,
              content: JSON.stringify(rejected),
              isError: true,
            });
            continue;
          }
        }

        let result;
        if (dryRun && !isReadOnly(call.name)) {
          result = {
            ok: true as const,
            summary: `[dry-run] would call ${call.name}`,
          };
        } else {
          result = await executeToolWithRetry(call.name, call.args, host);
        }

        // plan_edit materialization is best-effort inside the tool (teardown +
        // insert + effects + transitions + audio + text). If it throws partway
        // through, the timeline is left half-mutated. Roll back the entire turn
        // so the user never sees orphan clips stacked under a failed plan.
        if (
          call.name === "plan_edit" &&
          !result.ok &&
          result.error?.code === "EDIT_PLAN_APPLY_FAILED"
        ) {
          await host.rollbackTransaction(txn);
          // Resolve the tool card first: this branch returns without reaching
          // the emit below, which left the UI's "Running" chip hanging forever.
          emit({ type: "tool_result", call, result });
          emit({
            type: "error",
            error: {
              code: "PLAN_MATERIALIZE_FAILED",
              message: result.summary,
            },
          });
          return {
            text:
              `The edit plan could not be applied and the timeline has been reverted. ` +
              result.summary,
            messages,
            toolCalls,
            stoppedReason: "error",
            committed: false,
            usage,
          };
        }

        if (requiresDirectorPlan && call.name === "plan_edit" && result.ok) {
          directorPlanCompleted = true;
        }
        if (call.name === "plan_edit" && result.ok) {
          planEditApplied = true;
        }
        emit({ type: "tool_result", call, result });
        results.push({
          toolUseId: call.id,
          content: buildToolResultContent(result),
          isError: !result.ok,
        });
      }

      messages.push({ role: "tool", results });

      if (hitToolCallLimit) {
        host.commitTransaction(txn, turnLabel);
        return {
          text: lastText,
          messages,
          toolCalls,
          stoppedReason: "max_tool_calls",
          committed: true,
          usage,
        };
      }
    }

    host.commitTransaction(txn, turnLabel);
    return {
      text: lastText,
      messages,
      toolCalls,
      stoppedReason: "max_steps",
      committed: true,
      usage,
    };
  } catch (error) {
    await host.rollbackTransaction(txn);
    const message = error instanceof Error ? error.message : "Agent turn failed";
    emit({ type: "error", error: { code: "LOOP_ERROR", message } });
    return {
      text: lastText,
      messages,
      toolCalls,
      stoppedReason: "error",
      committed: false,
      usage,
    };
  }
}
