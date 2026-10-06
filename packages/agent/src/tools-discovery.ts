import { executeTool } from "./executor";
import { getTool, listTools } from "./registry";
import type { EditingHost } from "./host";
import type { RegisteredTool } from "./registry";
import type { JSONSchema, ToolResult } from "./types";

/**
 * Discovery pair: find a tool, then call it.
 *
 * The per-turn router (tool-router.ts) deliberately sends only a relevant
 * subset of the registry, because 300+ function schemas would blow the
 * provider limit and the user's context. That is fine for common work, but it
 * meant a tool the router did not pick was simply unreachable — including a
 * tool added after the router was written.
 *
 * `search_tools` + `run_tool` close that hole: they are always sent (see
 * ALWAYS_AVAILABLE), so any registered tool can be discovered and invoked even
 * when its schema is not in the turn's tool list. `run_tool` executes through
 * the normal `executeTool` path, so schema gating, host capability checks,
 * ref resolution and error shaping all still apply — and the loop unwraps it
 * for the director-plan and confirmation gates (executor.resolveCallTarget).
 */

/** Name under which the invoker is registered; used by the loop + executor. */
export const RUN_TOOL_NAME = "run_tool";

const strictObject = (
  properties: Record<string, JSONSchema>,
  required: string[] = [],
): JSONSchema => ({ type: "object", properties, required, additionalProperties: false });

const fail = (code: string, message: string, suggestedFix: string): ToolResult => ({
  ok: false,
  summary: message,
  error: { code, message, suggestedFix },
});

const ok = (summary: string, data: unknown, warnings?: string[]): ToolResult => ({
  ok: true,
  summary,
  data,
  ...(warnings && warnings.length > 0 ? { warnings } : {}),
});

const SEARCH_LIMIT_DEFAULT = 12;
const SEARCH_LIMIT_MAX = 40;
const SUMMARY_LENGTH = 220;

/** Tools the model must never see or call directly. */
const isHidden = (tool: RegisteredTool): boolean => tool.internal === true;

/**
 * Rank a tool against a query: name hits beat title hits, which beat
 * description hits. An empty query lists the most common entry points.
 */
function scoreTool(tool: RegisteredTool, tokens: readonly string[]): number {
  if (tokens.length === 0) return tool.readOnly ? 2 : 1;
  const name = tool.name.toLowerCase();
  const title = tool.title.toLowerCase();
  const description = tool.description.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (name === token) score += 100;
    else if (name.includes(token)) score += 40;
    if (title.includes(token)) score += 15;
    if (description.includes(token)) score += 4;
  }
  return score;
}

const tokenize = (query: string): string[] =>
  query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2);

export const DISCOVERY_TOOLS: RegisteredTool[] = [
  {
    name: "search_tools",
    domain: "read",
    title: "Search the tool registry",
    description:
      "Find tools by keyword. The per-turn tool list only carries a relevant subset of the registry, so use this when nothing you were given matches what the user asked for — a niche tool, a newly added one, or one you know exists but cannot see ('face', 'mask', 'keyframe', 'shader', 'marker', 'caption'…). Returns matching tool names with their flags, one-line purpose and required arguments; call the match with run_tool. Search does not consume the tool budget and never edits anything.",
    inputSchema: strictObject({
      query: {
        type: "string",
        description: "Keywords, e.g. 'reframe', 'caption', '3d material'. Omit to list common entry points.",
      },
      domain: {
        type: "string",
        description: "Restrict to one domain, e.g. 'ai', 'text', 'motion', 'effect', 'keyframe'.",
      },
      readOnly: { type: "boolean", description: "Only read-only (analysis) tools when true." },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: SEARCH_LIMIT_MAX,
        description: `Max results. Default ${SEARCH_LIMIT_DEFAULT}.`,
      },
    }),
    readOnly: true,
    destructive: false,
    expensive: false,
    strict: true,
    handler: async (args): Promise<ToolResult> => {
      const query = typeof args.query === "string" ? args.query : "";
      const domain = typeof args.domain === "string" ? args.domain.toLowerCase() : undefined;
      const readOnlyOnly = args.readOnly === true;
      const limit = Math.min(
        SEARCH_LIMIT_MAX,
        Math.max(1, typeof args.limit === "number" ? args.limit : SEARCH_LIMIT_DEFAULT),
      );
      const tokens = tokenize(query);

      const matches = listTools()
        .filter((tool) => !isHidden(tool))
        .filter((tool) => (domain ? tool.domain.toLowerCase() === domain : true))
        .filter((tool) => (readOnlyOnly ? tool.readOnly : true))
        .map((tool) => ({ tool, score: scoreTool(tool, tokens) }))
        .filter((entry) => tokens.length === 0 || entry.score > 0)
        .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
        .slice(0, limit);

      if (matches.length === 0) {
        return ok(
          `No tool matches "${query}"${domain ? ` in domain ${domain}` : ""}.`,
          { matches: [], hint: "Try a shorter keyword, or drop the domain filter." },
        );
      }

      return ok(
        `${matches.length} tool(s) match "${query || "*"}"${domain ? ` in domain ${domain}` : ""}.`,
        {
          matches: matches.map(({ tool }) => ({
            name: tool.name,
            title: tool.title,
            domain: tool.domain,
            readOnly: tool.readOnly,
            destructive: tool.destructive,
            expensive: tool.expensive,
            required: (tool.inputSchema.required as string[] | undefined) ?? [],
            purpose: tool.description.slice(0, SUMMARY_LENGTH),
          })),
          hint: `Call one with run_tool: { name, args }.`,
        },
      );
    },
  },
  {
    name: RUN_TOOL_NAME,
    domain: "raw",
    title: "Run any registered tool by name",
    description:
      "Call a tool that is not in this turn's tool list — look it up with search_tools first. Args are validated against that tool's schema, host capability checks still apply, and a destructive or expensive target still asks for confirmation. Use this instead of reporting that a capability is unavailable: if the registry has the tool, this can call it. Do not wrap tools that are already available; call them directly.",
    inputSchema: strictObject(
      {
        name: { type: "string", description: "Exact tool name, e.g. 'auto_reframe_clip'." },
        args: { type: "object", description: "Arguments for that tool, same shape as calling it directly." },
      },
      ["name"],
    ),
    readOnly: false,
    destructive: false,
    expensive: false,
    strict: true,
    handler: async (args, host): Promise<ToolResult> => {
      const targetName = args.name;
      if (typeof targetName !== "string" || targetName.length === 0) {
        return fail("INVALID_PARAMS", "name is required.", "Pass the exact tool name from search_tools.");
      }
      if (targetName === RUN_TOOL_NAME) {
        return fail("INVALID_PARAMS", "run_tool cannot call itself.", "Name the tool you want directly.");
      }
      const target = getTool(targetName);
      if (!target) {
        return fail(
          "UNKNOWN_TOOL",
          `No tool named "${targetName}".`,
          "Use search_tools to find the right name; do not invent one.",
        );
      }
      if (isHidden(target)) {
        return fail(
          "TOOL_NOT_AVAILABLE",
          `"${targetName}" is internal to the director pipeline and cannot be called directly.`,
          "Use the public tool that wraps it.",
        );
      }
      const targetArgs =
        typeof args.args === "object" && args.args !== null
          ? (args.args as Record<string, unknown>)
          : undefined;

      const result = await executeTool(targetName, targetArgs, host as EditingHost);
      const warnings = [...(result.warnings ?? [])];
      return {
        ...result,
        summary: `${targetName}: ${result.summary}`,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    },
  },
];
