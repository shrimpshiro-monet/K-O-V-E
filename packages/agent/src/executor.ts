import type { EditingHost } from "./host";
import type { ToolResult } from "./types";
import { getTool } from "./registry";
import { resolveClipId } from "./serialize";
import { gateToolArgs } from "./schema-validate";
import { withWarnings } from "./multicam-units";
import { RUN_TOOL_NAME } from "./tools-discovery";

/**
 * Resolve agent-friendly clip references (clipIndex / atSec [+ trackIndex]) to a
 * canonical clipId so the model never has to juggle UUIDs. Leaves an explicit
 * clipId untouched.
 */
function resolveRefs(
  args: Record<string, unknown>,
  host: EditingHost,
): Record<string, unknown> {
  if (typeof args.clipId === "string") return args;
  const hasRef =
    typeof args.clipIndex === "number" || typeof args.atSec === "number";
  if (!hasRef) return args;
  try {
    const id = resolveClipId(host.getProject(), {
      index: args.clipIndex as number | undefined,
      atSec: args.atSec as number | undefined,
      trackIndex: args.trackIndex as number | undefined,
    });
    if (id) return { ...args, clipId: id };
  } catch {
    // no open project / resolution failed — let the tool report it
  }
  return args;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown> | undefined,
  host: EditingHost,
): Promise<ToolResult> {
  const tool = getTool(name);
  if (!tool) {
    return {
      ok: false,
      summary: `Unknown tool: ${name}`,
      error: { code: "UNKNOWN_TOOL", message: `No tool named '${name}'` },
    };
  }
  const resolved = resolveRefs(args ?? {}, host);
  // Schema gate: shadow (log only) for legacy tools, enforced for `strict` tools
  // and any tool opted in via the policy. Handlers still validate for themselves.
  const gate = gateToolArgs(tool, resolved);
  if (gate.rejection) return gate.rejection;
  try {
    const result = await tool.handler(gate.args, host);
    return gate.warnings.length > 0 ? withWarnings(result, [...(result.warnings ?? []), ...gate.warnings]) : result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool execution failed";
    return { ok: false, summary: message, error: { code: "TOOL_ERROR", message } };
  }
}

/**
 * The tool a call actually targets, unwrapping the discovery invoker.
 *
 * `run_tool` exists so the model can reach a tool that the per-turn router did
 * not send (see tools-discovery.ts). Everything that inspects a call — the
 * director-plan gate, the destructive/expensive confirmation gate — must judge
 * the *target*, not the wrapper, or a destructive tool would slip through
 * unconfirmed and a read-only one would be blocked as if it were an edit.
 */
export function resolveCallTarget(
  name: string,
  input: Record<string, unknown> | undefined,
): { readonly name: string; readonly args: Record<string, unknown> | undefined } {
  if (name !== RUN_TOOL_NAME) return { name, args: input };
  const target = input?.name;
  const args = input?.args;
  if (typeof target !== "string" || target === RUN_TOOL_NAME) return { name, args: input };
  return {
    name: target,
    args: typeof args === "object" && args !== null ? (args as Record<string, unknown>) : undefined,
  };
}

export function isDestructive(name: string): boolean {
  return getTool(name)?.destructive ?? false;
}

export function isExpensive(name: string): boolean {
  return getTool(name)?.expensive ?? false;
}
