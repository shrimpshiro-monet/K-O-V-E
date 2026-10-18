#!/usr/bin/env node
/**
 * CI gate: fail the build if the compiled client bundle contains anything
 * that looks like a live credential — or the provider URL it must never call
 * directly.
 *
 * Checks (any hit = failure):
 *  - known provider key shapes (Anthropic / OpenAI / AWS / Google / Slack /
 *    GitHub) and 3-part JWTs,
 *  - a literal `Bearer <token>` value (template `Bearer ${...}` is fine),
 *  - `api.cloudflare.com` — the web client is allowed to reach the provider
 *    ONLY through the same-origin /api/llm gateway,
 *  - references to VITE_* env names that look like secrets (residual client
 *    credential plumbing).
 *
 * Deliberate non-check: PostHog project keys (phc_…) are public by design.
 *
 * Usage: node scripts/check-bundle-secrets.mjs [bundleDir]   (default apps/web/dist)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Patterns paired with a human label. All are chosen to be near-zero-false-
 * positive on application code (long random alphanumerics after a
 * distinctive prefix).
 */
const CREDENTIAL_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{16,}/g, "Anthropic API key"],
  // No hyphens: contiguous alphanumerics only — CSS class names (sk-...) stay
  // out of scope, while real keys (sk-<48 chars>) are caught.
  [/sk-[A-Za-z0-9]{28,}/g, "OpenAI-style API key"],
  // Project-scoped OpenAI keys (sk-proj-<40 alphanumerics>).
  [/sk-proj-[A-Za-z0-9]{28,}/g, "OpenAI project API key"],
  [/AKIA[0-9A-Z]{16}/g, "AWS access key id"],
  [/AIza[0-9A-Za-z_-]{30,}/g, "Google API key"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "Slack token"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, "GitHub token"],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "JWT"],
  // Template interpolation (Bearer ${token}) is allowed; a literal token is not.
  [/Bearer\s+(?!\$\{)[A-Za-z0-9._~+/-]{24,}/g, "literal Bearer token"],
  [/api\.cloudflare\.com/g, "direct Cloudflare API host"],
  // VITE_ env references whose NAME suggests a secret (e.g. VITE_*_API_KEY).
  [/import\.meta\.env\.VITE_[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*/gi, "secret-looking VITE_ env reference"],
];

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      yield* walk(full);
      continue;
    }
    if (!statSync(full).isFile()) continue;
    yield full;
  }
}

/**
 * Returns [{ file, line, kind, match }] for credential-looking content.
 * Exported for tests.
 */
export function scanBundleDir(bundleDir) {
  const hits = [];
  for (const file of walk(bundleDir)) {
    let text;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue; // binary asset
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      for (const [pattern, kind] of CREDENTIAL_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(line)) !== null) {
          const snippet = match[0];
          // Never echo the secret itself into CI logs.
          const redacted =
            snippet.length > 24 ? `${snippet.slice(0, 12)}…[redacted]` : snippet;
          hits.push({ file: path.relative(bundleDir, file), line: i + 1, kind, match: redacted });
          if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
        }
      }
    }
  }
  return hits;
}

function main() {
  const defaultDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../apps/web/dist");
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : defaultDir;
  let hits;
  try {
    hits = scanBundleDir(dir);
  } catch {
    console.error(`[check-bundle-secrets] bundle dir not found: ${dir} (run the build first)`);
    process.exit(2);
  }
  if (hits.length > 0) {
    console.error(`[check-bundle-secrets] FAILED — ${hits.length} credential-like hit(s):`);
    for (const hit of hits) {
      console.error(`  ${hit.file}:${hit.line}  ${hit.kind}: ${hit.match}`);
    }
    process.exit(1);
  }
  console.log("[check-bundle-secrets] OK — bundle is credential-free");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
