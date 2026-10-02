import { afterEach, describe, expect, it } from "vitest";
import {
  closestKey,
  gateToolArgs,
  getSchemaMismatches,
  resetSchemaMismatches,
  setSchemaPolicy,
  validateValue,
  type GateTool,
} from "./schema-validate";
import { executeTool } from "./executor";
import { HeadlessHost } from "./headless-host";
import { makeEmptyProject } from "./test-fixtures";

const schema = {
  type: "object",
  properties: {
    name: { type: "string" },
    count: { type: "integer", minimum: 1, maximum: 10 },
    gain: { type: "number" },
    on: { type: "boolean" },
    mode: { type: "string", enum: ["a", "b"] },
    items: { type: "array", items: { type: "number" }, maxItems: 3 },
    nested: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
    free: { type: "object" },
  },
  required: ["name"],
  additionalProperties: true,
};
const ENFORCE = { coerce: true, unknownKeys: "strip" } as const;
const STRICT = { coerce: true, unknownKeys: "reject" } as const;
const SHADOW = { coerce: false, unknownKeys: "keep" } as const;

afterEach(() => {
  setSchemaPolicy({ mode: "shadow", enforceTools: [] });
  resetSchemaMismatches();
});

describe("coercion policy", () => {
  it("coerces lossless decimal strings and booleans, and reports each", () => {
    const r = validateValue(schema, { name: "n", count: "5", gain: "-0.25", on: "true" }, ENFORCE);
    expect(r.errors).toEqual([]);
    expect(r.value).toMatchObject({ count: 5, gain: -0.25, on: true });
    expect(r.notices.map((n) => n.code)).toEqual(["coerced", "coerced", "coerced"]);
  });
  it.each(["", " 5", "0x10", "1e3", "5px", "NaN", "Infinity"])("does not coerce %j", (bad) => {
    expect(validateValue(schema, { name: "n", gain: bad }, ENFORCE).errors[0]?.code).toBe("type");
  });
  it("never rounds a fractional number into an integer, or stringifies numbers", () => {
    expect(validateValue(schema, { name: "n", count: 2.5 }, ENFORCE).errors[0]?.code).toBe("type");
    expect(validateValue(schema, { name: 5 }, ENFORCE).errors[0]?.code).toBe("type");
    expect(validateValue(schema, { name: "n", count: "2.5" }, ENFORCE).errors[0]?.code).toBe("type");
  });
  it("never clamps: out of range is an error", () => {
    expect(validateValue(schema, { name: "n", count: 11 }, ENFORCE).errors[0]?.code).toBe("maximum");
    expect(validateValue(schema, { name: "n", count: "0" }, ENFORCE).errors[0]?.code).toBe("minimum");
  });
  it("treats null on an optional property as absent, but not on a required one", () => {
    const ok = validateValue(schema, { name: "n", gain: null }, ENFORCE);
    expect(ok.errors).toEqual([]);
    expect("gain" in (ok.value as object)).toBe(false);
    expect(validateValue(schema, { name: null }, ENFORCE).errors[0]?.code).toBe("required");
  });
  it("coerces inside arrays and nested objects with precise paths", () => {
    const r = validateValue(schema, { name: "n", items: ["1", 2], nested: { x: "3" } }, ENFORCE);
    expect(r.value).toMatchObject({ items: [1, 2], nested: { x: 3 } });
    expect(r.notices.map((n) => n.path)).toEqual(["items[0]", "nested.x"]);
    expect(validateValue(schema, { name: "n", items: [1, 2, 3, 4] }, ENFORCE).errors[0]?.code).toBe("maxItems");
  });
  it("returns the same reference when nothing changed (structural sharing)", () => {
    const input = { name: "n", nested: { x: 1 } };
    expect(validateValue(schema, input, ENFORCE).value).toBe(input);
  });
});

describe("unknown-key policy", () => {
  it("strip mode drops and notes; reject mode errors with did-you-mean; keep only observes", () => {
    const input = { name: "n", gian: 2 };
    const strip = validateValue(schema, input, ENFORCE);
    expect(strip.value).toEqual({ name: "n" });
    expect(strip.notices[0]?.message).toMatch(/did you mean 'gain'/);
    const reject = validateValue(schema, input, STRICT);
    expect(reject.errors[0]?.code).toBe("unknown_key");
    const shadow = validateValue(schema, input, SHADOW);
    expect(shadow.errors).toEqual([]);
    expect(shadow.observed[0]?.code).toBe("unknown_key");
    expect(shadow.value).toBe(input);
  });
  it("free-form object schemas (no declared properties) never have unknown keys", () => {
    const r = validateValue(schema, { name: "n", free: { anything: 1, goes: [true] } }, STRICT);
    expect(r.errors).toEqual([]);
  });
  it("additionalProperties:false rejects any key even when no properties are declared", () => {
    const empty = { type: "object", properties: {}, required: [], additionalProperties: false };
    expect(validateValue(empty, { x: 1 }, STRICT).errors[0]?.code).toBe("unknown_key");
    expect(validateValue(empty, {}, STRICT).errors).toEqual([]);
  });
  it("closestKey suggests within edit distance 2 only", () => {
    expect(closestKey("trackid", ["trackId", "clipId"])).toBe("trackId");
    expect(closestKey("zzzzzz", ["trackId"])).toBeUndefined();
  });
  it("implicit reference keys (clipIndex/atSec/trackIndex) are always allowed", () => {
    const tool: GateTool = { name: "t", inputSchema: schema, strict: true };
    expect(gateToolArgs(tool, { name: "n", clipIndex: 2, atSec: 1.5 }).rejection).toBeUndefined();
  });
});

describe("shadow mode never changes behaviour", () => {
  const tool: GateTool = { name: "legacy_tool", inputSchema: schema };
  it("passes the exact args through, logs aggregated mismatches", () => {
    const args = { count: "5", mystery: 1 };
    const out = gateToolArgs(tool, args);
    expect(out.mode).toBe("shadow");
    expect(out.args).toBe(args);
    expect(out.rejection).toBeUndefined();
    gateToolArgs(tool, { count: "6", mystery: 2 });
    const log = getSchemaMismatches();
    const entry = (code: string, path: string) => log.find((e) => e.code === code && e.path === path);
    expect(entry("required", "name")?.count).toBe(2);
    expect(entry("type", "count")?.count).toBe(2);
    expect(entry("unknown_key", "mystery")?.count).toBe(2);
    expect(entry("type", "count")?.example).toMatch(/expected integer, got string "5"/);
  });
  it("mode off skips validation entirely", () => {
    setSchemaPolicy({ mode: "off" });
    gateToolArgs(tool, { count: "x" });
    expect(getSchemaMismatches()).toEqual([]);
  });
});

describe("enforcement via the executor", () => {
  const host = () => new HeadlessHost(makeEmptyProject());

  it("strict (new) tools reject with {code, message, suggestedFix} before the handler runs", async () => {
    const r = await executeTool("create_checkpoint", { label: "x", bogus: 1 }, host());
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("INVALID_PARAMS");
    expect(r.error?.message).toMatch(/unknown property/);
    expect(r.error?.suggestedFix).toBeTruthy();
    const wrongType = await executeTool("create_checkpoint", { label: 5 }, host());
    expect(wrongType.error?.suggestedFix).toMatch(/string/);
  });

  it("legacy tools pass through in shadow mode, and log instead of rejecting", async () => {
    const r = await executeTool("add_track", { trackType: "video", extraneous: true }, host());
    expect(r.ok).toBe(true);
    expect(getSchemaMismatches().some((e) => e.tool === "add_track" && e.code === "unknown_key")).toBe(true);
  });

  it("a legacy tool can be enforced individually: coerces, strips, warns", async () => {
    setSchemaPolicy({ enforceTools: ["add_track"] });
    const r = await executeTool("add_track", { trackType: "video", position: "0", extraneous: true }, host());
    expect(r.ok).toBe(true);
    expect(r.warnings?.join("\n")).toMatch(/position: coerced string "0" to number 0/);
    expect(r.warnings?.join("\n")).toMatch(/extraneous: unknown property — ignored/);
    const rejected = await executeTool("add_track", { position: 1 }, host());
    expect(rejected.error?.code).toBe("INVALID_PARAMS");
    expect(rejected.error?.suggestedFix).toMatch(/trackType/);
  });

  it("execute_action's flat form survives enforcement (freeform)", async () => {
    setSchemaPolicy({ mode: "enforce" });
    const r = await executeTool("execute_action", { type: "track/add", trackType: "audio" }, host());
    expect(r.ok).toBe(true);
  });

  it("add_clip / add_track / add_scene_object declare the params their handlers really read", async () => {
    const { getTool } = await import("./registry");
    setSchemaPolicy({ enforceTools: ["add_clip", "add_track", "add_scene_object"] });
    const clip = gateToolArgs(getTool("add_clip")!, {
      trackId: "t", mediaId: "m", startTime: "1.5", duration: 2, inPoint: 0, outPoint: 2, volume: 1, speed: 1, reversed: false,
      transform: {}, fade: { fadeIn: 0, fadeOut: 0 },
    });
    expect(clip.rejection).toBeUndefined();
    expect(clip.warnings.join()).not.toMatch(/ignored/);
    expect(clip.args).toMatchObject({ startTime: 1.5, duration: 2, speed: 1 });
    const track = gateToolArgs(getTool("add_track")!, { trackType: "audio", name: "Music", role: "music" });
    expect(track.rejection).toBeUndefined();
    expect(track.warnings).toEqual([]);
    expect(gateToolArgs(getTool("add_track")!, { trackType: "audio", role: "bogus" }).rejection?.error?.suggestedFix).toMatch(/general/);
    const scene = gateToolArgs(getTool("add_scene_object")!, {
      compositionId: "c", layerId: "l", kind: "box", key: "k", objectId: "o", partId: "p", parentId: "x", parentKey: "y",
    });
    expect(scene.warnings.join()).not.toMatch(/ignored/);
  });
});
