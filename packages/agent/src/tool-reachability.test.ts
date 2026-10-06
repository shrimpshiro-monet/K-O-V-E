import { afterEach, describe, expect, it } from "vitest";
import { executeTool, resolveCallTarget } from "./executor";
import { HeadlessHost } from "./headless-host";
import { listTools, registerTool, unregisterTool } from "./registry";
import { makeProjectWithClip } from "./test-fixtures";
import { ALWAYS_AVAILABLE, selectToolsForPrompt } from "./tool-router";
import { RUN_TOOL_NAME } from "./tools-discovery";
import type { RegisteredTool } from "./registry";

/**
 * "Can the director select any tool?" — the router sends a per-turn subset, so
 * the honest answer has to be: every registered tool is reachable, either
 * because it is routed in, or because the discovery pair (search_tools +
 * run_tool) is always present. These tests are the proof, and they fail if a
 * future tool is added somewhere that cannot be reached.
 */

/** Prompts covering the router's branches (default, motion, creation, director). */
const REPRESENTATIVE_PROMPTS = [
  "hey, what is on my timeline?",
  "make me a montage of this footage with music",
  "animate this card with a kinetic title",
  "build a 3d product scene with a character",
  "reframe this clip for tiktok",
  "add captions and clean up the audio",
  "measure the loudness of the export",
];

const host = () => new HeadlessHost(makeProjectWithClip());

describe("every tool is reachable by the model", () => {
  it("keeps the discovery pair and the safety net in every routed subset", () => {
    for (const prompt of REPRESENTATIVE_PROMPTS) {
      const selected = selectToolsForPrompt(prompt);
      expect(selected, `prompt: ${prompt}`).toContain("search_tools");
      expect(selected, `prompt: ${prompt}`).toContain(RUN_TOOL_NAME);
      expect(selected, `prompt: ${prompt}`).toContain("list_action_types");
      expect(selected, `prompt: ${prompt}`).toContain("execute_action");
    }
  });

  it("keeps the whole safety net even under the smallest provider cap", () => {
    // A cap smaller than the always-available set used to truncate it, stranding
    // undo/checkpoints/discovery on smaller providers.
    const selected = selectToolsForPrompt("make me a montage of this footage", { maxTools: 25 });
    for (const name of ALWAYS_AVAILABLE) {
      expect(selected, `always-available tool ${name} was dropped by the cap`).toContain(name);
    }
    // The cap still governs how many *optional* tools ride along.
    expect(selected.length).toBeLessThanOrEqual(Math.max(25, ALWAYS_AVAILABLE.size));
  });

  it("can find and call every public tool through discovery alone", async () => {
    const publicTools = listTools().filter((tool) => tool.internal !== true);
    const unreachable: string[] = [];

    for (const tool of publicTools) {
      // 1. Searchable by its own name — the model can always look it up.
      const found = await executeTool("search_tools", { query: tool.name, limit: 40 }, host());
      const matches = (found.data as { matches?: { name: string }[] } | undefined)?.matches ?? [];
      if (!matches.some((match) => match.name === tool.name)) {
        unreachable.push(`${tool.name}: not returned by search_tools`);
        continue;
      }

      // 2. Callable through the invoker: the call resolves to the tool itself
      //    (never executed here — most need a prepared project — but the
      //    routing, the gate and the confirmation all see the real target).
      const target = resolveCallTarget(RUN_TOOL_NAME, { name: tool.name, args: {} });
      if (target.name !== tool.name) unreachable.push(`${tool.name}: run_tool did not resolve it`);
    }

    expect(unreachable).toEqual([]);
    // Sanity: this is a real registry, not an empty list.
    expect(publicTools.length).toBeGreaterThan(300);
  });

  it("never leaks internal tools through search or the invoker", async () => {
    const internal = listTools().filter((tool) => tool.internal === true);
    expect(internal.length).toBeGreaterThan(0);

    for (const tool of internal) {
      const found = await executeTool("search_tools", { query: tool.name, limit: 40 }, host());
      const matches = (found.data as { matches?: { name: string }[] } | undefined)?.matches ?? [];
      expect(matches.some((match) => match.name === tool.name)).toBe(false);

      const called = await executeTool(RUN_TOOL_NAME, { name: tool.name }, host());
      expect(called.ok).toBe(false);
      expect(called.error?.code).toBe("TOOL_NOT_AVAILABLE");
    }
  });

  it("rejects unknown names and self-recursion with a usable fix", async () => {
    const unknown = await executeTool(RUN_TOOL_NAME, { name: "make_me_a_coffee" }, host());
    expect(unknown.ok).toBe(false);
    expect(unknown.error?.code).toBe("UNKNOWN_TOOL");
    expect(unknown.error?.suggestedFix).toContain("search_tools");

    const recursive = await executeTool(RUN_TOOL_NAME, { name: RUN_TOOL_NAME }, host());
    expect(recursive.ok).toBe(false);
    expect(recursive.error?.code).toBe("INVALID_PARAMS");
  });

  it("validates args against the target tool's schema", async () => {
    // auto_reframe_clip requires clipId and forbids unknown keys.
    const missing = await executeTool(RUN_TOOL_NAME, { name: "auto_reframe_clip", args: {} }, host());
    expect(missing.ok).toBe(false);

    const bogus = await executeTool(
      RUN_TOOL_NAME,
      { name: "auto_reframe_clip", args: { clipId: "c1", notARealOption: true } },
      host(),
    );
    expect(bogus.ok).toBe(false);
  });
});

describe("newly added tools are reachable without an allowlist", () => {
  const added: string[] = [];

  const registerSynthetic = (tool: RegisteredTool): void => {
    registerTool(tool);
    added.push(tool.name);
  };

  afterEach(() => {
    for (const name of added.splice(0)) unregisterTool(name);
  });

  it("routes a brand new tool when the prompt matches it", () => {
    registerSynthetic({
      name: "polish_the_gizmo",
      domain: "read",
      title: "Polish the gizmo",
      description: "Polishes the gizmo.",
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      readOnly: true,
      destructive: false,
      expensive: false,
      strict: true,
      handler: async () => ({ ok: true, summary: "gizmo polished" }),
    });

    // The router reads the live registry, so a tool added after the router was
    // written is selected for a matching prompt with no code change.
    const selected = selectToolsForPrompt("please polish the gizmo for me");
    expect(selected).toContain("polish_the_gizmo");
  });

  it("finds and calls a brand new tool through discovery even when unrouted", async () => {
    registerSynthetic({
      name: "inspect_widget_health",
      domain: "ai",
      title: "Inspect widget health",
      description: "Reports widget health as a percentage.",
      inputSchema: {
        type: "object",
        properties: { widgetId: { type: "string" } },
        required: ["widgetId"],
        additionalProperties: false,
      },
      readOnly: true,
      destructive: false,
      expensive: false,
      strict: true,
      handler: async (args) => ({ ok: true, summary: `widget ${String(args.widgetId)} is healthy` }),
    });

    // A motion-only prompt restricts the candidate set to motion tools, so a
    // widget-health tool (domain: ai) is genuinely not routed in...
    const selected = selectToolsForPrompt("animate this kinetic title card");
    expect(selected).not.toContain("inspect_widget_health");

    // ...but discovery finds it and calls it anyway.
    const found = await executeTool("search_tools", { query: "widget health" }, host());
    const matches = (found.data as { matches?: { name: string }[] } | undefined)?.matches ?? [];
    expect(matches.map((match) => match.name)).toContain("inspect_widget_health");

    const called = await executeTool(
      RUN_TOOL_NAME,
      { name: "inspect_widget_health", args: { widgetId: "w-7" } },
      host(),
    );
    expect(called.ok).toBe(true);
    expect(called.summary).toContain("widget w-7 is healthy");
  });
});

describe("gate + confirmation see the real target", () => {
  it("unwraps run_tool for the destructive/plan checks", () => {
    expect(resolveCallTarget("run_tool", { name: "apply_subject_matte", args: { clipId: "c1" } })).toEqual({
      name: "apply_subject_matte",
      args: { clipId: "c1" },
    });
    // Direct calls pass through untouched, and a malformed wrapper is left for
    // the invoker's own validation to reject.
    expect(resolveCallTarget("detect_faces", { mediaId: "m1" })).toEqual({
      name: "detect_faces",
      args: { mediaId: "m1" },
    });
    expect(resolveCallTarget("run_tool", { args: {} }).name).toBe("run_tool");
    expect(resolveCallTarget("run_tool", { name: "run_tool" }).name).toBe("run_tool");
  });

  it("marks the tools that must always be present", () => {
    // A regression here silently strands capabilities, so pin the intent.
    expect(ALWAYS_AVAILABLE.has("search_tools")).toBe(true);
    expect(ALWAYS_AVAILABLE.has(RUN_TOOL_NAME)).toBe(true);
    expect(ALWAYS_AVAILABLE.has("list_action_types")).toBe(true);
    expect(ALWAYS_AVAILABLE.has("execute_action")).toBe(true);
  });
});
