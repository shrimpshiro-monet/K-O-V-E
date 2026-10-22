import { describe, expect, it } from "vitest";
import { CAPABILITY_MANIFEST } from "@kove-advanced/core/capabilities/manifest";
import { EFFECT_PARAM_BLOCK } from "./director/director-prompt";
import { getTool, listTools } from "./registry";
import { executeTool } from "./executor";
import { HeadlessHost } from "./headless-host";
import { makeProjectWithClip } from "./test-fixtures";

function clipEffect(host: HeadlessHost, clipId: string): { type: string; params: Record<string, unknown> } | undefined {
  for (const track of host.getProject().timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.id !== clipId) continue;
      const effect = clip.effects[clip.effects.length - 1];
      if (effect) return { type: effect.type, params: effect.params as Record<string, unknown> };
    }
  }
  return undefined;
}

describe("EFFECT_PARAM_BLOCK is generated, not hand-written", () => {
  it("carries one line per manifest clip-effect spec", () => {
    const lines = EFFECT_PARAM_BLOCK.split("\n");
    expect(lines).toHaveLength(CAPABILITY_MANIFEST.clipEffectParams.length);
    for (const spec of CAPABILITY_MANIFEST.clipEffectParams) {
      const line = lines.find((l) => l.startsWith(`- ${spec.type}:`));
      expect(line, `missing block line for ${spec.type}`).toBeDefined();
      for (const param of spec.params) {
        expect(line).toContain(`"${param.key}"`);
      }
    }
  });

  it("states the settled scales: brightness percent offset, contrast/saturation multipliers", () => {
    expect(EFFECT_PARAM_BLOCK).toContain("- brightness:");
    expect(EFFECT_PARAM_BLOCK).toMatch(/brightness: \{ "value": -100\.\.100 % \(default 0; percent offset/);
    expect(EFFECT_PARAM_BLOCK).toMatch(/contrast: \{ "value": 0\.\.2 x \(default 1; CSS multiplier/);
    expect(EFFECT_PARAM_BLOCK).toMatch(/saturation: \{ "value": 0\.\.2 x \(default 1; CSS multiplier/);
    expect(EFFECT_PARAM_BLOCK).toContain("NEVER a percent offset");
  });

  it("ships the block in every tool description that takes effect params", () => {
    for (const name of ["add_video_effect", "update_video_effect"]) {
      const tool = getTool(name);
      expect(tool, name).toBeDefined();
      expect(tool!.description.length).toBeGreaterThan(0);
    }
    expect(getTool("add_video_effect")!.description).toContain("0..2 x (default 1");
  });

  it("no tool description hand-restates a param range that contradicts the table", () => {
    for (const tool of listTools()) {
      expect(tool.description).not.toContain("value: -100..100 }` (percent");
    }
  });
});

describe("agent effect paths clamp to the one true scale", () => {
  it("add_video_effect clamps a percent-habit contrast instead of blowing the frame", async () => {
    const host = new HeadlessHost(makeProjectWithClip());
    const result = await executeTool(
      "add_video_effect",
      { clipId: "c1", effectType: "contrast", params: { value: 50 } },
      host,
    );
    expect(result.ok).toBe(true);
    expect(clipEffect(host, "c1")).toEqual({ type: "contrast", params: { value: 2 } });
  });

  it("add_video_effect keeps legal values exactly — including falsy zeros", async () => {
    const host = new HeadlessHost(makeProjectWithClip());
    await executeTool("add_video_effect", { clipId: "c1", effectType: "contrast", params: { value: 0 } }, host);
    expect(clipEffect(host, "c1")?.params).toEqual({ value: 0 });

    const host2 = new HeadlessHost(makeProjectWithClip());
    await executeTool("add_video_effect", { clipId: "c1", effectType: "brightness", params: { value: -35 } }, host2);
    expect(clipEffect(host2, "c1")?.params).toEqual({ value: -35 });
  });

  it("update_video_effect clamps against the stored effect's type", async () => {
    const host = new HeadlessHost(makeProjectWithClip());
    await executeTool("add_video_effect", { clipId: "c1", effectType: "saturation", params: { value: 1.2 } }, host);
    const effectId = (() => {
      for (const track of host.getProject().timeline.tracks) {
        for (const clip of track.clips) {
          if (clip.id === "c1") return clip.effects[0]?.id;
        }
      }
      return undefined;
    })();
    expect(effectId).toBeDefined();
    const result = await executeTool(
      "update_video_effect",
      { clipId: "c1", effectId, params: { value: 250 } },
      host,
    );
    expect(result.ok).toBe(true);
    expect(clipEffect(host, "c1")?.params).toMatchObject({ value: 2 });
  });
});
