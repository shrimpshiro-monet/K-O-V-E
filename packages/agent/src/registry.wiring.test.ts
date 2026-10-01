import { describe, expect, it } from "vitest";
import { getTool, listTools, toAnthropicTools, toMcpTools, toOpenAITools } from "./registry";
import { executeTool } from "./executor";
import { HeadlessHost } from "./headless-host";
import { makeProjectWithClip } from "./test-fixtures";
import type { Project } from "@kove-advanced/core/types/project";

/**
 * The registry is the only thing standing between an LLM and the editor. Two
 * failure modes matter more than any other:
 *
 *   1. A tool that is advertised but cannot run (bad schema, missing handler).
 *   2. A tool whose `actionType` no longer matches a branch in the action
 *      executor — the call would report success and change nothing.
 *
 * Both are silent in production and only visible here, so this file tests the
 * wiring rather than the behaviour: it walks every registered tool and proves
 * the registry, the executor and the provider projections agree.
 */

const DOMAINS = [
  "read",
  "clip",
  "track",
  "effect",
  "color",
  "audio",
  "subtitle",
  "raw",
  "transition",
  "keyframe",
  "marker",
  "text",
  "graphics",
  "speed",
  "transform",
  "media",
  "project",
  "export",
  "multicam",
  "ai",
  "motion",
] as const;

function hostWithProject(): HeadlessHost {
  return new HeadlessHost(makeProjectWithClip() as unknown as Project);
}

describe("registry wiring", () => {
  it("advertises a large, unique, well-formed tool surface", () => {
    const tools = listTools();
    expect(tools.length).toBeGreaterThanOrEqual(250);

    const names = tools.map((tool) => tool.name);
    expect(new Set(names).size, "duplicate tool names").toBe(names.length);

    for (const tool of tools) {
      expect(tool.name, `bad name: ${tool.name}`).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.title.length, tool.name).toBeGreaterThan(0);
      expect(tool.description.length, tool.name).toBeGreaterThan(10);
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(typeof tool.handler, tool.name).toBe("function");
      expect(typeof tool.readOnly, tool.name).toBe("boolean");
      expect(typeof tool.destructive, tool.name).toBe("boolean");
      expect(typeof tool.expensive, tool.name).toBe("boolean");
      // A read tool must never be flagged destructive.
      if (tool.domain === "read") {
        expect(tool.readOnly, tool.name).toBe(true);
        expect(tool.destructive, tool.name).toBe(false);
      }
    }
  });

  it("covers every editing domain", () => {
    const domains = new Set(listTools().map((tool) => tool.domain));
    for (const domain of DOMAINS) {
      expect(domains.has(domain as never), `missing domain: ${domain}`).toBe(true);
    }
  });

  it("projects every public tool into all three provider formats", () => {
    const base = listTools()
      .filter((tool) => !tool.internal)
      .map((tool) => tool.name)
      .sort();
    expect(toAnthropicTools().map((tool) => tool.name).sort()).toEqual(base);
    expect(toOpenAITools().map((tool) => tool.function.name).sort()).toEqual(base);
    expect(toMcpTools().map((tool) => tool.name).sort()).toEqual(base);
  });

  /**
   * The load-bearing test: every action-backed tool must reach a real branch in
   * ActionExecutor. We call each one with empty args against a throwaway host —
   * validation failures are expected and fine, but "Unknown … action type" means
   * the registry is pointing at a branch that no longer exists.
   */
  it("points every action-backed tool at a live executor branch", async () => {
    const actionTools = listTools().filter(
      (tool) => (tool as { actionType?: string }).actionType !== undefined,
    );
    expect(actionTools.length).toBeGreaterThan(50);

    const orphaned: Array<{ tool: string; actionType: string; message: string }> = [];
    for (const tool of actionTools) {
      const actionType = (tool as { actionType?: string }).actionType!;
      const result = await executeTool(tool.name, {}, hostWithProject());
      const message = result.error?.message ?? "";
      if (/^Unknown .* action type:/.test(message) || /^Unknown action type:/.test(message)) {
        orphaned.push({ tool: tool.name, actionType, message });
      }
    }

    expect(
      orphaned,
      `tools wired to a dead actionType:\n${orphaned
        .map((entry) => `  ${entry.tool} → ${entry.actionType} (${entry.message})`)
        .join("\n")}`,
    ).toEqual([]);
  });

  it("refuses an action type that does not exist instead of faking success", async () => {
    const host = hostWithProject();
    const before = JSON.stringify(host.getProject());

    const typo = await executeTool("execute_action", { type: "clip/addd", params: {} }, host);
    expect(typo.ok).toBe(false);
    expect(typo.error?.message).toContain("Unknown clip action type");

    const nonsense = await executeTool("execute_action", { type: "bogus/thing", params: {} }, host);
    expect(nonsense.ok).toBe(false);
    expect(nonsense.error?.message).toContain("Unknown action type");

    // A refused action must leave the project byte-identical.
    expect(JSON.stringify(host.getProject())).toBe(before);
  });

  it("keeps every read tool callable against a real project", async () => {
    const readTools = listTools().filter((tool) => tool.domain === "read");
    for (const tool of readTools) {
      const result = await executeTool(tool.name, {}, hostWithProject());
      // Some reads need ids and will refuse; what must never happen is a throw
      // or an unknown-tool/unknown-action error.
      expect(result.error?.code, tool.name).not.toBe("UNKNOWN_TOOL");
      expect(result.summary, tool.name).not.toContain("Tool execution failed");
    }
  });

  it("exposes the escape hatches the agent loop depends on", () => {
    for (const name of [
      "execute_action",
      "batch_actions",
      "get_capabilities",
      "get_editor_state",
      "plan_edit",
      "extract_segments",
      "submit_edit_plan",
    ]) {
      expect(getTool(name), `missing ${name}`).toBeTruthy();
    }
  });
});
