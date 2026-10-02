import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { generateCapabilityMarkdown } from "./gen-docs";
import { toolDefs } from "./registry";

const here = path.dirname(fileURLToPath(import.meta.url));
/** The committed, generated reference. Never hand-edit; see the regenerate hint below. */
const CAPABILITIES_DOC = path.resolve(here, "../../../docs/AGENT-CAPABILITIES.md");

const normalize = (s: string): string => s.replace(/\r\n/g, "\n");

describe("generateCapabilityMarkdown", () => {
  it("renders a markdown doc covering the registry and manifest", () => {
    const md = generateCapabilityMarkdown();
    expect(md).toContain("# Kove Advanced Agent — Capability Reference");
    expect(md).toContain(`**${toolDefs().length} tools**`);
    expect(md).toContain("list_clips");
    expect(md).toContain("execute_action");
    expect(md).toContain("Capability manifest");
    expect(md).toMatch(/```json[\s\S]*```/);
  });

  it("covers every user-facing registered tool (a tool that isn't in the doc fails)", () => {
    const md = generateCapabilityMarkdown();
    const missing = toolDefs()
      .filter((t) => !t.internal)
      .filter((t) => !md.includes(`- **${t.name}**`))
      .map((t) => t.name);
    expect(missing).toEqual([]);
  });
});

describe("docs/AGENT-CAPABILITIES.md freshness", () => {
  // Regenerate with:  pnpm --filter @kove-advanced/agent gen:docs
  if (process.env.KOVE_WRITE_DOCS === "1") {
    it("rewrites the committed capability doc", () => {
      writeFileSync(CAPABILITIES_DOC, generateCapabilityMarkdown(), "utf8");
    });
    return;
  }

  it("matches what the registry generates (not stale)", () => {
    expect(existsSync(CAPABILITIES_DOC), "docs/AGENT-CAPABILITIES.md is missing").toBe(true);
    const committed = normalize(readFileSync(CAPABILITIES_DOC, "utf8"));
    const generated = normalize(generateCapabilityMarkdown());
    const hint =
      "docs/AGENT-CAPABILITIES.md is stale. Regenerate it with `pnpm --filter @kove-advanced/agent gen:docs` and commit the result. " +
      `(committed says ${/\*\*(\d+) tools\*\*/.exec(committed)?.[1] ?? "?"} tools, registry has ${toolDefs().length})`;
    expect(committed === generated, hint).toBe(true);
  });
});
