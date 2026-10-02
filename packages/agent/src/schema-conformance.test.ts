import { describe, expect, it } from "vitest";
import legacy from "./schema-legacy-tools.json";
import { listTools } from "./registry";
import { gateToolArgs, unsupportedKeywords } from "./schema-validate";

const tools = listTools();
const LEGACY = new Set(legacy.tools);

describe("tool schema conformance", () => {
  it("every schema is a well-formed object schema using only keywords the validator understands", () => {
    const problems: string[] = [];
    for (const t of tools) {
      if (t.inputSchema.type !== "object") problems.push(`${t.name}: root type must be object`);
      const props = Object.keys((t.inputSchema.properties ?? {}) as object);
      for (const key of (t.inputSchema.required ?? []) as string[]) {
        if (!props.includes(key)) problems.push(`${t.name}: required '${key}' is not a declared property`);
      }
      for (const kw of unsupportedKeywords(t.inputSchema)) problems.push(`${t.name}: unsupported keyword ${kw}`);
    }
    expect(problems).toEqual([]);
  });

  it("every tool NOT in the legacy snapshot is strict (new tools are enforced from day one)", () => {
    const offenders = tools.filter((t) => !LEGACY.has(t.name) && t.strict !== true).map((t) => t.name);
    expect(offenders, "new tools must set strict:true — do not add them to schema-legacy-tools.json").toEqual([]);
  });

  it("strict tools declare their properties and are not free-form", () => {
    for (const t of tools.filter((x) => x.strict)) {
      expect(t.freeform, t.name).not.toBe(true);
      expect(t.inputSchema.additionalProperties, t.name).toBe(false);
      expect(Object.keys((t.inputSchema.properties ?? {}) as object).length + 1, t.name).toBeGreaterThan(0);
    }
  });

  it("the legacy snapshot has no stale names", () => {
    const names = new Set(tools.map((t) => t.name));
    expect(legacy.tools.filter((n: string) => !names.has(n))).toEqual([]);
  });

  it("direct reads in a handler are declared in its schema (cannot see reads through helpers)", () => {
    const allow: Record<string, string[]> = {};
    const bad: string[] = [];
    for (const t of tools) {
      const src = t.handler.toString();
      const m = /^(?:async\s*)?(?:function\s*\w*\s*)?\(?\s*([A-Za-z_$][\w$]*)/.exec(src);
      const p = (m?.[1] ?? "args").replace("$", "\\$");
      const re = new RegExp(`\\b${p}\\??\\.([A-Za-z_$][\\w$]*)|\\b${p}\\[["']([^"']+)["']\\]`, "g");
      const props = new Set(Object.keys((t.inputSchema.properties ?? {}) as object));
      const implicit = new Set(["clipIndex", "atSec", "trackIndex"]);
      let x: RegExpExecArray | null;
      while ((x = re.exec(src))) {
        const key = (x[1] ?? x[2])!;
        if (props.has(key) || implicit.has(key) || allow[t.name]?.includes(key)) continue;
        bad.push(`${t.name}: reads '${key}' which is not declared`);
      }
    }
    expect([...new Set(bad)]).toEqual([]);
  });

  it("strict tools reject an empty/garbage call before running (spot-check every strict tool)", () => {
    for (const t of tools.filter((x) => x.strict)) {
      const out = gateToolArgs(t, { __bogus__: 1 });
      expect(out.rejection?.error?.suggestedFix, t.name).toBeTruthy();
    }
  });
});
