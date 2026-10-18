#!/usr/bin/env node
/**
 * CI gate: fail the build if any VITE_* environment variable NAME suggests a
 * secret. VITE_* variables are inlined into the client bundle by Vite, so a
 * name like "VITE_" + "FOO_API_" + "TOKEN" is a red flag even before anyone
 * sets a value.
 *
 * Rule: any VITE_<NAME> whose NAME matches /KEY|TOKEN|SECRET|PASSWORD/i fails.
 * (Public-by-design identifiers — e.g. the PostHog project key — are renamed,
 * not exempted: the gate stays a simple, auditable rule.)
 *
 * Usage: node scripts/check-vite-secrets.mjs [root]
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD/i;
const VITE_NAME = /\bVITE_([A-Z0-9_]+)/g;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".wrangler",
]);

/**
 * File extensions we scan: code + config + env examples — i.e. anything that
 * can be inlined into the client bundle by a bundler. Prose (.md) is
 * deliberately excluded: docs may reference a variable name, but a markdown
 * file is never bundled, so it cannot leak a value.
 */
const SCAN_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json",
  ".html", ".yml", ".yaml", ".toml",
]);

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
      if (!SKIP_DIRS.has(entry.name)) yield* walk(full);
      continue;
    }
    const ext = path.extname(entry.name);
    const scannable =
      entry.name.startsWith(".env") || SCAN_EXTS.has(ext);
    if (!scannable) continue;
    if (!statSync(full).isFile()) continue;
    yield full;
  }
}

/**
 * Returns [{ file, line, name }] for every VITE_* reference whose name looks
 * like a secret. Exported for tests.
 */
export function findSecretViteNames(root) {
  const hits = [];
  for (const file of walk(root)) {
    let text;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue; // binary
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.includes("VITE_")) continue;
      let match;
      VITE_NAME.lastIndex = 0;
      while ((match = VITE_NAME.exec(line)) !== null) {
        const name = match[1];
        if (SECRET_NAME.test(name)) {
          hits.push({ file: path.relative(root, file), line: i + 1, name: `VITE_${name}` });
        }
      }
    }
  }
  return hits;
}

function main() {
  const root = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if (!existsSync(root)) {
    console.error(`[check-vite-secrets] root not found: ${root}`);
    process.exit(2);
  }
  const hits = findSecretViteNames(root);
  if (hits.length > 0) {
    console.error("[check-vite-secrets] FAILED — VITE_* names that look like secrets:");
    for (const hit of hits) {
      console.error(`  ${hit.file}:${hit.line}  ${hit.name}`);
    }
    console.error(
      "\nVITE_* values are inlined into the client bundle. Provider credentials must live " +
      "server-side (Pages secrets / dev proxy / Electron main env). If the value is " +
      "public by design (e.g. the PostHog project key), rename the variable so the name " +
      "no longer suggests a secret — do not add exceptions to the gate.",
    );
    process.exit(1);
  }
  console.log("[check-vite-secrets] OK — no secret-looking VITE_* names");
}

// Run main only when executed directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
