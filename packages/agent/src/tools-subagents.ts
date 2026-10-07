/**
 * The `delegate_tasks` tool — the director's fan-out.
 *
 * A subagent here is a real `runTurn` with its own system prompt, tool
 * allowlist, message list and budget. Two properties make it worth the
 * indirection:
 *
 * - **It cannot see the parent's history**, and the parent only sees the
 *   digest. Surveying a timeline costs the director a paragraph instead of
 *   every tool result that survey produced.
 * - **Independent scouts run at the same time.** Read-only subagents are
 *   parallelized automatically; anything that can write is serialized, because
 *   two agents holding transactions on one timeline is how edits get torn.
 *
 * These specs are the built-in roster. They are deliberately plain data so a
 * deployment (or a user's own skill file) can add roles the same way — that is
 * the same mechanism the user-facing skills feature will use.
 */

import type { EditingHost } from "./host";
import type { JSONSchema, ToolResult } from "./types";
import type { RegisteredTool } from "./registry";
// Runtime import: registry imports this file, so these are only touched inside
// the handler (function declarations are hoisted, so the cycle resolves).
import { toAnthropicTools, toOpenAITools } from "./registry";
import {
  describeSubagents,
  formatSubagentDigest,
  runSubagents,
  type SubagentSpec,
} from "./subagents";

const strictObject = (
  properties: Record<string, JSONSchema>,
  required: string[] = [],
): JSONSchema => ({ type: "object", properties, required, additionalProperties: false });

const fail = (code: string, message: string, suggestedFix: string): ToolResult => ({
  ok: false,
  summary: message,
  error: { code, message, suggestedFix },
});

const ok = (summary: string, data?: Record<string, unknown>): ToolResult => ({
  ok: true,
  summary,
  ...(data ? { data } : {}),
});

/** Ceiling on one fan-out, so a bad decomposition cannot spawn a stampede. */
const MAX_TASKS = 8;

export const SUBAGENT_SPECS: readonly SubagentSpec[] = [
  {
    name: "scout",
    title: "Inventory scout",
    description:
      "Maps the project: canvas, tracks, clips, media and what has been edited so far. Read-only.",
    system: [
      "You are the inventory scout for a video editor. You never edit anything.",
      "Answer exactly what was asked about the project's structure: canvas size and frame rate, tracks, clips with their timing and source, what is on the media shelf, and what the edit history says has changed.",
      "Be concrete and terse. Quote ids and timings rather than describing them. If the project is empty, say so plainly instead of inventing contents.",
      "Finish with a short plain-language summary a director could act on without re-reading your tool output.",
    ].join("\n"),
    tools: [
      "get_capabilities",
      "get_editor_state",
      "list_media",
      "list_clips",
      "get_project_manifest",
      "get_edit_summary",
    ],
    readOnly: true,
  },
  {
    name: "footage",
    title: "Footage analyst",
    description:
      "What is actually in the picture and the audio: segments, transcript, structure. Read-only.",
    system: [
      "You are the footage analyst for a video editor. You never edit anything.",
      "Report what the material contains: scene segments and their content, spoken words if a transcript exists, and which clips carry which material.",
      "Ground every claim in a tool result. If you could not analyze something, say 'not analyzed' rather than guessing — a director acting on invented content is worse than a director told nothing.",
      "Finish with the handful of facts that would change how someone edits this, and the moment (timestamp) each one happens at.",
    ].join("\n"),
    tools: [
      "get_capabilities",
      "list_clips",
      "list_media",
      "extract_segments",
      "get_transcript",
    ],
    readOnly: true,
  },
  {
    name: "cutter",
    title: "Cutter",
    description: "Timing work: trims, splits, clip speed, transitions. Edits the timeline.",
    system: [
      "You are the cutter. You own pacing and timing: trims, speed, and the transitions between shots.",
      "Touch only what the task asks for. Do not restructure the timeline, do not add color or text — other agents own those, and overlapping edits are hard to undo cleanly.",
      "Prefer one batch of edits over many single ones so the whole change is a single undo step.",
      "Finish with exactly what you changed, by clip and time, and anything you deliberately left alone.",
    ].join("\n"),
    tools: [
      "get_capabilities",
      "get_editor_state",
      "list_clips",
      "trim_clip",
      "set_clip_speed",
      "add_transition",
      "execute_action",
      "batch_actions",
    ],
  },
  {
    name: "stylist",
    title: "Stylist",
    description: "Look work: color grading and video effects. Edits the timeline.",
    system: [
      "You are the stylist. You own how the picture looks: color grading and video effects.",
      "Touch only what the task asks for. Do not cut clips or add text — other agents own those.",
      "Check the clip's existing effect stack before adding, and put new effects in a deliberate order rather than wherever they land.",
      "Finish with exactly what you changed, per clip, and the grade or effect values you used.",
    ].join("\n"),
    tools: [
      "get_capabilities",
      "get_editor_state",
      "list_clips",
      "set_color_grading",
      "add_video_effect",
      "set_effect_order",
      "execute_action",
      "batch_actions",
    ],
  },
  {
    name: "words",
    title: "Words",
    description: "Titles, text clips and subtitles. Edits the timeline.",
    system: [
      "You are the words agent. You own anything readable on screen: titles, lower thirds and subtitles.",
      "Touch only what the task asks for. Do not cut clips or grade them.",
      "Match the wording the task asked for exactly — copy is not something to improve on your own initiative.",
      "Finish with the text you added, on which clip, and over what time range.",
    ].join("\n"),
    tools: [
      "get_capabilities",
      "list_clips",
      "create_text_clip",
      "add_subtitle",
      "set_subtitle_style",
      "update_subtitle",
      "execute_action",
    ],
  },
  {
    name: "reviewer",
    title: "Reviewer",
    description:
      "Checks the timeline against a brief and reports what does not match. Read-only.",
    system: [
      "You are the reviewer. You never edit anything.",
      "You are given a brief and you check the timeline against it, point by point. Report what satisfies the brief, what does not, and what is outright broken (gaps, clips that will not play, effects on the wrong clip).",
      "Quote ids and timings for every problem so someone can jump straight to it.",
      "Be blunt. A review that finds nothing because it did not look is worse than no review. If everything checks out, say so and list what you verified.",
    ].join("\n"),
    tools: [
      "get_capabilities",
      "get_editor_state",
      "list_clips",
      "get_edit_summary",
      "get_project_manifest",
    ],
    readOnly: true,
  },
];

export const SUBAGENT_TOOLS: RegisteredTool[] = [
  {
    name: "delegate_tasks",
    domain: "ai",
    title: "Delegate work to subagents",
    description: [
      "Fan work out to specialist subagents instead of doing it all in your own context.",
      "Each subagent runs in its own conversation with its own tool allowlist: it cannot see this conversation, and you only get back a compact digest — not every tool result it produced. Use this when a task needs several kinds of investigation at once, or when reading everything yourself would bury the request.",
      "Read-only subagents run in parallel. Subagents that can edit are run one at a time, because two writers on one timeline is how edits get torn. Pass mode: \"serial\" to force sequential, or \"parallel\" to force concurrency (only safe when the tasks cannot touch the same clips).",
      "Write each goal as if the subagent knows nothing else: name the clips or ids it should look at and say what form you want the answer in. A vague goal buys you a vague answer.",
      "",
      "Available subagents:",
      describeSubagents(SUBAGENT_SPECS),
    ].join("\n"),
    inputSchema: strictObject(
      {
        tasks: {
          type: "array",
          description: `One entry per subagent to run (1-${MAX_TASKS}).`,
          items: {
            type: "object",
            properties: {
              agent: { type: "string", description: "Subagent name, e.g. \"scout\"." },
              goal: {
                type: "string",
                description: "Self-contained instruction. Name the clips/ids to work on.",
              },
            },
            required: ["agent", "goal"],
            additionalProperties: false,
          },
        },
        mode: {
          type: "string",
          enum: ["auto", "parallel", "serial"],
          description:
            "auto (default): parallel when every task is read-only, otherwise serial. parallel: force concurrency. serial: force one at a time.",
        },
        maxTokens: {
          type: "integer",
          minimum: 1,
          description: "Token ceiling shared across every subagent in this fan-out.",
        },
      },
      ["tasks"],
    ),
    readOnly: false,
    destructive: true,
    expensive: true,
    strict: true,
    handler: async (args, host: EditingHost): Promise<ToolResult> => {
      const raw = args.tasks;
      if (!Array.isArray(raw) || raw.length === 0) {
        return fail(
          "INVALID_PARAMS",
          "tasks is required and must not be empty.",
          "Pass tasks: [{ agent: \"scout\", goal: \"...\" }].",
        );
      }
      if (raw.length > MAX_TASKS) {
        return fail(
          "INVALID_PARAMS",
          `At most ${MAX_TASKS} tasks per call (got ${raw.length}).`,
          "Split the work across two delegate_tasks calls.",
        );
      }

      const tasks = raw.map((entry) => {
        const record = (entry ?? {}) as Record<string, unknown>;
        return {
          agent: String(record.agent ?? ""),
          goal: String(record.goal ?? ""),
        };
      });

      const blank = tasks.find((task) => !task.agent || !task.goal.trim());
      if (blank) {
        return fail(
          "INVALID_PARAMS",
          "Every task needs an agent and a non-empty goal.",
          `Fix the task for agent "${blank.agent || "(missing)"}".`,
        );
      }

      const llm = host.llm;
      if (!llm) {
        return fail(
          "NO_MODEL",
          "No model is configured, so subagents cannot run.",
          "Configure a model in AI settings, or do the work with your own tools instead.",
        );
      }

      const mode = args.mode as "auto" | "parallel" | "serial" | undefined;
      const maxTokens = typeof args.maxTokens === "number" ? args.maxTokens : undefined;

      const outcomes = await runSubagents({
        host,
        llm: llm.client,
        formatTools: (names) =>
          llm.provider === "anthropic" ? toAnthropicTools(names) : toOpenAITools(names),
        specs: SUBAGENT_SPECS,
        tasks,
        ...(mode ? { mode } : {}),
        ...(maxTokens !== undefined ? { budget: { maxTokens } } : {}),
      });

      const digest = formatSubagentDigest(outcomes);
      const failed = outcomes.filter((outcome) => !outcome.ok);

      return ok(
        failed.length === 0
          ? `${outcomes.length} subagent task(s) finished.`
          : `${failed.length} of ${outcomes.length} subagent task(s) failed.`,
        {
          digest,
          outcomes: outcomes.map((outcome) => ({
            agent: outcome.agent,
            ok: outcome.ok,
            toolCalls: outcome.toolCalls,
            stoppedReason: outcome.stoppedReason,
            tokens: outcome.usage.inputTokens + outcome.usage.outputTokens,
            ...(outcome.error ? { error: outcome.error } : {}),
          })),
        },
      );
    },
  },
];
