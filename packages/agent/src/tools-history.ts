import type { EditingHost, HistoryOpResult } from "./host";
import type { RegisteredTool } from "./registry";
import type { JSONSchema, ToolResult } from "./types";

/**
 * Checkpoint / undo / redo tools (domain "history").
 *
 * New-tool conventions (see docs/AGENT-TOOL-AUDIT.md): strict schemas
 * (additionalProperties:false, nothing untyped), errors carry
 * {code, message, suggestedFix}. The tools intentionally do NOT expose
 * `force`: the agent can never override the "user edited since" guard — only
 * trusted callers of HistoryControl (e.g. the UI) can.
 */

const strictObject = (
  properties: Record<string, JSONSchema>,
  required: string[] = [],
): JSONSchema => ({ type: "object", properties, required, additionalProperties: false });

/** Reject unknown keys and wrong types before touching the host. */
function checkArgs(
  args: Record<string, unknown>,
  spec: Record<string, "string">,
  required: readonly string[],
): ToolResult | null {
  for (const key of Object.keys(args)) {
    if (!(key in spec)) {
      return invalid(
        `Unknown parameter '${key}'.`,
        `Remove '${key}'. Allowed parameters: ${Object.keys(spec).join(", ") || "(none)"}.`,
      );
    }
  }
  for (const [key, type] of Object.entries(spec)) {
    const v = args[key];
    if (v === undefined) {
      if (required.includes(key)) {
        return invalid(`Missing required parameter '${key}'.`, `Pass ${key} as a ${type}.`);
      }
      continue;
    }
    if (typeof v !== type) {
      return invalid(`Parameter '${key}' must be a ${type}.`, `Pass ${key} as a ${type}, not ${typeof v}.`);
    }
  }
  return null;
}

function invalid(message: string, suggestedFix: string): ToolResult {
  return {
    ok: false,
    summary: message,
    error: { code: "INVALID_PARAMS", message, suggestedFix },
  };
}

function fromHistory(result: HistoryOpResult): ToolResult {
  if (result.ok) {
    return { ok: true, summary: result.message, data: result };
  }
  return {
    ok: false,
    summary: result.message,
    error: {
      code: result.code ?? "ERROR",
      message: result.message,
      ...(result.suggestedFix ? { suggestedFix: result.suggestedFix } : {}),
    },
    data: result,
  };
}

const tool = (
  def: Omit<RegisteredTool, "domain" | "destructive" | "expensive">,
): RegisteredTool => ({ ...def, domain: "history", destructive: false, expensive: false });

export const HISTORY_TOOLS: RegisteredTool[] = [
  tool({
    name: "create_checkpoint",
    title: "Create checkpoint",
    description:
      "Mark the current project state so you can return to it with restore_checkpoint. Cheap (stores no copy of the project). Create one before any risky or multi-step change, then verify the result and restore if it is worse. Returns {checkpoint:{id,label,createdAt,revision,undoDepth}}.",
    inputSchema: strictObject({
      label: { type: "string", description: "Short human-readable name, e.g. 'before tightening cuts'." },
    }),
    readOnly: false,
    handler: (args: Record<string, unknown>, host: EditingHost) => {
      host.requireOpenProject();
      const bad = checkArgs(args, { label: "string" }, []);
      if (bad) return bad;
      const checkpoint = host.historyControl.createCheckpoint(args.label as string | undefined);
      return {
        ok: true,
        summary: `Created checkpoint '${checkpoint.label}' (${checkpoint.id}).`,
        data: { checkpoint },
      };
    },
  }),
  tool({
    name: "list_checkpoints",
    title: "List checkpoints",
    description:
      "List checkpoints that can still be restored (oldest first). Checkpoints whose history was undone past or cleared are omitted.",
    inputSchema: strictObject({}),
    readOnly: true,
    handler: (args: Record<string, unknown>, host: EditingHost) => {
      host.requireOpenProject();
      const bad = checkArgs(args, {}, []);
      if (bad) return bad;
      const checkpoints = host.historyControl.listCheckpoints();
      return {
        ok: true,
        summary: `${checkpoints.length} restorable checkpoint(s).`,
        data: { checkpoints },
      };
    },
  }),
  tool({
    name: "restore_checkpoint",
    title: "Restore checkpoint",
    description:
      "Revert the project to a checkpoint created earlier with create_checkpoint, undoing everything done after it. Refuses (HUMAN_EDITS_PRESENT) if the user edited the project after the checkpoint — never work around that; tell the user. data.verified=false means the restored state did not exactly match the checkpoint (see data.warnings); re-inspect before continuing. Undone work can be re-applied with redo until a new edit is made.",
    inputSchema: strictObject(
      { checkpointId: { type: "string", description: "Id returned by create_checkpoint / list_checkpoints." } },
      ["checkpointId"],
    ),
    readOnly: false,
    handler: async (args: Record<string, unknown>, host: EditingHost) => {
      host.requireOpenProject();
      const bad = checkArgs(args, { checkpointId: "string" }, ["checkpointId"]);
      if (bad) return bad;
      return fromHistory(await host.historyControl.restoreCheckpoint(args.checkpointId as string));
    },
  }),
  tool({
    name: "undo",
    title: "Undo agent step",
    description:
      "Undo your own most recent step. Only reverts changes made by the agent in this session; refuses (HUMAN_EDITS_PRESENT) rather than undo something the user did. Use restore_checkpoint to roll back several steps at once.",
    inputSchema: strictObject({}),
    readOnly: false,
    handler: async (args: Record<string, unknown>, host: EditingHost) => {
      host.requireOpenProject();
      const bad = checkArgs(args, {}, []);
      if (bad) return bad;
      return fromHistory(await host.historyControl.undo());
    },
  }),
  tool({
    name: "redo",
    title: "Redo agent step",
    description:
      "Re-apply the step you most recently undid (with undo or restore_checkpoint). Unavailable after any new edit, or when the redo stack holds steps you did not undo yourself.",
    inputSchema: strictObject({}),
    readOnly: false,
    handler: async (args: Record<string, unknown>, host: EditingHost) => {
      host.requireOpenProject();
      const bad = checkArgs(args, {}, []);
      if (bad) return bad;
      return fromHistory(await host.historyControl.redo());
    },
  }),
];
