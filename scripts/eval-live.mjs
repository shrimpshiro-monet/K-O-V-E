#!/usr/bin/env node
/**
 * eval:live — OWNER-RUN live smoke of the §2 server-side LLM gateway.
 *
 * The sandbox cannot reach live Clerk/Supabase/Workers AI, so this command is
 * run by the owner against a DEPLOYED gateway (production or preview). It
 * verifies the §2 acceptance properties end-to-end and writes ONLY compact
 * JSON/MD summaries to evaluation-files/ (no media, no secrets, no prompt
 * content beyond the fixed probe below).
 *
 * Usage:
 *   pnpm eval:live --token "<clerk session JWT>"
 *   pnpm eval:live --token "<jwt>" --gateway https://kove-advanced-preview.pages.dev/api/llm --model <id>
 *
 * Env alternatives: KOVE_GATEWAY_TOKEN, KOVE_GATEWAY_URL, KOVE_GATEWAY_MODEL.
 *
 * What it does (all against the live gateway):
 *   1. GET  /v1/models                     -> tier's allowed models
 *   2. POST /v1/chat/completions (probe)   -> status, latency, usage, billed
 *   3. POST again with the SAME Idempotency-Key -> must be replayed, NOT billed
 *   4. writes evaluation-files/eval-live-<ts>.{json,md}
 *
 * Exit codes: 0 = all checks passed; 1 = a check failed (details in output).
 *
 * The probe prompt is fixed and trivially non-sensitive:
 *   "Reply with exactly: OK"
 * It exercises the full request path (auth, tier, quota, model rewrite,
 * metering) without consuming a meaningful amount of output tokens.
 */

const PROBE_PROMPT = "Reply with exactly: OK";

function parseArgs(argv) {
  const args = {
    gateway: process.env.KOVE_GATEWAY_URL || "https://kove-advanced.pages.dev/api/llm",
    token: process.env.KOVE_GATEWAY_TOKEN || "",
    model: process.env.KOVE_GATEWAY_MODEL || "",
    outDir: "evaluation-files",
    timeoutMs: 120_000,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--gateway") args.gateway = next();
    else if (a === "--token") args.token = next();
    else if (a === "--model") args.model = next();
    else if (a === "--out") args.outDir = next();
    else if (a === "--timeout") args.timeoutMs = parseInt(next(), 10);
    else if (a === "--help" || a === "-h") {
      console.log("Usage: pnpm eval:live --token <jwt> [--gateway <url>] [--model <id>] [--out <dir>]");
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  // Normalize the gateway base (strip trailing slash; keep the /api/llm prefix
  // if the owner passed it, otherwise assume they passed the app origin).
  const g = args.gateway.replace(/\/+$/, "");
  args.gatewayBase = g.endsWith("/api/llm") ? g : `${g}/api/llm`;
  return args;
}

async function call(method, path, token, body, idemKey) {
  const started = Date.now();
  const res = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idemKey ? { "Idempotency-Key": idemKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return {
    status: res.status,
    latencyMs: Date.now() - started,
    json,
    text,
    headers: Object.fromEntries(res.headers.entries()),
  };
}

function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.token) {
    console.error(
      "Missing token. Sign in to the app, copy the session JWT (Clerk), and pass --token \"<jwt>\" (or KOVE_GATEWAY_TOKEN).\n" +
        "Example: pnpm eval:live --token \"<jwt>\"",
    );
    process.exit(1);
  }

  const base = args.gatewayBase;
  console.log(`eval:live against ${base}\n`);
  const results = [];
  const report = {
    gateway: base,
    at: new Date().toISOString(),
    model: args.model || "(gateway default)",
    checks: {},
  };

  // 1. /v1/models (auth + tier)
  const models = await call("GET", `${base}/v1/models`, args.token);
  report.models = models.json?.models;
  results.push(
    check(
      "GET /v1/models authenticated",
      models.status === 200 && Array.isArray(models.json?.models) && models.json.models.length > 0,
      `status ${models.status}, models=${JSON.stringify(models.json?.models)}`,
    ),
  );
  report.checks.models = models.status;

  const probeModel = args.model || models.json?.models?.[0] || "@cf/google/gemma-4-26b-a4b-it";
  const probeBody = {
    model: probeModel,
    messages: [{ role: "user", content: PROBE_PROMPT }],
    max_tokens: 16,
  };

  // 2. First billable turn
  const idemKey = `eval-live-${Date.now().toString(36)}`;
  const first = await call("POST", `${base}/v1/chat/completions`, args.token, probeBody, idemKey);
  const firstUsage = first.json?.usage ?? first.json?.choices?.[0]?.usage;
  report.first = {
    status: first.status,
    latencyMs: first.latencyMs,
    usage: firstUsage,
    billed: first.headers["x-kove-billed"],
    replayed: first.headers["x-kove-replayed"],
  };
  results.push(
    check(
      "first completion is 200 + billed",
      first.status === 200 && first.headers["x-kove-billed"] === "1",
      `status ${first.status}, ${first.latencyMs}ms, billed=${first.headers["x-kove-billed"]}`,
    ),
  );
  report.checks.first = first.status;

  // 3. Replay (same Idempotency-Key) — must be replayed, NOT billed
  const replay = await call("POST", `${base}/v1/chat/completions`, args.token, probeBody, idemKey);
  report.replay = {
    status: replay.status,
    latencyMs: replay.latencyMs,
    billed: replay.headers["x-kove-billed"],
    replayed: replay.headers["x-kove-replayed"],
  };
  results.push(
    check(
      "replay (same key) is NOT billed",
      replay.status === 200 &&
        replay.headers["x-kove-replayed"] === "1" &&
        replay.headers["x-kove-billed"] === "0",
      `status ${replay.status}, replayed=${replay.headers["x-kove-replayed"]}, billed=${replay.headers["x-kove-billed"]}`,
    ),
  );
  report.checks.replay = replay.status;

  // 4. Unauthenticated probe — must 401 (confirms the gateway is enforcing auth)
  const unauth = await call("GET", `${base}/v1/models`, "");
  results.push(
    check(
      "unauthenticated request is 401",
      unauth.status === 401,
      `status ${unauth.status}`,
    ),
  );
  report.checks.unauth = unauth.status;

  const passed = results.filter(Boolean).length;
  const ok = passed === results.length;
  report.passed = passed;
  report.total = results.length;
  report.ok = ok;

  // Write compact summaries (JSON + MD) — no secrets, no prompt content.
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  mkdirSync(args.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = resolve(args.outDir, `eval-live-${stamp}.json`);
  const mdPath = resolve(args.outDir, `eval-live-${stamp}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const md = [
    "# eval:live summary",
    "",
    `- Gateway: \`${base}\``,
    `- At: ${report.at}`,
    `- Result: **${ok ? "PASS" : "FAIL"}** (${passed}/${results.length} checks)`,
    `- Model: \`${probeModel}\``,
    "",
    "| Check | Status | Detail |",
    "| --- | --- | --- |",
    `| GET /v1/models | ${report.checks.models} | models=${JSON.stringify(report.models)} |`,
    `| first completion | ${report.checks.first} | ${report.first.latencyMs}ms, usage=${JSON.stringify(report.first.usage)}, billed=${report.first.billed} |`,
    `| replay (same key) | ${report.checks.replay} | replayed=${report.replay.replayed}, billed=${report.replay.billed} |`,
    `| unauthenticated | ${report.checks.unauth} | status ${report.checks.unauth} |`,
    "",
    "Probe prompt (fixed): \"Reply with exactly: OK\". No media, secrets, or other",
    "prompt content is recorded. This is a GATEWAY smoke, not an edit-quality eval.",
    "",
  ].join("\n");
  writeFileSync(mdPath, md);

  console.log(`\n${ok ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"} (${passed}/${results.length})`);
  console.log(`Wrote: ${jsonPath}`);
  console.log(`Wrote: ${mdPath}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("eval:live failed:", err?.message ?? err);
  process.exit(1);
});
