import { describe, expect, it } from "vitest";
import { getTool, toOpenAITools } from "./registry";
import { DEFAULT_AGENT_TOOL_LIMIT, selectToolsForPrompt } from "./tool-router";

/** PR #3: undo/redo/checkpoints are a per-turn safety net, never conditional. */
const HISTORY_SAFETY_NET = [
  "create_checkpoint",
  "list_checkpoints",
  "restore_checkpoint",
  "undo",
  "redo",
] as const;

describe("agent tool router", () => {
  it("keeps ordinary timeline editing under provider tool limits", () => {
    const names = selectToolsForPrompt("Trim the first clip, add captions, and fade the audio");
    expect(names.length).toBeLessThanOrEqual(DEFAULT_AGENT_TOOL_LIMIT);
    expect(names).toContain("trim_clip");
    expect(names).toContain("add_subtitle");
    expect(names).toContain("set_clip_fade");
    expect(names).toContain("get_editor_state");
    expect(names).toContain("execute_action");
    expect(toOpenAITools(names)).toHaveLength(names.length);
  });

  it("routes motion requests to motion tools without losing core inspection", () => {
    const names = selectToolsForPrompt(
      "Create a motion composition with animated text layers, masks, and keyframes",
    );
    expect(names.length).toBeLessThanOrEqual(DEFAULT_AGENT_TOOL_LIMIT);
    expect(names).toContain("create_motion_composition");
    expect(names).toContain("add_motion_layer");
    expect(names).toContain("get_editor_state");
    expect(names.some((name) => getTool(name)?.domain === "motion")).toBe(true);
  });

  it("routes 3D product work to semantic creation tools", () => {
    const names = selectToolsForPrompt(
      "Build a cinematic 3D product scene with an exploded view and brushed metal materials",
    );
    expect(names.length).toBeLessThanOrEqual(DEFAULT_AGENT_TOOL_LIMIT);
    expect(names).toContain("create_product_cinematic_scene");
    expect(names).toContain("animate_creation_exploded_view");
    expect(names).toContain("apply_creation_material_preset");
  });

  it("retains tools used earlier in a follow-up conversation", () => {
    const names = selectToolsForPrompt("Make it slower", {
      maxTools: 20,
      priorToolNames: ["animate_layer"],
    });
    expect(names).toContain("animate_layer");
  });

  it("keeps the history and checkpoint safety net reachable on every turn", () => {
    const ordinary = selectToolsForPrompt(
      "Trim the first clip, add captions, and fade the audio",
    );
    const motion = selectToolsForPrompt(
      "Create a motion composition with animated text layers, masks, and keyframes",
    );
    for (const name of HISTORY_SAFETY_NET) {
      expect(ordinary).toContain(name);
      expect(motion).toContain(name);
    }
  });

  it("does not spend the capped budget on motion tools for a non-motion prompt", () => {
    // Cloudflare is capped at 25 slots; motion must not take them by default.
    const names = selectToolsForPrompt(
      "Trim the first clip, add captions, and fade the audio",
      { maxTools: 25 },
    );
    expect(names.length).toBeLessThanOrEqual(25);
    expect(names).not.toContain("list_motion_compositions");
    expect(names).not.toContain("create_motion_composition");
    for (const name of HISTORY_SAFETY_NET) expect(names).toContain(name);
    // Editing tools still earn slots once motion stops squatting on them.
    expect(names).toContain("trim_clip");
  });
});
