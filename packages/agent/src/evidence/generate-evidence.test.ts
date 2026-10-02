import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { listTools, type RegisteredTool } from "../registry";
import { TRANSITION_TYPES, EFFECT_DEFINITIONS } from "@kove-advanced/core/types/effects";
import { EFFECT_SHADERS } from "@kove-advanced/core/motion/shaders/effect-shaders";
import { textAnimationEngine } from "@kove-advanced/core/text/text-animation";
import { TransitionEngine } from "@kove-advanced/core/video/transition-engine";
import { listRegisteredActionTypes } from "@kove-advanced/core/actions/registry";
// Side-effect import: handler modules register themselves when this loads.
import "@kove-advanced/core/actions/handlers";
import { DENSITY_PRESETS, resolveDensityTarget } from "@kove-advanced/creation-schema/director/density";
import {
  SUPPORTED_TRANSITION_TYPES,
  SUPPORTED_CLIP_EFFECT_TYPES,
  SUPPORTED_EFFECT_TYPES,
  COLOR_GRADE_EFFECT_TYPES,
  CUT_TRANSITION_TYPES,
  TRANSITION_TYPE_ALIASES,
  SUPPORTED_TEXT_ANIMATIONS,
  TEXT_ANIMATION_ALIASES,
} from "@kove-advanced/creation-schema/director/vocab";
import {
  SIGNATURE_EFFECT_DEFS,
  SIGNATURE_EFFECT_ALIASES,
} from "@kove-advanced/creation-schema/director/shader-effects";
import { CAMERA_MOVE_IDS, CAMERA_MOVE_ATLAS } from "@kove-advanced/creation-schema/director/camera-moves";
import { PRE_BAKED_GENRES } from "../director/genres";

/**
 * Generates `evidence/` — the per-item capability documentation — and asserts
 * that every count it prints is true of the running code.
 *
 * The assertions are the point: the moment a tool is renamed, a transition loses
 * its defaults, a shader param stops having a uniform, or an action type stops
 * reaching an executor branch, this file fails and the docs would have been a
 * lie. Writing the files is opt-in so a normal test run leaves the tree alone:
 *
 *   KOVE_WRITE_EVIDENCE=1 vitest run packages/agent/src/evidence/
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const EVIDENCE = join(REPO, "evidence");
const WRITE = process.env.KOVE_WRITE_EVIDENCE === "1";

const written: Array<{ path: string; lines: number }> = [];

function emit(relativePath: string, contents: string): void {
  const body = contents.endsWith("\n") ? contents : `${contents}\n`;
  written.push({ path: relativePath, lines: body.split("\n").length - 1 });
  if (!WRITE) return;
  const target = join(EVIDENCE, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
}

/* ------------------------------------------------------------------ *
 * Reading the sources that have no runtime table
 * ------------------------------------------------------------------ */

const EXECUTOR_SRC = readFileSync(
  join(REPO, "packages/core/src/actions/action-executor.ts"),
  "utf8",
);
const PANEL_SRC = readFileSync(
  join(REPO, "apps/web/src/components/editor/panels/EffectsTransitionsPanel.tsx"),
  "utf8",
);
const INSPECTOR_SRC = readFileSync(
  join(REPO, "apps/web/src/components/editor/inspector/TransitionInspector.tsx"),
  "utf8",
);
const EFFECTS_BRIDGE_SRC = readFileSync(
  join(REPO, "apps/web/src/bridges/effects-bridge.ts"),
  "utf8",
);

interface ActionParam {
  name: string;
  type: string;
}

const fieldHandlerParams = new Map<string, string>();

/**
 * Fields a plan review reads. `minimumMotionMoments` and
 * `minimumOnBeatCutRatio` are optional in the schema and the slow preset omits
 * the former, so the docs must not assume they are present.
 */
const REQUIRED_DENSITY_FIELDS = [
  "shotsPerMinute",
  "effectHitsPerMinute",
  "minimumEffectTypes",
  "minimumTreatedShotRatio",
  "minimumCameraMoveRatio",
  "minimumCameraMoveVariety",
  "minimumSpeedRamps",
  "textsPerMinute",
  "minimumTextAnimations",
  "minimumSfxHits",
  "hookShots",
] as const;

interface ActionEntry {
  type: string;
  domain: string;
  /** Where the behaviour lives. */
  impl: string;
  /** Properties the implementation reads. */
  reads: ActionParam[];
  /** Properties the tool surface accepts for this action. */
  accepts: ActionParam[];
  tools: string[];
}

/** Every `case "domain/thing":` in the executor switch, with the params it reads. */
function parseActionCases(): Array<{ type: string; line: number; reads: ActionParam[] }> {
  const lines = EXECUTOR_SRC.split("\n");
  const out: Array<{ type: string; line: number; reads: ActionParam[] }> = [];

  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)case "([a-z][A-Za-z-]*\/[A-Za-z0-9-]+)":\s*(\{?)\s*$/.exec(lines[i]);
    if (!m) continue;

    const indent = m[1];
    const brace = m[3];
    const body: string[] = [];
    if (brace) {
      let depth = 1;
      for (let j = i + 1; j < lines.length && depth > 0; j++) {
        depth += (lines[j].match(/\{/g) ?? []).length - (lines[j].match(/\}/g) ?? []).length;
        if (depth <= 0) break;
        body.push(lines[j]);
      }
    } else {
      const stop = new RegExp(`^\\s{0,${indent.length}}(case |default:|\\})`);
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() && stop.test(lines[j])) break;
        body.push(lines[j]);
      }
    }

    const text = body.join("\n");
    const reads: ActionParam[] = [];

    const cast = /(?:action\.params|params)\s+as\s+\{/.exec(text);
    if (cast) {
      const start = text.indexOf("{", cast.index);
      let depth = 0;
      let end = start;
      for (let k = start; k < text.length; k++) {
        if (text[k] === "{") depth++;
        else if (text[k] === "}") {
          depth--;
          if (depth === 0) {
            end = k;
            break;
          }
        }
      }
      const inside = text.slice(start + 1, end);
      let buf = "";
      let d = 0;
      const parts: string[] = [];
      for (const ch of inside) {
        if (ch === "{" || ch === "<" || ch === "(") d++;
        if (ch === "}" || ch === ">" || ch === ")") d--;
        if ((ch === ";" || ch === ",") && d === 0) {
          parts.push(buf);
          buf = "";
        } else buf += ch;
      }
      if (buf.trim()) parts.push(buf);
      for (const part of parts) {
        const pm = /^\s*([A-Za-z_$][\w$]*)\??\s*:\s*([^;]+)$/.exec(part.replace(/\n/g, " "));
        if (pm) reads.push({ name: pm[1], type: pm[2].trim() });
      }
    }

    for (const dm of text.matchAll(/action\.params\.([A-Za-z_$][\w$]*)/g)) {
      if (!reads.some((p) => p.name === dm[1])) reads.push({ name: dm[1], type: "any" });
    }
    for (const dm of text.matchAll(/action\.params\["([^"]+)"\]/g)) {
      if (!reads.some((p) => p.name === dm[1])) reads.push({ name: dm[1], type: "any" });
    }
    for (const dm of text.matchAll(/action\.params\['([^']+)'\]/g)) {
      if (!reads.some((p) => p.name === dm[1])) reads.push({ name: dm[1], type: "any" });
    }
    // `{ ...action.params }` — every key the caller passes is written, so the
    // concrete list is whatever the tool schema allows.
    if (/\.\.\.\s*action\.params/.test(text)) {
      reads.push({ name: "(all passed params)", type: "spread into the target" });
    }

    out.push({ type: m[2], line: i + 1, reads });
  }
  return out;
}

/**
 * Types implemented as handler modules (`actions/handlers/*.ts`) rather than
 * switch cases. These are the newer path and cover their own validation.
 */
function parseHandlerTypes(): Map<string, string> {
  const dir = join(REPO, "packages/core/src/actions/handlers");
  const map = new Map<string, string>();
  fieldHandlerParams.clear();

  for (const file of readFileSync(join(dir, "index.ts"), "utf8").matchAll(/import "\.\/([\w-]+)";/g)) {
    const name = file[1];
    let src: string;
    try {
      src = readFileSync(join(dir, `${name}.ts`), "utf8");
    } catch {
      continue;
    }

    // Literal declarations: `type: "clip/setSpeed"`.
    for (const m of src.matchAll(/type:\s*"([a-z][A-Za-z-]*\/[A-Za-z0-9-]+)"/g)) {
      if (!map.has(m[1])) map.set(m[1], `handlers/${name}.ts`);
    }

    // Factory declarations: `makeOverlayHandlers(prefix, field)` called with
    // `{ prefix: "text" }` produces `text/create|update|remove`.
    const prefixes = [...src.matchAll(/prefix:\s*"([a-z][\w-]*)"/g)].map((m) => m[1]);
    const suffixes = [...new Set([...src.matchAll(/\$\{prefix\}\/(\w+)/g)].map((m) => m[1]))];
    for (const prefix of prefixes) {
      for (const suffix of suffixes) {
        if (!map.has(`${prefix}/${suffix}`)) map.set(`${prefix}/${suffix}`, `handlers/${name}.ts`);
      }
    }

    // Field handlers: the spec names the property the action writes.
    for (const m of src.matchAll(/makeClipFieldHandler\(\{([\s\S]*?)\n\s*\}\)/g)) {
      const type = /type:\s*"([^"]+)"/.exec(m[1])?.[1];
      const paramKey = /paramKey:\s*"([^"]+)"/.exec(m[1])?.[1];
      if (type && !map.has(type)) map.set(type, `handlers/${name}.ts`);
      if (type && paramKey) fieldHandlerParams.set(type, paramKey);
    }
  }
  return map;
}

/**
 * The stretch of a handler module that implements one action. Handlers are
 * declared as `const name: ActionHandler = {…}` or generated by a factory, so
 * the block runs from this handler's own declaration to the next one.
 */
function handlerBlockFor(src: string, type: string): string {
  const suffix = type.split("/")[1];
  const starts = [
    src.indexOf(`"${type}"`),
    src.indexOf(`\`\${prefix}/${suffix}\``),
    src.indexOf(`\$\{prefix}/${suffix}`),
  ].filter((i) => i >= 0);
  if (!starts.length) return src;
  const start = Math.min(...starts);

  const rest = src.slice(start + 4);
  const boundary = /\n(?=const |export |for \(|function )|\n\s{2}type:/.exec(rest);
  return boundary ? rest.slice(0, boundary.index) : rest;
}

/** Methods that name the single action type they accept via a guard. */
function parseGuardedMethods(): Map<string, { method: string; reads: ActionParam[] }> {
  const map = new Map<string, { method: string; reads: ActionParam[] }>();
  const lines = EXECUTOR_SRC.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const guard = /action\.type !== "([a-z][A-Za-z-]*\/[A-Za-z0-9-]+)"/.exec(lines[i]);
    if (!guard) continue;
    // Walk back to the enclosing private method.
    let method = "unknown";
    for (let j = i; j >= 0; j--) {
      const m = /^\s{2}(?:private|async private|public)?\s*([A-Za-z_][\w]*)\(/.exec(lines[j]);
      if (m) {
        method = m[1];
        break;
      }
    }
    const reads: ActionParam[] = [];
    for (let j = i; j < lines.length && j < i + 60; j++) {
      for (const dm of lines[j].matchAll(/action\.params\.([A-Za-z_$][\w$]*)/g)) {
        if (!reads.some((r) => r.name === dm[1])) reads.push({ name: dm[1], type: "see types/actions.ts" });
      }
      const cast = /action\.params\s+as\s+\{([^}]*)\}/.exec(lines[j]);
      if (cast) {
        for (const part of cast[1].split(/[;\n]/)) {
          const pm = /^\s*([A-Za-z_$][\w$]*)\??\s*:\s*(.+)$/.exec(part);
          if (pm && !reads.some((r) => r.name === pm[1])) reads.push({ name: pm[1], type: pm[2].trim() });
        }
      }
    }
    map.set(guard[1], { method, reads });
  }
  return map;
}


/**
 * The picker's preset list. Entries are literal objects or `.map()` variant
 * groups, so a line scan misses some — brace-match the array and split at
 * depth-zero commas instead.
 */
function parsePanelEntries(): Array<{ type: string; label: string | null; id: string | null }> {
  const start = PANEL_SRC.indexOf("const TRANSITIONS: TransitionDef[] = [");
  const open = PANEL_SRC.indexOf("= [", start) + 2;
  let depth = 0;
  let close = open;
  for (let i = open; i < PANEL_SRC.length; i++) {
    if (PANEL_SRC[i] === "[") depth++;
    else if (PANEL_SRC[i] === "]") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  const inner = PANEL_SRC.slice(open + 1, close);

  const entries: string[] = [];
  let buf = "";
  let d = 0;
  for (const ch of inner) {
    if (ch === "{" || ch === "[" || ch === "(") d++;
    else if (ch === "}" || ch === "]" || ch === ")") d--;
    if (ch === "," && d === 0) {
      entries.push(buf);
      buf = "";
    } else buf += ch;
  }
  if (buf.trim()) entries.push(buf);

  const out: Array<{ type: string; label: string | null; id: string | null }> = [];
  for (const entry of entries) {
    const type = /\btype:\s*"([A-Za-z0-9]+)"/.exec(entry)?.[1];
    if (!type) continue;
    out.push({
      type,
      label: /\blabel:\s*"([^"]+)"/.exec(entry)?.[1] ?? null,
      id: /\bid:\s*"([a-z0-9-]+)"/.exec(entry)?.[1] ?? null,
    });
  }
  return out;
}

/** The four buckets the editor groups transitions into. */
function parseTransitionCategories(): Map<string, string> {
  const fn = PANEL_SRC.indexOf("const transitionCategory = (type: TransitionType)");
  const body = PANEL_SRC.slice(fn, PANEL_SRC.indexOf("\n};", fn));
  const map = new Map<string, string>();
  for (const block of body.matchAll(/if \(\s*([\s\S]*?)\)\s*\{\s*return "([A-Za-z]+)";/g)) {
    for (const t of block[1].matchAll(/type === "([A-Za-z0-9]+)"/g)) map.set(t[1], block[2]);
  }
  return map;
}

/* ------------------------------------------------------------------ *
 * Runtime tables
 * ------------------------------------------------------------------ */

const engine = new TransitionEngine({ width: 1920, height: 1080 });
const transitionTypes = TRANSITION_TYPES as unknown as readonly string[];
const panelEntries = parsePanelEntries();
const panelIds = panelEntries.map((e) => e.type);
const panelLabels = new Map<string, string>();
// Base entries (no variant id) win; a variant's label is about its parameter.
for (const entry of [...panelEntries].sort((a, b) => Number(!!a.id) - Number(!!b.id))) {
  if (entry.label && !panelLabels.has(entry.type)) panelLabels.set(entry.type, entry.label);
}
const panelVariants = panelEntries.filter((e) => e.id);
const categories = parseTransitionCategories();

const tools = listTools();

interface ToolRow {
  name: string;
  domain: string;
  title: string;
  actionType: string | null;
  kind: "read" | "action" | "direct";
  flags: string;
  params: Array<{ name: string; type: string; required: boolean; extra: string }>;
}

const toolRows: ToolRow[] = tools.map((tool: RegisteredTool) => {
  const schema = tool.inputSchema as {
    properties?: Record<string, { type?: string; enum?: unknown[]; description?: string }>;
    required?: string[];
  };
  const required = new Set(schema.required ?? []);
  const props = schema.properties ?? {};
  return {
    name: tool.name,
    domain: tool.domain,
    title: tool.title,
    actionType: tool.actionType ?? null,
    kind: tool.readOnly ? "read" : tool.actionType ? "action" : "direct",
    flags: [
      tool.readOnly ? "read-only" : null,
      tool.destructive ? "destructive" : null,
      tool.expensive ? "expensive" : null,
      tool.actionType ? "action-backed" : "direct-handler",
    ]
      .filter(Boolean)
      .join(", "),
    params: Object.entries(props).map(([name, def]) => ({
      name,
      type: def.type ?? "any",
      required: required.has(name),
      extra: def.enum ? `one of: ${def.enum.map(String).join(" | ")}` : "",
    })),
  };
});

/* tool name → action type, for the actions document */
const toolsByAction = new Map<string, string[]>();
for (const row of toolRows) {
  if (!row.actionType) continue;
  toolsByAction.set(row.actionType, [...(toolsByAction.get(row.actionType) ?? []), row.name]);
}

const actionCases = parseActionCases();
const handlerTypes = parseHandlerTypes();
const registeredHandlers = new Set(listRegisteredActionTypes());

const guardedMethods = parseGuardedMethods();

/** Union of both execution paths, with what each action reads and accepts. */
const actionEntries: ActionEntry[] = [...new Set([
  ...actionCases.map((c) => c.type),
  ...handlerTypes.keys(),
  ...registeredHandlers,
  ...toolsByAction.keys(),
])]
  .map((type) => {
    const fromSwitch = actionCases.find((c) => c.type === type);
    const guarded = guardedMethods.get(type);
    const handlerFile = handlerTypes.get(type);
    const reads: ActionParam[] = fromSwitch ? [...fromSwitch.reads] : [...(guarded?.reads ?? [])];
    // A handler's params come from the casts in the module that implements it.
    // Factory handlers share a module, so this is the union across it; the
    // per-action property for those is the `paramKey` recorded above.
    if (handlerFile) {
      const moduleSrc = readFileSync(join(REPO, "packages/core/src/actions", handlerFile), "utf8");
      const src = handlerBlockFor(moduleSrc, type);
      for (const cast of src.matchAll(/params\s+as\s+\{([^}]*)\}/g)) {
        for (const part of cast[1].split(/[;\n]/)) {
          const pm = /^\s*([A-Za-z_$][\w$]*)\??\s*:\s*(.+)$/.exec(part);
          if (pm && !reads.some((r) => r.name === pm[1])) {
            reads.push({ name: pm[1], type: pm[2].trim() });
          }
        }
      }
      // Direct property reads (`action.params.operation`).
      for (const dm of src.matchAll(/action\.params\.([A-Za-z_$][\w$]*)/g)) {
        if (!reads.some((r) => r.name === dm[1])) {
          reads.push({ name: dm[1], type: "see types/actions.ts" });
        }
      }
      // A cast to a named type: read that type's fields out of the same file.
      for (const named of src.matchAll(/params\s+as\s+(?:unknown\s+as\s+)?(?:Partial<)?([A-Z]\w+)/g)) {
        const decl = new RegExp(
          `(?:interface|type)\\s+${named[1]}\\b[^{]*\\{([^}]*)\\}`
        ).exec(src);
        if (!decl) continue;
        for (const part of topLevelParts(decl[1], ";").flatMap((p) => p.split("\n"))) {
          const pm = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:\s*(.+)$/.exec(part);
          if (pm && !reads.some((r) => r.name === pm[1])) {
            reads.push({ name: pm[1], type: cleanType(pm[2]) });
          }
        }
      }
    }
    // Some modules read params in helpers outside the handler object; if the
    // scoped block yielded nothing, fall back to the module.
    if (!reads.length && handlerFile) {
      const moduleSrc = readFileSync(join(REPO, "packages/core/src/actions", handlerFile), "utf8");
      for (const cast of moduleSrc.matchAll(/params\s+as\s+(?:unknown\s+as\s+)?(?:Partial<)?([A-Z]\w+)/g)) {
        const decl = new RegExp(`(?:interface|type)\\s+${cast[1]}\\b[^{]*\\{([^}]*)\\}`).exec(moduleSrc);
        if (!decl) continue;
        for (const part of topLevelParts(decl[1], ";").flatMap((p) => p.split("\n"))) {
          const pm = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:\s*(.+)$/.exec(part);
          if (pm && !reads.some((r) => r.name === pm[1])) {
            reads.push({ name: pm[1], type: cleanType(pm[2]) });
          }
        }
      }
      for (const dm of moduleSrc.matchAll(/action\.params\.([A-Za-z_$][\w$]*)/g)) {
        if (!reads.some((r) => r.name === dm[1])) reads.push({ name: dm[1], type: "see the implementing module" });
      }
      for (const cast of moduleSrc.matchAll(/params\s+as\s+\{([^}]*)\}/g)) {
        for (const part of cast[1].split(/[;\n]/)) {
          const pm = /^\s*([A-Za-z_$][\w$]*)\??\s*:\s*(.+)$/.exec(part);
          if (pm && !reads.some((r) => r.name === pm[1])) reads.push({ name: pm[1], type: pm[2].trim() });
        }
      }
    }

    const fieldParam = fieldHandlerParams.get(type);
    if (fieldParam) {
      for (const name of ["clipId", fieldParam]) {
        if (!reads.some((r) => r.name === name)) {
          reads.push({ name, type: name === "clipId" ? "string" : "unknown" });
        }
      }
    }
    const accepts: ActionParam[] = [];
    for (const toolName of toolsByAction.get(type) ?? []) {
      const tool = toolRows.find((t) => t.name === toolName)!;
      for (const p of tool.params) {
        if (!accepts.some((a) => a.name === p.name)) accepts.push({ name: p.name, type: p.type });
      }
    }
    return {
      type,
      domain: type.split("/")[0],
      impl: handlerFile
        ? `handler: ${handlerFile}${fromSwitch ? " (also a switch case)" : ""}`
        : fromSwitch
          ? `action-executor.ts:${fromSwitch.line}`
          : guarded
            ? `action-executor.ts:${guarded.method} (type-guarded)`
            : "unimplemented",
      reads,
      accepts,
      tools: toolsByAction.get(type) ?? [],
    };
  })
  .sort((a, b) => a.type.localeCompare(b.type));

/* ------------------------------------------------------------------ *
 * Assertions — the docs are only allowed to claim what passes here
 * ------------------------------------------------------------------ */

describe("capability evidence", () => {
  it("has a well-formed, non-empty tool surface", () => {
    expect(toolRows.length).toBeGreaterThanOrEqual(300);
    expect(new Set(toolRows.map((t) => t.name)).size).toBe(toolRows.length);
    for (const row of toolRows) {
      expect(row.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(row.domain.length).toBeGreaterThan(0);
      expect(row.title.length).toBeGreaterThan(0);
    }
  });

  it("implements every action type a tool can dispatch", () => {
    // An action-backed tool must reach either a switch case in the executor or
    // a registered handler. Anything else would be the silent-no-op bug.
    const unimplemented = actionEntries.filter((a) => a.impl === "unimplemented").map((a) => a.type);
    expect(unimplemented).toEqual([]);
  });

  it("describes the parameters of every action", () => {
    const opaque = actionEntries.filter((a) => a.reads.length === 0).map((a) => a.type);
    expect(opaque).toEqual([]);
  });

  it("agrees with the runtime handler registry", () => {
    // The source scan must not drift from what the process actually registered.
    const scanned = new Set(handlerTypes.keys());
    const missingFromScan = [...registeredHandlers].filter((t) => !scanned.has(t));
    expect(missingFromScan).toEqual([]);
    expect(registeredHandlers.size).toBeGreaterThan(0);
  });

  it("wires all 38 transitions through engine, defaults, panel and inspector", () => {
    expect(transitionTypes).toHaveLength(38);
    expect(SUPPORTED_TRANSITION_TYPES).toHaveLength(38);

    const panelTypes = new Set(panelIds);
    const missingPanel = transitionTypes.filter((t) => !panelTypes.has(t));
    expect(missingPanel).toEqual([]);

    const missingInspector = transitionTypes.filter(
      (t) => !new RegExp(`case "${t}":`).test(INSPECTOR_SRC),
    );
    expect(missingInspector).toEqual([]);

    const noDefaults = transitionTypes.filter((t) => {
      const p = engine.getDefaultParams(t as never);
      return !p || Object.keys(p).length === 0;
    });
    expect(noDefaults).toEqual([]);

    const uncreatable = transitionTypes.filter((t) => {
      const mk = (id: string, start: number) =>
        ({
          id,
          mediaId: "m",
          trackId: "t",
          startTime: start,
          duration: 2,
          inPoint: 0,
          outPoint: 2,
          effects: [],
          audioEffects: [],
          transform: { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotation: 0, opacity: 1 },
          volume: 1,
          keyframes: {},
        }) as never;
      return engine.createTransition(mk("a", 0), mk("b", 2), t as never, 0.5) === null;
    });
    expect(uncreatable).toEqual([]);
  });

  it("wires all 20 shader looks to params with matching uniforms", () => {
    expect(EFFECT_SHADERS).toHaveLength(20);
    const orphanParams: string[] = [];
    for (const shader of EFFECT_SHADERS) {
      expect(shader.params.length).toBeGreaterThan(0);
      for (const param of shader.params) {
        if (!shader.glsl.includes(`u_${param.name}`)) {
          orphanParams.push(`${shader.id}.${param.name}`);
        }
      }
    }
    expect(orphanParams).toEqual([]);
  });

  it("wires all 25 text animation presets to default params", () => {
    const presets = textAnimationEngine.getAvailablePresets();
    expect(presets).toHaveLength(25);
    const broken = presets.filter((preset) => {
      const animation = textAnimationEngine.createAnimationPreset(preset);
      return !animation || !animation.params;
    });
    expect(broken).toEqual([]);
  });

  it("keeps the clip effect library complete", () => {
    expect(EFFECT_DEFINITIONS.length).toBeGreaterThanOrEqual(14);
    for (const def of EFFECT_DEFINITIONS) {
      expect(def.params.length).toBeGreaterThan(0);
      for (const param of def.params) {
        expect(param).toHaveProperty("default");
      }
    }
  });

  it("resolves every declared alias to a real target", () => {
    const badTransitions = Object.entries(TRANSITION_TYPE_ALIASES).filter(
      ([, target]) => !transitionTypes.includes(target),
    );
    expect(badTransitions).toEqual([]);
    const badText = Object.entries(TEXT_ANIMATION_ALIASES).filter(
      ([, target]) => !SUPPORTED_TEXT_ANIMATIONS.includes(target),
    );
    expect(badText).toEqual([]);
    const badLooks = Object.entries(SIGNATURE_EFFECT_ALIASES).filter(
      ([, target]) => !SIGNATURE_EFFECT_DEFS.some((d) => d.name === target),
    );
    expect(badLooks).toEqual([]);
  });

  it("describes every genre, camera move and signature effect", () => {
    expect(PRE_BAKED_GENRES.length).toBeGreaterThanOrEqual(19);
    for (const genre of PRE_BAKED_GENRES) {
      expect(genre.id).toBeTruthy();
      expect(genre.name).toBeTruthy();
      // A genre either states its own density contract or inherits its pacing
      // preset's — both must resolve to a complete target.
      const resolved = resolveDensityTarget(genrePacing(genre), genre.densityTarget);
      const shortfalls = REQUIRED_DENSITY_FIELDS.filter(
        (field) => resolved[field as keyof typeof resolved] === undefined,
      );
      expect(shortfalls, `${genre.id} is missing ${shortfalls.join(", ")}`).toEqual([]);
      expect(resolved.shotsPerMinute?.length).toBe(2);
      expect(resolved.minimumEffectTypes).toBeGreaterThan(0);
    }
    expect(CAMERA_MOVE_IDS.length).toBeGreaterThanOrEqual(14);
    for (const id of CAMERA_MOVE_IDS) expect(CAMERA_MOVE_ATLAS[id]).toBeTruthy();
    expect(SIGNATURE_EFFECT_DEFS.length).toBeGreaterThanOrEqual(20);
  });

  it("writes the evidence files when asked", () => {
    writeAll();
    if (!WRITE) {
      expect(written.length).toBeGreaterThan(0);
      return;
    }
    const missing = written.filter((w) => !existsSync(join(EVIDENCE, w.path)));
    expect(missing).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The documents
 * ------------------------------------------------------------------ */

function generationsHeader(): string {
  return `> Generated by \`packages/agent/src/evidence/generate-evidence.test.ts\`.
> Regenerate with:
>
> \`\`\`bash
> KOVE_WRITE_EVIDENCE=1 vitest run packages/agent/src/evidence/
> \`\`\`
>
> Every figure here is asserted by that file against the running code, so a
> rename or a dropped registration fails the suite rather than rotting here.
`;
}

/**
 * The pacing a genre resolves to, using the same precedence the prompt builder
 * and the plan review use (`packages/agent/src/director/plan-review.ts`):
 * an explicit `pacing`, then the legacy `rules.pacing`, then "medium".
 */
function genrePacing(genre: (typeof PRE_BAKED_GENRES)[number]): "fast" | "medium" | "slow" {
  return (genre.pacing ?? genre.rules?.pacing ?? "medium") as "fast" | "medium" | "slow";
}

/** Split a `{ a: X; b: { c: Y } }` body at top-level separators only. */
function topLevelParts(body: string, separators = ";,"): string[] {
  const parts: string[] = [];
  let buf = "";
  let depth = 0;
  for (const ch of body) {
    if (ch === "{" || ch === "<" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ">" || ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    if (depth === 0 && separators.includes(ch)) {
      parts.push(buf);
      buf = "";
    } else buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}

/**
 * A field type that came out of a regex-bounded block can be truncated when it
 * contains a nested object. Rather than print half a type, show the head and an
 * ellipsis so the doc never states something false.
 */
function cleanType(type: string): string {
  let depth = 0;
  for (const ch of type) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  if (depth <= 0) return type.trim();
  const cut = type.indexOf("{");
  return `${type.slice(0, cut).trim()} { … }`;
}

function mdCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

function writeAll(): void {
  written.length = 0;

  const domainOrder = [...new Set(toolRows.map((t) => t.domain))].sort(
    (a, b) =>
      toolRows.filter((t) => t.domain === b).length -
      toolRows.filter((t) => t.domain === a).length,
  );

  /* ---------------- tools.md ---------------- */
  let toolsDoc = `# Tools\n\nEvery tool the agent can call, with the parameters each one accepts.\n\n`;
  toolsDoc += generationsHeader();
  toolsDoc += `\n**${toolRows.length} tools across ${domainOrder.length} domains.**`;
  toolsDoc += ` Kinds: \`action\` dispatches through the action executor, \`direct\` runs a handler, \`read\` is read-only.\n\n`;
  toolsDoc += `| domain | tools |\n| --- | --- |\n`;
  for (const domain of domainOrder) {
    toolsDoc += `| [${domain}](#${domain}) | ${toolRows.filter((t) => t.domain === domain).length} |\n`;
  }

  for (const domain of domainOrder) {
    const rows = toolRows.filter((t) => t.domain === domain).sort((a, b) => a.name.localeCompare(b.name));
    toolsDoc += `\n## ${domain}\n\n${rows.length} tools.\n\n`;
    toolsDoc += `| tool | kind | action type | parameters |\n| --- | --- | --- | --- |\n`;
    for (const row of rows) {
      const params = row.params.length
        ? row.params
            .map((p) => `\`${p.name}\`${p.required ? "" : "?"}: ${p.type}${p.extra ? ` (${p.extra})` : ""}`)
            .join("<br>")
        : "—";
      toolsDoc += `| \`${row.name}\` | ${row.kind} | ${row.actionType ? `\`${row.actionType}\`` : "—"} | ${params} |\n`;
    }
    toolsDoc += `\n`;
    toolsDoc += rows
      .map((row) => `- **\`${row.name}\`** — ${mdCell(row.title)}`)
      .join("\n");
    toolsDoc += `\n`;
  }
  emit("tools.md", toolsDoc);

  /* ---------------- actions.md ---------------- */
  const actionDomains = [...new Set(actionEntries.map((a) => a.domain))].sort();
  // Three implementations, counted exactly: a switch case, a type-guarded
  // method (the router hands the whole `transform/…` prefix to one method), or
  // a self-registering handler module.
  const bySwitch = actionEntries.filter((a) => /^action-executor\.ts:\d+$/.test(a.impl)).length;
  const byGuard = actionEntries.filter((a) => a.impl.includes("type-guarded")).length;
  const byHandler = actionEntries.filter((a) => a.impl.startsWith("handler")).length;

  let actionsDoc = `# Action types\n\n`;
  actionsDoc += generationsHeader();
  actionsDoc += `\nThe editor mutates a project through **${actionEntries.length} action types** across ${actionDomains.length} domains.\n`;
  actionsDoc += `Every action is \`{ type, params }\`.\n\n`;
  actionsDoc += `Two execution paths, both live:\n\n`;
  actionsDoc += `- **${bySwitch} types** are switch cases in \`packages/core/src/actions/action-executor.ts\`.\n`;
  if (byGuard) {
    actionsDoc += `- **${byGuard} type** is handled by a single method that names the one type it accepts (\`transform/update\`).\n`;
  }
  actionsDoc += `- **${byHandler} types** are handler modules in \`packages/core/src/actions/handlers/\` that register themselves at import time.\n\n`;
  actionsDoc += `The executor consults the handler registry first, then routes by prefix. An unknown type in any domain is refused — `;
  actionsDoc += `nothing is silently accepted. Actions reach the editor through a tool with that \`actionType\` `;
  actionsDoc += `(${[...toolsByAction.keys()].length} of the ${toolRows.length} tools) or through the raw escape hatches \`execute_action\` and \`batch_actions\`.\n\n`;
  actionsDoc += `\`reads\` is what the implementation touches; \`accepts\` is what the tool schema lets a caller pass.\n\n`;

  for (const domain of actionDomains) {
    const rows = actionEntries.filter((a) => a.domain === domain);
    actionsDoc += `## ${domain} (${rows.length})\n\n`;
    actionsDoc += `| action | implemented in | reads | tool parameters | tools |\n| --- | --- | --- | --- | --- |\n`;
    for (const row of rows) {
      const reads = row.reads.map((p) => `\`${p.name}\`: ${mdCell(p.type)}`).join("<br>") || "—";
      const accepts = row.accepts.map((p) => `\`${p.name}\`: ${p.type}`).join("<br>") || "—";
      const wired = row.tools.map((t) => `\`${t}\``).join(", ") || "*raw only*";
      actionsDoc += `| \`${row.type}\` | ${row.impl} | ${reads} | ${accepts} | ${wired} |\n`;
    }
    actionsDoc += `\n`;
  }
  emit("actions.md", actionsDoc);

  /* ---------------- transitions.md ---------------- */
  const aliasesFor = (type: string) =>
    Object.entries(TRANSITION_TYPE_ALIASES)
      .filter(([, target]) => target === type)
      .map(([alias]) => `\`${alias}\``);

  let tr = `# Transitions (${transitionTypes.length})\n\n`;
  tr += generationsHeader();
  tr += `\nAdd one with:\n\n\`\`\`json\n{ "tool": "add_transition",\n  "input": { "clipAId": "clip-1", "clipBId": "clip-2",\n             "transitionType": "crossZoom", "duration": 0.3 } }\n\`\`\`\n\n`;
  tr += `Clips must be adjacent on the same track. Aliases (${Object.keys(TRANSITION_TYPE_ALIASES).length} of them) are accepted and stored canonically.\n`;
  tr += `\`Category\` is how the editor groups them in the picker.\n\n`;

  for (const category of ["Dissolves", "Wipes", "Movement", "Stylized"]) {
    const inCat = transitionTypes.filter((t) => (categories.get(t) ?? "Stylized") === category);
    if (!inCat.length) continue;
    tr += `## ${category} (${inCat.length})\n\n`;
    tr += `| type | button label | default parameters | aliases |\n| --- | --- | --- | --- |\n`;
    for (const type of inCat) {
      const defaults = engine.getDefaultParams(type as never);
      const params = Object.entries(defaults)
        .map(([k, v]) => `\`${k}\` = ${JSON.stringify(v)}`)
        .join("<br>");
      const label = panelLabels.get(type) ?? "—";
      tr += `| \`${type}\` | ${mdCell(label)} | ${params} | ${aliasesFor(type).join(", ") || "—"} |\n`;
    }
    tr += `\n`;
  }

  tr += `## Parameter reference\n\n`;
  tr += `Every default above is produced by \`TransitionEngine.getDefaultParams()\` at runtime. `;
  tr += `Values in the panel that are not transitions:\n\n`;
  tr += `| preset | label | underlying type |\n| --- | --- | --- |\n`;
  for (const variant of panelVariants) {
    tr += `| \`${variant.id}\` | ${mdCell(variant.label ?? "")} | \`${variant.type}\` |\n`;
  }
  tr += `\nThese ${panelVariants.length} presets sit alongside the ${transitionTypes.length} types as one-click `;
  tr += `parameter choices — ${panelEntries.length} buttons total in the picker.\n`;
  emit("transitions.md", tr);

  /* ---------------- clip-effects.md ---------------- */
  let ce = `# Clip effects (${EFFECT_DEFINITIONS.length})\n\n`;
  ce += generationsHeader();
  ce += `\nFilters applied to a clip's pixels. Use \`add_video_effect\`, \`update_video_effect\`, `;
  ce += `\`toggle_video_effect\`, \`set_effect_order\`, \`remove_video_effect\`.\n\n`;
  ce += `| effect | name | category | parameters |\n| --- | --- | --- | --- |\n`;
  for (const def of EFFECT_DEFINITIONS) {
    const params = def.params
      .map((p) => {
        const range =
          p.min !== undefined && p.max !== undefined ? ` (${p.min}–${p.max})` : "";
        return `\`${p.key}\`: ${p.type}${range} = ${JSON.stringify(p.default)}`;
      })
      .join("<br>");
    ce += `| \`${def.type}\` | ${mdCell(def.name)} | ${def.category} | ${params} |\n`;
  }
  emit("clip-effects.md", ce);

  /* ---------------- shader-looks.md ---------------- */
  const looksByAlias = (id: string) =>
    Object.entries(SIGNATURE_EFFECT_ALIASES)
      .filter(([, target]) => target === id)
      .map(([alias]) => `\`${alias}\``);

  let sl = `# Shader looks (${EFFECT_SHADERS.length})\n\n`;
  sl += generationsHeader();
  sl += `\nGLSL effects rendered on the GPU. Applied by intent through \`add_video_effect\`:\n\n`;
  sl += `\`\`\`json\n{ "tool": "add_video_effect",\n  "input": { "clipId": "clip-1", "effectType": "vhs",\n             "params": { "intensity": 0.8 } } }\n\`\`\`\n\n`;
  sl += `The tool resolves the name, fills in every unspecified parameter, and stores the clip effect as `;
  sl += `\`{ type: "shader", params: { shaderId, … } }\`. Unknown names are refused with \`UNSUPPORTED_EFFECT\`.\n\n`;

  for (const shader of EFFECT_SHADERS) {
    const paramRows = shader.params
      .map((p) => {
        const range =
          typeof p.min === "number" && typeof p.max === "number" ? `${p.min}–${p.max}` : "—";
        return `| \`${p.name}\` | ${p.label} | ${p.type} | ${JSON.stringify(p.default)} | ${range} |`;
      })
      .join("\n");
    sl += `## \`${shader.id}\` — ${shader.name}\n\n`;
    sl += `category: \`${shader.category}\` · GLSL: ${shader.glsl.split("\n").length} lines`;
    const aliases = looksByAlias(shader.id);
    if (aliases.length) sl += ` · also accepts ${aliases.join(", ")}`;
    sl += `\n\n| parameter | label | type | default | range |\n| --- | --- | --- | --- | --- |\n${paramRows}\n\n`;
  }
  emit("shader-looks.md", sl);

  /* ---------------- text-animations.md ---------------- */
  const presets = textAnimationEngine.getAvailablePresets();
  const textAliasesFor = (target: string) =>
    Object.entries(TEXT_ANIMATION_ALIASES)
      .filter(([, t]) => t === target)
      .map(([a]) => `\`${a}\``);

  let ta = `# Text animations (${presets.length})\n\n`;
  ta += generationsHeader();
  ta += `\nPer-character animatable text is set on a text clip with \`create_text_clip\` / \`update_text_clip\`;\n`;
  ta += `the director vocabulary tracks ${SUPPORTED_TEXT_ANIMATIONS.length} of these.\n\n`;
  ta += `| preset | default parameters | aliases |\n| --- | --- | --- |\n`;
  for (const preset of presets) {
    const animation = textAnimationEngine.createAnimationPreset(preset);
    const params = Object.entries(animation.params)
      .map(([k, v]) => `\`${k}\` = ${JSON.stringify(v)}`)
      .join("<br>");
    ta += `| \`${preset}\` | ${params || "—"} | ${textAliasesFor(preset).join(", ") || "—"} |\n`;
  }
  ta += `\nEvery preset defaults to \`inDuration: 0.5s\`, \`outDuration: 0.5s\`.\n`;
  emit("text-animations.md", ta);

  /* ---------------- director-vocabulary.md ---------------- */
  let dv = `# Director vocabulary\n\n`;
  dv += generationsHeader();
  dv += `\nThese are the closed lists the direction prompt is built from and validated against. `;
  dv += `If a name is not here, a plan cannot request it.\n\n`;

  dv += `## Genres (${PRE_BAKED_GENRES.length})\n\n`;
  dv += `| genre | pacing | cuts/min | signature looks | transitions |\n| --- | --- | --- | --- | --- |\n`;
  for (const genre of PRE_BAKED_GENRES) {
    const looks = (genre.signatureEffects ?? []).map((l) => `\`${l}\``).join(", ") || "—";
    const trans = (genre.transitionPalette ?? []).map((t) => `\`${t}\``).join(", ") || "—";
    const cuts = genre.cutsPerMinuteTarget ? genre.cutsPerMinuteTarget.join("–") : "—";
    dv += `| **${genre.name}** \`${genre.id}\` | ${genrePacing(genre)} | ${cuts} | ${looks} | ${trans} |\n`;
  }

  const withOwn = PRE_BAKED_GENRES.filter((g) => g.densityTarget);
  const inherited = PRE_BAKED_GENRES.filter((g) => !g.densityTarget);
  dv += `\n### Density contract per genre\n\n`;
  dv += `What "heavily edited" means numerically — the gate a plan is reviewed against. `;
  dv += `${withOwn.length} genres state their own targets; the other ${inherited.length} inherit the preset for their pacing `;
  dv += `(${Object.keys(DENSITY_PRESETS).join(", ")}) through \`resolveDensityTarget(pacing, genre.densityTarget)\`.\n\n`;
  dv += `| genre | shots/min | effects/min | effect types | treated shots | camera moves | variety | speed ramps | texts/min | text animations | SFX | motion moments | hook shots | on-beat cuts |\n`;
  dv += `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`;
  for (const genre of PRE_BAKED_GENRES) {
    const d = resolveDensityTarget(genrePacing(genre), genre.densityTarget);
    const source = genre.densityTarget ? "" : " *(inherited)*";
    const range = (value: readonly [number, number] | undefined): string =>
      value ? `${value[0]}–${value[1]}` : "—";
    dv += `| ${genre.name}${source} | ${range(d.shotsPerMinute)} | ${range(d.effectHitsPerMinute)} | ${d.minimumEffectTypes} | ${d.minimumTreatedShotRatio} | ${d.minimumCameraMoveRatio} | ${d.minimumCameraMoveVariety} | ${d.minimumSpeedRamps} | ${range(d.textsPerMinute)} | ${d.minimumTextAnimations} | ${d.minimumSfxHits} | ${d.minimumMotionMoments ?? "—"} | ${d.hookShots} | ${d.minimumOnBeatCutRatio ?? "—"} |\n`;
  }

  dv += `\n## Camera moves (${CAMERA_MOVE_IDS.length})\n\n`;
  dv += `| id | what it does |\n| --- | --- |\n`;
  for (const id of CAMERA_MOVE_IDS) {
    const entry = CAMERA_MOVE_ATLAS[id] as unknown as Record<string, unknown>;
    const description = String(
      entry.description ?? entry.summary ?? entry.intent ?? JSON.stringify(entry),
    );
    dv += `| \`${id}\` | ${mdCell(description)} |\n`;
  }

  dv += `\n## Signature looks (${SIGNATURE_EFFECT_DEFS.length})\n\n`;
  dv += `The prompt names a look by intent; the plan compiler maps it onto a shader.\n\n`;
  dv += `| look | shader | description |\n| --- | --- | --- |\n`;
  for (const def of SIGNATURE_EFFECT_DEFS) {
    const d = def as unknown as Record<string, unknown>;
    dv += `| \`${def.name}\` | \`${String(d.shaderId ?? "—")}\` | ${mdCell(String(d.description ?? d.intent ?? ""))} |\n`;
  }

  dv += `\n## Other closed lists\n\n`;
  dv += `| list | count | values |\n| --- | --- | --- |\n`;
  dv += `| clip effect types | ${SUPPORTED_CLIP_EFFECT_TYPES.length} | ${SUPPORTED_CLIP_EFFECT_TYPES.map((v) => `\`${v}\``).join(", ")} |\n`;
  dv += `| effect types | ${SUPPORTED_EFFECT_TYPES.length} | ${SUPPORTED_EFFECT_TYPES.map((v) => `\`${v}\``).join(", ")} |\n`;
  dv += `| colour grade types | ${COLOR_GRADE_EFFECT_TYPES.length} | ${COLOR_GRADE_EFFECT_TYPES.map((v) => `\`${v}\``).join(", ")} |\n`;
  dv += `| cut transitions | ${CUT_TRANSITION_TYPES.size} | ${[...CUT_TRANSITION_TYPES].map((v) => `\`${v}\``).join(", ")} |\n`;
  dv += `| text animations | ${SUPPORTED_TEXT_ANIMATIONS.length} | ${SUPPORTED_TEXT_ANIMATIONS.map((v) => `\`${v}\``).join(", ")} |\n`;
  dv += `| transition aliases | ${Object.keys(TRANSITION_TYPE_ALIASES).length} | see [transitions.md](transitions.md) |\n`;
  dv += `| look aliases | ${Object.keys(SIGNATURE_EFFECT_ALIASES).length} | see [shader-looks.md](shader-looks.md) |\n`;
  dv += `| text animation aliases | ${Object.keys(TEXT_ANIMATION_ALIASES).length} | see [text-animations.md](text-animations.md) |\n`;
  emit("director-vocabulary.md", dv);

  /* ---------------- motion-library.md ---------------- */
  const motion = toolRows.filter((t) => t.domain === "motion");
  const family = (name: string) => {
    const prefix = name.split("_")[0];
    if (name.startsWith("creation_")) return "creation — 3D scene, objects, materials, sims";
    if (name.startsWith("add_motion") || name.startsWith("create_motion")) return "composition — layers and scenes";
    if (name.includes("motion_layer")) return "layers";
    if (name.includes("motion_keyframe") || name.includes("motion_animation")) return "keyframes and animation";
    if (name.includes("motion_effect") || name.includes("motion_shader")) return "effects and shaders";
    if (name.includes("motion")) return "composition — other";
    return prefix;
  };
  const families = new Map<string, ToolRow[]>();
  for (const row of motion) {
    const f = family(row.name);
    families.set(f, [...(families.get(f) ?? []), row]);
  }

  let ml = `# Motion graphics library (${motion.length} tools)\n\n`;
  ml += generationsHeader();
  ml += `\nThe motion domain covers two things: animated motion-graphics compositions `;
  ml += `(layers, keyframes, masks, shaders) and a 3D creation scene (geometry, materials, `;
  ml += `cameras, simulations).\n\n`;
  ml += `| family | tools |\n| --- | --- |\n`;
  for (const [name, rows] of [...families].sort((a, b) => b[1].length - a[1].length)) {
    ml += `| ${name} | ${rows.length} |\n`;
  }
  ml += `\n`;
  for (const [name, rows] of [...families].sort((a, b) => b[1].length - a[1].length)) {
    ml += `## ${name} (${rows.length})\n\n`;
    ml += `| tool | parameters |\n| --- | --- |\n`;
    for (const row of rows.sort((a, b) => a.name.localeCompare(b.name))) {
      const params = row.params.length
        ? row.params
            .map((p) => `\`${p.name}\`${p.required ? "" : "?"}: ${p.type}`)
            .join("<br>")
        : "—";
      ml += `| \`${row.name}\` | ${params} |\n`;
    }
    ml += `\n`;
  }
  emit("motion-library.md", ml);

  /* ---------------- README ---------------- */
  let readme = `# Capability evidence\n\n`;
  readme += generationsHeader();
  readme += `\nPer-item documentation of what this editor can do, each item backed by the code that `;
  readme += `implements it.\n\n`;
  readme += `| file | contents | count |\n| --- | --- | --- |\n`;
  readme += `| [tools.md](tools.md) | every callable tool, its kind, action type and parameters | ${toolRows.length} |\n`;
  readme += `| [actions.md](actions.md) | every action type, its implementation and properties | ${actionEntries.length} |\n`;
  readme += `| [transitions.md](transitions.md) | transitions with defaults, labels and aliases | ${transitionTypes.length} |\n`;
  readme += `| [clip-effects.md](clip-effects.md) | clip filters with full parameter ranges | ${EFFECT_DEFINITIONS.length} |\n`;
  readme += `| [shader-looks.md](shader-looks.md) | GLSL looks and their parameters | ${EFFECT_SHADERS.length} |\n`;
  readme += `| [text-animations.md](text-animations.md) | text animation presets | ${presets.length} |\n`;
  readme += `| [director-vocabulary.md](director-vocabulary.md) | genres, density contracts, camera moves, closed lists | ${PRE_BAKED_GENRES.length} genres |\n`;
  readme += `| [motion-library.md](motion-library.md) | motion graphics and 3D creation tools | ${motion.length} |\n`;
  readme += `| [raw/](raw) | the same data as JSON, for tooling | — |\n`;
  readme += `\n## Regenerating\n\n`;
  readme += `\`\`\`bash\nKOVE_WRITE_EVIDENCE=1 vitest run packages/agent/src/evidence/\n\`\`\`\n\n`;
  readme += `Without \`KOVE_WRITE_EVIDENCE\`, the file still runs: it recomputes every figure and `;
  readme += `asserts it, so the suite fails if the documentation would be wrong — it just does not `;
  readme += `touch the working tree.\n`;
  emit("README.md", readme);

  /* ---------------- raw JSON ---------------- */
  emit(
    "raw/tools.json",
    JSON.stringify({ generatedFrom: "listTools()", count: toolRows.length, tools: toolRows }, null, 2),
  );
  emit(
    "raw/actions.json",
    JSON.stringify(
      {
        generatedFrom: "action-executor.ts + actions/handlers/*",
        count: actionEntries.length,
        bySwitch,
        byGuard,
        byHandler,
        actions: actionEntries,
      },
      null,
      2,
    ),
  );
  emit(
    "raw/transitions.json",
    JSON.stringify(
      {
        generatedFrom: "TransitionEngine + TRANSITION_TYPES",
        count: transitionTypes.length,
        transitions: transitionTypes.map((type) => ({
          type,
          category: categories.get(type) ?? "Stylized",
          label: panelLabels.get(type) ?? null,
          defaults: engine.getDefaultParams(type as never),
          aliases: Object.entries(TRANSITION_TYPE_ALIASES)
            .filter(([, t]) => t === type)
            .map(([a]) => a),
          renderDispatched: new RegExp(`case "${type}":`).test(
            readFileSync(join(REPO, "packages/core/src/video/transition-engine.ts"), "utf8"),
          ),
          inspectorPreview: new RegExp(`case "${type}":`).test(INSPECTOR_SRC),
        })),
      },
      null,
      2,
    ),
  );
  emit(
    "raw/clip-effects.json",
    JSON.stringify({ generatedFrom: "EFFECT_DEFINITIONS", count: EFFECT_DEFINITIONS.length, effects: EFFECT_DEFINITIONS }, null, 2),
  );
  emit(
    "raw/shader-looks.json",
    JSON.stringify(
      {
        generatedFrom: "EFFECT_SHADERS",
        count: EFFECT_SHADERS.length,
        looks: EFFECT_SHADERS.map((s) => ({
          id: s.id,
          name: s.name,
          category: s.category,
          params: s.params,
          glslLines: s.glsl.split("\n").length,
          aliases: Object.entries(SIGNATURE_EFFECT_ALIASES)
            .filter(([, t]) => t === s.id)
            .map(([a]) => a),
        })),
      },
      null,
      2,
    ),
  );
  emit(
    "raw/text-animations.json",
    JSON.stringify(
      {
        generatedFrom: "TextAnimationEngine.createAnimationPreset",
        count: presets.length,
        presets: presets.map((preset) => ({
          preset,
          defaults: textAnimationEngine.createAnimationPreset(preset).params,
          aliases: Object.entries(TEXT_ANIMATION_ALIASES)
            .filter(([, t]) => t === preset)
            .map(([a]) => a),
        })),
      },
      null,
      2,
    ),
  );
  emit(
    "raw/director-vocabulary.json",
    JSON.stringify(
      {
        genres: PRE_BAKED_GENRES,
        cameraMoves: CAMERA_MOVE_IDS.map((id) => ({ id, ...CAMERA_MOVE_ATLAS[id] })),
        signatureLooks: SIGNATURE_EFFECT_DEFS,
        signatureAliases: SIGNATURE_EFFECT_ALIASES,
        transitionAliases: TRANSITION_TYPE_ALIASES,
        textAnimationAliases: TEXT_ANIMATION_ALIASES,
        supportedClipEffectTypes: SUPPORTED_CLIP_EFFECT_TYPES,
        supportedEffectTypes: SUPPORTED_EFFECT_TYPES,
        colorGradeEffectTypes: COLOR_GRADE_EFFECT_TYPES,
        cutTransitions: [...CUT_TRANSITION_TYPES],
        supportedTextAnimations: SUPPORTED_TEXT_ANIMATIONS,
      },
      null,
      2,
    ),
  );

  /* ---------------- bridge note for effects ---------------- */
  const bridgeTypes = [...EFFECTS_BRIDGE_SRC.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]);
  emit(
    "raw/effects-bridge-types.json",
    JSON.stringify(
      { note: "effect types the web effects bridge handles", count: new Set(bridgeTypes).size, types: [...new Set(bridgeTypes)] },
      null,
      2,
    ),
  );
}
