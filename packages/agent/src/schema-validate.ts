import type { JSONSchema, ToolResult } from "./types";

/**
 * Tool-argument schema validation, rolled out in stages:
 *
 *   1. SHADOW (default for existing tools): validate, record mismatches, never
 *      change the arguments and never reject. Read the log with
 *      `getSchemaMismatches()` to see which tools lie about their schema.
 *   2. Fix the mismatches the shadow log (and `schema-conformance.test.ts`) surface.
 *   3. ENFORCE per tool (`KOVE_SCHEMA_ENFORCE=tool_a,tool_b` or
 *      `setSchemaPolicy({ enforceTools })`), or globally (`KOVE_SCHEMA_MODE=enforce`).
 *
 * Tools marked `strict: true` (every tool added after the legacy snapshot) are
 * enforced from day one. Handler-level checks stay in place as defense in depth.
 *
 * ## Coercion policy (enforce / strict only; shadow never rewrites arguments)
 * Only lossless, unambiguous repairs are applied, each reported as a warning:
 *   - decimal string → number/integer:  "5" → 5, "-0.25" → -0.25   ("", "0x10", "1e3", " 5" are NOT coerced)
 *   - "true" / "false" → boolean
 *   - null for an optional property → treated as absent
 * Never coerced: number → string, anything → array/object, a fractional number
 * for an integer (no silent rounding), out-of-range values (no clamping).
 *
 * ## Unknown-key policy
 * A key is unknown when the object schema declares `properties` and the key is
 * not among them, or when the schema says `additionalProperties: false`. Legacy tools (enforced individually): strip and warn. Strict
 * tools: reject, with a did-you-mean suggestion. An object schema with no
 * declared properties is free-form and never has unknown keys.
 */

export type SchemaMode = "off" | "shadow" | "enforce";

export type SchemaIssueCode =
  | "type"
  | "required"
  | "enum"
  | "minimum"
  | "maximum"
  | "minItems"
  | "maxItems"
  | "unknown_key"
  | "coerced"
  | "null_dropped";

export interface SchemaIssue {
  readonly path: string;
  readonly code: SchemaIssueCode;
  readonly message: string;
  readonly expected?: unknown;
  readonly received?: unknown;
}

export interface ValidateOptions {
  /** Extra root-level properties that are always allowed (reference keys). */
  readonly implicitRootProperties?: Readonly<Record<string, JSONSchema>>;
  /** Apply the lossless coercions above. */
  readonly coerce: boolean;
  /** What to do with keys the schema does not declare. */
  readonly unknownKeys: "keep" | "strip" | "reject";
}

export interface ValidateResult {
  /** Coerced/stripped value (same reference as the input when nothing changed). */
  readonly value: unknown;
  /** Blocking problems. */
  readonly errors: SchemaIssue[];
  /** Non-blocking repairs that were applied (coercions, stripped keys). */
  readonly notices: SchemaIssue[];
  /** Problems that would be errors/notices but were only observed (keep mode). */
  readonly observed: SchemaIssue[];
}

/** Keywords this validator understands. A schema using any other one fails the conformance test. */
export const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "description",
  "default",
  "title",
  "deprecated",
]);

const DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Clip/track reference helpers the executor resolves into a clipId BEFORE the
 * handler runs (see executor.ts resolveRefs). They are valid on every tool.
 */
export const IMPLICIT_REFERENCE_KEYS: Readonly<Record<string, JSONSchema>> = {
  clipIndex: { type: "number" },
  atSec: { type: "number" },
  trackIndex: { type: "number" },
};

const describe = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return `string ${JSON.stringify(value.length > 40 ? `${value.slice(0, 37)}...` : value)}`;
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return typeof value === "number" || typeof value === "boolean" ? `${typeof value} ${String(value)}` : typeof value;
};

const join = (parent: string, key: string | number): string =>
  typeof key === "number" ? `${parent}[${key}]` : parent ? `${parent}.${key}` : key;

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

function tryCoerce(type: string, value: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof value === "string") {
    if ((type === "number" || type === "integer") && DECIMAL.test(value)) {
      const n = Number(value);
      if (Number.isFinite(n) && (type === "number" || Number.isInteger(n))) return { ok: true, value: n };
    }
    if (type === "boolean" && (value === "true" || value === "false")) return { ok: true, value: value === "true" };
  }
  return { ok: false };
}

/** Closest declared key within edit distance 2, for "did you mean". */
export function closestKey(key: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  const a = key.toLowerCase();
  for (const candidate of candidates) {
    const b = candidate.toLowerCase();
    if (Math.abs(a.length - b.length) > 2) continue;
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0]!;
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cur = row[j]!;
        row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
      }
    }
    const distance = row[b.length]!;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

export function validateValue(schema: JSONSchema, value: unknown, options: ValidateOptions): ValidateResult {
  const errors: SchemaIssue[] = [];
  const notices: SchemaIssue[] = [];
  const observed: SchemaIssue[] = [];
  const out = visit(schema, value, "", options, errors, notices, observed);
  return { value: out, errors, notices, observed };
}

function visit(
  schema: JSONSchema,
  value: unknown,
  path: string,
  options: ValidateOptions,
  errors: SchemaIssue[],
  notices: SchemaIssue[],
  observed: SchemaIssue[],
): unknown {
  const type = typeof schema.type === "string" ? schema.type : undefined;
  let current = value;

  if (type && !typeMatches(type, current)) {
    const coerced = tryCoerce(type, current);
    if (coerced.ok && options.coerce) {
      notices.push({
        path,
        code: "coerced",
        message: `${path || "value"}: coerced ${describe(current)} to ${type} ${String(coerced.value)}`,
        expected: type,
        received: current,
      });
      current = coerced.value;
    } else {
      const issue: SchemaIssue = {
        path,
        code: "type",
        message: `${path || "value"}: expected ${type}, got ${describe(current)}`,
        expected: type,
        received: current,
      };
      // keep-mode callers (shadow) only observe; others block.
      (options.coerce || options.unknownKeys !== "keep" ? errors : observed).push(issue);
      return current;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(current)) {
    const issue: SchemaIssue = {
      path,
      code: "enum",
      message: `${path || "value"}: ${describe(current)} is not one of ${(schema.enum as unknown[]).map((v) => JSON.stringify(v)).join(", ")}`,
      expected: schema.enum,
      received: current,
    };
    (isShadow(options) ? observed : errors).push(issue);
  }

  if (typeof current === "number") {
    if (typeof schema.minimum === "number" && current < schema.minimum) {
      const issue: SchemaIssue = { path, code: "minimum", message: `${path || "value"}: ${current} is below the minimum ${schema.minimum}`, expected: schema.minimum, received: current };
      (isShadow(options) ? observed : errors).push(issue);
    }
    if (typeof schema.maximum === "number" && current > schema.maximum) {
      const issue: SchemaIssue = { path, code: "maximum", message: `${path || "value"}: ${current} is above the maximum ${schema.maximum}`, expected: schema.maximum, received: current };
      (isShadow(options) ? observed : errors).push(issue);
    }
  }

  if (Array.isArray(current)) {
    if (typeof schema.minItems === "number" && current.length < schema.minItems) {
      const issue: SchemaIssue = { path, code: "minItems", message: `${path || "value"}: needs at least ${schema.minItems} items, got ${current.length}`, expected: schema.minItems, received: current.length };
      (isShadow(options) ? observed : errors).push(issue);
    }
    if (typeof schema.maxItems === "number" && current.length > schema.maxItems) {
      const issue: SchemaIssue = { path, code: "maxItems", message: `${path || "value"}: at most ${schema.maxItems} items allowed, got ${current.length}`, expected: schema.maxItems, received: current.length };
      (isShadow(options) ? observed : errors).push(issue);
    }
    const items = schema.items;
    if (items && typeof items === "object" && !Array.isArray(items)) {
      let next: unknown[] | undefined;
      const source: unknown[] = current;
      source.forEach((element, index) => {
        const visited = visit(items as JSONSchema, element, join(path, index), options, errors, notices, observed);
        if (visited !== element) {
          next ??= source.slice();
          next[index] = visited;
        }
      });
      if (next) current = next;
    }
    return current;
  }

  if (type === "object" && typeof current === "object" && current !== null) {
    const record = current as Record<string, unknown>;
    const ownProperties = (schema.properties ?? {}) as Record<string, JSONSchema>;
    const properties = path === "" && options.implicitRootProperties
      ? { ...options.implicitRootProperties, ...ownProperties }
      : ownProperties;
    const declared = Object.keys(ownProperties);
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    let next: Record<string, unknown> | undefined;
    const edit = (): Record<string, unknown> => (next ??= { ...record });

    for (const key of required) {
      if (record[key] === undefined || record[key] === null) {
        const issue: SchemaIssue = {
          path: join(path, key),
          code: "required",
          message: `${join(path, key)}: required property is missing`,
          expected: properties[key]?.type ?? "value",
        };
        (isShadow(options) ? observed : errors).push(issue);
      }
    }

    for (const [key, v] of Object.entries(record)) {
      const propSchema = properties[key];
      if (!propSchema) {
        if (declared.length > 0 || schema.additionalProperties === false) {
          const hint = closestKey(key, declared);
          const issue: SchemaIssue = {
            path: join(path, key),
            code: "unknown_key",
            message: `${join(path, key)}: unknown property${hint ? ` (did you mean '${hint}'?)` : ""}`,
            expected: declared,
            received: key,
          };
          if (options.unknownKeys === "reject") errors.push(issue);
          else if (options.unknownKeys === "strip") {
            notices.push({ ...issue, message: `${issue.message} — ignored` });
            delete edit()[key];
          } else observed.push(issue);
        }
        continue;
      }
      if (v === null && !required.includes(key)) {
        if (options.coerce) {
          notices.push({ path: join(path, key), code: "null_dropped", message: `${join(path, key)}: null treated as absent` });
          delete edit()[key];
        } else {
          observed.push({ path: join(path, key), code: "type", message: `${join(path, key)}: expected ${String(propSchema.type ?? "value")}, got null`, expected: propSchema.type, received: null });
        }
        continue;
      }
      const visited = visit(propSchema, v, join(path, key), options, errors, notices, observed);
      if (visited !== v) edit()[key] = visited;
    }
    if (next) current = next;
  }
  return current;
}

const isShadow = (options: ValidateOptions): boolean => !options.coerce && options.unknownKeys === "keep";

// ---- policy -----------------------------------------------------------------

export interface SchemaPolicy {
  mode: SchemaMode;
  /** Legacy tools enforced individually (strip unknown keys + coerce). */
  enforceTools: Set<string>;
}

const env = (name: string): string | undefined =>
  typeof process !== "undefined" ? process.env?.[name] : undefined;

function initialPolicy(): SchemaPolicy {
  const raw = env("KOVE_SCHEMA_MODE");
  const mode: SchemaMode = raw === "off" || raw === "enforce" ? raw : "shadow";
  const list = (env("KOVE_SCHEMA_ENFORCE") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return { mode, enforceTools: new Set(list) };
}

let policy: SchemaPolicy = initialPolicy();

export function getSchemaPolicy(): Readonly<SchemaPolicy> {
  return policy;
}

export function setSchemaPolicy(next: Partial<{ mode: SchemaMode; enforceTools: Iterable<string> }>): void {
  policy = {
    mode: next.mode ?? policy.mode,
    enforceTools: next.enforceTools ? new Set(next.enforceTools) : policy.enforceTools,
  };
}

// ---- mismatch log (shadow mode output) -----------------------------------------

export interface SchemaMismatchEntry {
  readonly tool: string;
  readonly path: string;
  readonly code: SchemaIssueCode;
  count: number;
  /** First message seen, as a human-readable example. */
  readonly example: string;
}

const MAX_LOG_KEYS = 1000;
const mismatchLog = new Map<string, SchemaMismatchEntry>();
let sink: ((entry: SchemaMismatchEntry, tool: string) => void) | undefined;

/** Optional hook, called once per new (tool, path, code) key. The app can route it to its logger. */
export function setSchemaMismatchSink(fn: typeof sink): void {
  sink = fn;
}

export function getSchemaMismatches(): SchemaMismatchEntry[] {
  return [...mismatchLog.values()].sort((a, b) => b.count - a.count);
}

export function resetSchemaMismatches(): void {
  mismatchLog.clear();
}

function record(tool: string, issues: readonly SchemaIssue[]): void {
  for (const issue of issues) {
    // Array indices are noise for aggregation.
    const path = issue.path.replace(/\[\d+\]/g, "[]");
    const key = `${tool}|${path}|${issue.code}`;
    const existing = mismatchLog.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    if (mismatchLog.size >= MAX_LOG_KEYS) continue;
    const entry: SchemaMismatchEntry = { tool, path, code: issue.code, count: 1, example: issue.message };
    mismatchLog.set(key, entry);
    sink?.(entry, tool);
  }
}

// ---- gate used by the executor ----------------------------------------------------

export interface GateTool {
  readonly name: string;
  readonly inputSchema: JSONSchema;
  readonly strict?: boolean;
  readonly freeform?: boolean;
}

export interface GateOutcome {
  readonly args: Record<string, unknown>;
  readonly warnings: string[];
  readonly rejection?: ToolResult;
  readonly mode: SchemaMode | "strict";
}

const implicitRootProperties = IMPLICIT_REFERENCE_KEYS;
const SHADOW: ValidateOptions = { coerce: false, unknownKeys: "keep", implicitRootProperties };
const ENFORCE_LEGACY: ValidateOptions = { coerce: true, unknownKeys: "strip", implicitRootProperties };
const ENFORCE_STRICT: ValidateOptions = { coerce: true, unknownKeys: "reject", implicitRootProperties };
const ENFORCE_FREEFORM: ValidateOptions = { coerce: true, unknownKeys: "keep", implicitRootProperties };

function suggestedFix(errors: readonly SchemaIssue[], schema: JSONSchema): string {
  const first = errors[0]!;
  const properties = (schema.properties ?? {}) as Record<string, JSONSchema>;
  switch (first.code) {
    case "required":
      return `Provide '${first.path}' (${String(first.expected ?? "value")}).`;
    case "type":
      return `Pass '${first.path || "the value"}' as a ${String(first.expected)}.`;
    case "enum":
      return `Use one of: ${(first.expected as unknown[]).map((v) => JSON.stringify(v)).join(", ")}.`;
    case "minimum":
    case "maximum":
      return `Keep '${first.path}' ${first.code === "minimum" ? "≥" : "≤"} ${String(first.expected)}.`;
    case "minItems":
    case "maxItems":
      return `'${first.path}' must have ${first.code === "minItems" ? "at least" : "at most"} ${String(first.expected)} items.`;
    case "unknown_key": {
      const known = Object.keys(properties);
      const hint = closestKey(String(first.received), known);
      if (known.length === 0) return `Remove '${String(first.received)}': this tool takes no arguments.`;
      return hint
        ? `Rename '${String(first.received)}' to '${hint}', or remove it.`
        : `Remove '${String(first.received)}'. Accepted properties: ${known.slice(0, 12).join(", ")}${known.length > 12 ? ", …" : ""}.`;
    }
    default:
      return "Check the tool's inputSchema and retry.";
  }
}

export function gateToolArgs(tool: GateTool, args: Record<string, unknown>): GateOutcome {
  const enforced = tool.strict === true || policy.mode === "enforce" || policy.enforceTools.has(tool.name);
  if (!enforced) {
    if (policy.mode === "off") return { args, warnings: [], mode: "off" };
    const result = validateValue(tool.inputSchema, args, SHADOW);
    record(tool.name, [...result.errors, ...result.observed]);
    return { args, warnings: [], mode: "shadow" };
  }

  const result = validateValue(
    tool.inputSchema,
    args,
    tool.strict ? ENFORCE_STRICT : tool.freeform ? ENFORCE_FREEFORM : ENFORCE_LEGACY,
  );
  if (result.errors.length > 0) {
    const shown = result.errors.slice(0, 5).map((e) => e.message);
    const more = result.errors.length > 5 ? ` (+${result.errors.length - 5} more)` : "";
    const message = `Invalid arguments for ${tool.name}: ${shown.join("; ")}${more}`;
    return {
      args,
      warnings: [],
      mode: tool.strict ? "strict" : "enforce",
      rejection: {
        ok: false,
        summary: message,
        error: { code: "INVALID_PARAMS", message, suggestedFix: suggestedFix(result.errors, tool.inputSchema) },
      },
    };
  }
  return {
    args: result.value as Record<string, unknown>,
    warnings: result.notices.map((n) => n.message),
    mode: tool.strict ? "strict" : "enforce",
  };
}

/** Schemas using a keyword this validator ignores would silently under-validate. */
export function unsupportedKeywords(schema: unknown, path = ""): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const found: string[] = [];
  const s = schema as Record<string, unknown>;
  for (const key of Object.keys(s)) {
    if (!SUPPORTED_KEYWORDS.has(key)) found.push(`${path || "<root>"}.${key}`);
  }
  for (const [name, sub] of Object.entries((s.properties ?? {}) as Record<string, unknown>)) {
    found.push(...unsupportedKeywords(sub, join(path, name)));
  }
  if (s.items) found.push(...unsupportedKeywords(s.items, `${path}[]`));
  return found;
}
