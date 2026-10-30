import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { OmniRouteConfig } from "./omniroute";
import type { WorkersAIConfig } from "./workers-ai";

/** Parses KEY=VALUE lines; quotes and comments are tolerated. */
export function parseDevVars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Nearest `.dev.vars` at or above `startDir`, or null when none exists. */
function findDevVarsUpward(startDir: string): string | null {
  let directory = resolve(startDir);
  for (;;) {
    const candidate = resolve(directory, ".dev.vars");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/**
 * Reads `.dev.vars`. An explicit `repoRoot` is used verbatim (callers like the
 * eval harness pin the repo root); `undefined` walks up from the cwd so the
 * headless CLI finds the repo's vars from any subdirectory.
 */
function readDevVars(repoRoot?: string): Record<string, string> {
  const file =
    repoRoot !== undefined ? resolve(repoRoot, ".dev.vars") : findDevVarsUpward(process.cwd());
  if (!file || !existsSync(file)) return {};
  return parseDevVars(readFileSync(file, "utf8"));
}

/**
 * Credential precedence: eval-scoped `<envPrefix>OMNIROUTE_*` (lets a second
 * gateway/exported key be set without disturbing the app's credentials) →
 * generic `OMNIROUTE_*` env → the repo's `.dev.vars`.
 *
 * The gateway key must be paired with a pinned model — `auto` can switch
 * models mid-run, which corrupts any comparison or resumed session.
 */
export function loadOmniRouteConfig(
  repoRoot?: string,
  envPrefix = "",
): OmniRouteConfig | null {
  const vars = readDevVars(repoRoot);
  const pick = (name: string): string =>
    process.env[`${envPrefix}${name}`] || process.env[name] || vars[name] || "";
  const baseUrl = pick("OMNIROUTE_BASE_URL") || "http://localhost:20128/v1";
  const apiKey = pick("OMNIROUTE_KEY");
  const model = pick("OMNIROUTE_MODEL");
  if (!apiKey || !model) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
}

/**
 * Credential precedence mirrors `loadOmniRouteConfig`: `<envPrefix>CLOUDFLARE_*`
 * → `CLOUDFLARE_*` → `.dev.vars`. Token and account id must come from the same
 * Cloudflare account or requests 403.
 */
export function loadWorkersAIConfig(
  repoRoot?: string,
  envPrefix = "",
): WorkersAIConfig | null {
  const vars = readDevVars(repoRoot);
  const pick = (name: string): string =>
    process.env[`${envPrefix}${name}`] || process.env[name] || vars[name] || "";
  const accountId = pick("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = pick("CLOUDFLARE_API_TOKEN");
  const model = pick("CLOUDFLARE_AI_MODEL") || "@cf/google/gemma-4-26b-a4b-it";
  if (!accountId || !apiToken) return null;
  return { accountId, apiToken, model };
}
