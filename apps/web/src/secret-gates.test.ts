/**
 * Self-tests for the CI secret gates (scripts/check-vite-secrets.mjs and
 * scripts/check-bundle-secrets.mjs).
 *
 * Acceptance (PR1): CI MUST fail on a planted secret-looking VITE_ name in
 * source (e.g. "VITE_" + "FOO_API_" + "KEY"), and the production bundle must
 * be credential-free. We verify both the exported scan functions and the CLI
 * exit codes CI actually uses.
 *
 * The gate scans SOURCE TEXT, so every planted name below is assembled at
 * runtime from two parts — otherwise this very file would trip the gate.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { findSecretViteNames } from "../../../scripts/check-vite-secrets.mjs";
import { scanBundleDir } from "../../../scripts/check-bundle-secrets.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const VITE_GATE = path.join(REPO_ROOT, "scripts", "check-vite-secrets.mjs");
const BUNDLE_GATE = path.join(REPO_ROOT, "scripts", "check-bundle-secrets.mjs");

// Names under test (split so the gate does not see contiguous literals here):
//   VITE_FOO_API_<KEY>, VITE_CLOUDFLARE_API_<TOKEN>, VITE_STRIPE_<SECRET>,
//   VITE_DB_<PASSWORD>, VITE_PUBLIC_API_<TOKEN>
const N_FOO_KEY = ["VITE_FOO_API_", "KEY"].join("");
const N_CF_TOKEN = ["VITE_CLOUDFLARE_API_", "TOKEN"].join("");
const N_STRIPE_SECRET = ["VITE_STRIPE_", "SECRET"].join("");
const N_DB_PASSWORD = ["VITE_DB_", "PASSWORD"].join("");
const N_PUBLIC_TOKEN = ["VITE_PUBLIC_API_", "TOKEN"].join("");

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function runNode(
  script: string,
  args: string[],
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile("node", [script, ...args], (error, stdout, stderr) => {
      // For non-zero exits, Node sets error.code to the numeric exit code.
      const raw = error ? (error as { code?: number | string }).code : 0;
      resolve({
        code: typeof raw === "number" ? raw : 1,
        out: stdout,
        err: stderr,
      });
    });
  });
}

describe("check-vite-secrets (source gate)", () => {
  it("passes on public-by-design VITE_ names", () => {
    const dir = makeTempDir("kove-vite-clean-");
    writeFileSync(
      path.join(dir, "app.ts"),
      [
        "const id = import.meta.env.VITE_POSTHOG_CLIENT_ID;",
        "const host = import.meta.env.VITE_PUBLIC_POSTHOG_HOST;",
        "const feature = import.meta.env.VITE_ENABLE_LAB;",
        "const page = import.meta.env.VITE_PAGE_TITLE;",
        "",
      ].join("\n"),
    );
    expect(findSecretViteNames(dir)).toEqual([]);
  });

  it("flags any secret-looking VITE_ name (KEY|TOKEN|SECRET|PASSWORD)", () => {
    const dir = makeTempDir("kove-vite-dirty-");
    writeFileSync(
      path.join(dir, "app.ts"),
      [
        `const a = import.meta.env.${N_FOO_KEY};`,
        `const b = process.env.${N_CF_TOKEN};`,
        `const c = import.meta.env.${N_STRIPE_SECRET};`,
        `const d = import.meta.env.${N_DB_PASSWORD};`,
        `const e = import.meta.env.${N_PUBLIC_TOKEN};`,
        "",
      ].join("\n"),
    );
    const hits = findSecretViteNames(dir);
    const names = hits.map((h) => h.name).sort();
    expect(names).toEqual(
      [N_CF_TOKEN, N_DB_PASSWORD, N_FOO_KEY, N_PUBLIC_TOKEN, N_STRIPE_SECRET].sort(),
    );
  });

  it("does not flag prose in .md docs (markdown is never bundled)", () => {
    const dir = makeTempDir("kove-vite-md-");
    writeFileSync(
      path.join(dir, "DOC.md"),
      `The old name was ${N_FOO_KEY}; rotate it and do not reuse.\n`,
    );
    expect(findSecretViteNames(dir)).toEqual([]);
  });

  it("does not flag non-VITE provider names (server-side secrets are fine in code)", () => {
    const dir = makeTempDir("kove-vite-serverside-");
    writeFileSync(
      path.join(dir, "function.ts"),
      [
        "const token = env.CLOUDFLARE_API_TOKEN;",
        "const key = env.STRM_SECRET;",
        "",
      ].join("\n"),
    );
    expect(findSecretViteNames(dir)).toEqual([]);
  });

  it("CLI exits 1 on a planted secret-looking name and 0 on a clean tree", async () => {
    const dirty = makeTempDir("kove-vite-cli-dirty-");
    writeFileSync(
      path.join(dirty, "x.ts"),
      `const k = import.meta.env.${N_FOO_KEY};\n`,
    );
    const fail = await runNode(VITE_GATE, [dirty]);
    expect(fail.code).toBe(1);
    expect(fail.err).toContain(N_FOO_KEY);

    const clean = makeTempDir("kove-vite-cli-clean-");
    writeFileSync(
      path.join(clean, "x.ts"),
      "const k = import.meta.env.VITE_POSTHOG_CLIENT_ID;\n",
    );
    const pass = await runNode(VITE_GATE, [clean]);
    expect(pass.code).toBe(0);
    expect(pass.out).toContain("OK");
  });
});

describe("check-bundle-secrets (bundle gate)", () => {
  it("passes on application code and public-by-design PostHog keys", () => {
    const dir = makeTempDir("kove-bundle-clean-");
    writeFileSync(
      path.join(dir, "index.js"),
      [
        'var posthog = { apiKey: "phc_00000000000000000000000000000000000000000", host: "us.posthog.com" };',
        'console.log("ready", posthog.apiKey);',
        "",
      ].join("\n"),
    );
    expect(scanBundleDir(dir)).toEqual([]);
  });

  it("flags known provider key shapes", () => {
    const dir = makeTempDir("kove-bundle-dirty-");
    writeFileSync(
      path.join(dir, "leak.js"),
      [
        'var a = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345";',
        'var b = "sk-abcdefghijklmnopqrstuvwxyz0123456789";',
        'var c = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";',
        'var d = "AKIAABCDEFGHIJKLMNOP";',
        'var e = "AIzaSyAabcdefghijklmnopqrstuvwxyz0123456789";',
        'var f = "xoxb-1234567890abcdef";',
        'var g = "ghp_abcdefghijklmnopqrstuvwxyz012345";',
        'var h = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5";',
        "",
      ].join("\n"),
    );
    const kinds = scanBundleDir(dir).map((h) => h.kind).sort();
    expect(kinds).toEqual(
      [
        "AWS access key id",
        "Anthropic API key",
        "GitHub token",
        "Google API key",
        "JWT",
        "OpenAI project API key",
        "OpenAI-style API key",
        "Slack token",
      ].sort(),
    );
  });

  it("flags a literal Bearer token but not a template interpolation", () => {
    const dir = makeTempDir("kove-bundle-bearer-");
    writeFileSync(
      path.join(dir, "a.js"),
      'var h = { Authorization: "Bearer abcdefghijklmnopqrstuvwxyz0123456789" };\n',
    );
    expect(scanBundleDir(dir).map((h) => h.kind)).toEqual(["literal Bearer token"]);

    const dir2 = makeTempDir("kove-bundle-bearer-tpl-");
    writeFileSync(
      path.join(dir2, "b.js"),
      "var h = { Authorization: `Bearer ${token}` };\n",
    );
    expect(scanBundleDir(dir2)).toEqual([]);
  });

  it("flags the direct Cloudflare API host (client must use /api/llm only)", () => {
    const dir = makeTempDir("kove-bundle-cf-");
    writeFileSync(
      path.join(dir, "c.js"),
        'var u = "https://api.cloudflare.com/client/v4/accounts/x/ai/v1/chat/completions";\n',
    );
    const hits = scanBundleDir(dir);
    expect(hits.map((h) => h.kind)).toEqual(["direct Cloudflare API host"]);
  });

  it("CLI exits 1 on a planted key in the bundle and 0 on a clean bundle", async () => {
    const dirty = makeTempDir("kove-bundle-cli-dirty-");
    writeFileSync(
      path.join(dirty, "leak.js"),
      'var a = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345";\n',
    );
    const fail = await runNode(BUNDLE_GATE, [dirty]);
    expect(fail.code).toBe(1);
    expect(fail.err).toContain("Anthropic API key");
    // The redaction keeps the secret out of CI logs.
    expect(fail.err).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345");

    const clean = makeTempDir("kove-bundle-cli-clean-");
    mkdirSync(path.join(clean, "assets"), { recursive: true });
    writeFileSync(path.join(clean, "assets", "index.js"), 'console.log("ok");\n');
    const pass = await runNode(BUNDLE_GATE, [clean]);
    expect(pass.code).toBe(0);
    expect(pass.out).toContain("OK");
  });
});
