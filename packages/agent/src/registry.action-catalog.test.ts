import { describe, expect, it } from "vitest";
import { executeTool } from "./executor";
import { HeadlessHost } from "./headless-host";
import { makeProjectWithClip } from "./test-fixtures";
import { getTool } from "./registry";
import { listRegisteredActionTypes } from "@kove-advanced/core/actions/registry";

/**
 * The director's escape hatch (`execute_action`) is only usable if the model can
 * find out which action types exist. This pins the catalog that makes that
 * possible, so a property without a dedicated tool stays reachable.
 */
describe("list_action_types", () => {
  it("is a read-only tool with no arguments", () => {
    const tool = getTool("list_action_types")!;
    expect(tool.readOnly).toBe(true);
    expect(tool.destructive).toBe(false);
    expect(tool.domain).toBe("read");
    expect(tool.strict).toBe(true);
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(Object.keys((tool.inputSchema.properties ?? {}) as object)).toEqual([]);
  });

  it("reports every registered handler and the executor's prefix domains", async () => {
    const result = await executeTool("list_action_types", {}, new HeadlessHost(makeProjectWithClip()));

    expect(result.ok).toBe(true);
    const data = result.data as { handlerTypes: string[]; domains: { prefix: string }[] };

    // The catalog is the runtime registry, not a hand-written list.
    expect(data.handlerTypes).toEqual([...listRegisteredActionTypes()].sort());
    expect(data.handlerTypes).toContain("mask/setAll");
    expect(data.handlerTypes).toContain("keyframe/setAll");

    // Domain prefixes mirror core's ActionExecutor routing.
    expect(data.domains.map((domain) => domain.prefix)).toEqual(
      expect.arrayContaining([
        "clip/",
        "transform/",
        "keyframe/",
        "effect/",
        "project/",
        "audio/",
      ]),
    );
  });

  it("covers the action types the vision tools rely on", async () => {
    const result = await executeTool("list_action_types", {}, new HeadlessHost(makeProjectWithClip()));
    const { handlerTypes } = result.data as { handlerTypes: string[] };

    // Every action a shipped tool dispatches is dispatchable through the hatch
    // as well — that is what makes the hatch a real fallback.
    for (const toolName of ["apply_subject_matte", "auto_reframe_clip", "set_clip_keyframes"]) {
      const tool = getTool(toolName)!;
      const actionType = (tool as { actionType?: string }).actionType;
      if (actionType) expect(handlerTypes).toContain(actionType);
    }
  });
});
