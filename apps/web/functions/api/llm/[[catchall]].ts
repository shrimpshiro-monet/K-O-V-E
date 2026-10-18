/**
 * Server-side LLM gateway (Cloudflare Pages Function) — `/api/llm/*`.
 *
 * The ONLY path the web client uses for model calls. Provider credentials
 * (Cloudflare Workers AI, and the optional Pro frontier slot) live in Pages
 * secrets and are attached HERE, on the server — the client never sees a
 * provider token.
 *
 * §2 layers on top of the credential-injecting passthrough:
 *   1. AUTH — every request must carry a valid Clerk JWT (401 otherwise).
 *   2. ENTITLEMENT — the user's tier (free/pro) is resolved from Supabase.
 *   3. QUOTA + BUDGET — pre-turn policy gates (429 QUOTA_EXCEEDED, 504).
 *   4. MODEL ROUTING — free → fast (Workers AI); pro → fast or the frontier
 *      slot. The client-sent `model` is replaced by the authorized model, so
 *      a client can never steer to a model its tier may not use.
 *   5. METERING — the successful provider call is recorded idempotently in
 *      the usage ledger (Idempotency-Key header); a replay produces ZERO new
 *      billable rows.
 *
 * The auth/metering logic lives in @kove-advanced/gateway (fully mock-tested
 * there); this file is the thin HTTP adapter: CORS, body cap, header hygiene,
 * upstream routing. `deps` is injectable so the whole flow is unit-testable
 * with mocks — no live Clerk/Supabase/Workers AI required.
 *
 * Dev: the Vite dev proxy (apps/web/vite.config.ts) serves the same path with
 * server-side credentials; desktop: the Electron main process. Both are
 * documented in the smoke-test checklist (docs/SMOKE-TEST-CHECKLIST.md).
 */
import {
  EntitlementStore,
  Gateway,
  SupabaseLedgerStore,
} from "@kove-advanced/gateway";
import {
  DEFAULT_FAST_MODEL,
  DEFAULT_FRONTIER_MODEL,
  Ledger,
  type MeteringError,
  type PlanTier,
} from "@kove-advanced/metering";

const ALLOWED_ORIGINS = [
  "https://kove-advanced.pages.dev",
  "https://kove-advanced-preview.pages.dev",
  "http://localhost:5173",
  "http://localhost:4173",
];

const MAX_REQUEST_BODY_BYTES = 8_388_608; // 8 MB (agent tool/state payloads)
const UPSTREAM_TIMEOUT_MS = 120_000;

/** Paths the client may reach (mirrors the Workers AI surface we use). */
const ALLOWED_PATHS = ["/v1/chat/completions", "/v1/models"];

export interface GatewayEnv {
  // Provider credentials (Workers AI).
  readonly CLOUDFLARE_API_TOKEN?: string;
  readonly CLOUDFLARE_ACCOUNT_ID?: string;
  // Auth (Clerk). Issuer = the Clerk instance, e.g.
  // https://<instance>.clerk.accounts.dev. JWKS URL defaults to the
  // instance's well-known key set.
  readonly CLERK_ISSUER?: string;
  readonly CLERK_JWKS_URL?: string;
  readonly CLERK_AUDIENCE?: string;
  // Entitlements + ledger (Supabase Postgres, service-role = server-only).
  readonly SUPABASE_URL?: string;
  readonly SUPABASE_SERVICE_ROLE_KEY?: string;
  // Optional Pro frontier slot (owner wires the real endpoint/secret).
  readonly FRONTIER_BASE_URL?: string;
  readonly FRONTIER_API_KEY?: string;
  // Model overrides (defaults are the shared metering constants).
  readonly GATEWAY_FAST_MODEL?: string;
  readonly GATEWAY_FRONTIER_MODEL?: string;
}

/**
 * Injectable dependencies for the HTTP adapter. In production these are built
 * from `env` by `buildProductionDeps`; in tests they are fakes.
 */
export interface LlmGatewayDeps {
  readonly gateway: Gateway;
  readonly fetchProvider: (url: string, init: RequestInit) => Promise<Response>;
  readonly fastModel: string;
  readonly frontierModel?: string;
  readonly hasFrontier: boolean;
  readonly isFrontierModel?: (modelId: string) => boolean;
}

interface GatewayContext {
  readonly request: Request;
  readonly params?: Record<string, string | string[] | undefined>;
  readonly env: GatewayEnv;
}

class BodyTooLargeError extends Error {}
class NotConfiguredError extends Error {}

/**
 * Buffer a request body while enforcing a byte cap — so the limit holds for
 * chunked/streamed transfers too, not just when Content-Length is present.
 */
async function readBodyCapped(
  request: Request,
  max: number,
): Promise<ArrayBuffer | undefined> {
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Idempotency-Key",
    Vary: "Origin",
  };
}

function jsonError(
  message: string,
  status: number,
  code: string,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({ error: { code, message } }),
    { status, headers: { "Content-Type": "application/json", ...corsHeaders } },
  );
}

/** Structured metering error → HTTP response (preserves code + suggestedFix). */
function meteringErrorToResponse(
  err: MeteringError,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: err.code,
        message: err.message,
        suggestedFix: err.suggestedFix,
      },
    }),
    {
      status: err.httpStatus,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    },
  );
}

/**
 * Build production dependencies from Pages env. Fails CLOSED: if auth or the
 * ledger is not configured we refuse to serve (503) rather than silently
 * allow unauthenticated LLM access.
 */
export function buildProductionDeps(env: GatewayEnv): LlmGatewayDeps {
  const issuer = env.CLERK_ISSUER?.trim();
  const supabaseUrl = env.SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!issuer || !supabaseUrl || !serviceRoleKey) {
    throw new NotConfiguredError(
      "LLM gateway auth/ledger not configured (need CLERK_ISSUER, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).",
    );
  }
  // Clerk JWKS lives at https://<instance>.clerk.com/.well-known/jwks.json;
  // the issuer is https://<instance>.clerk.accounts.dev.
  const jwksUrl =
    env.CLERK_JWKS_URL?.trim() ||
    `${issuer.replace(".accounts.dev", ".com")}/.well-known/jwks.json`;

  const fastModel = env.GATEWAY_FAST_MODEL?.trim() || DEFAULT_FAST_MODEL;
  const frontierModel = env.GATEWAY_FRONTIER_MODEL?.trim() || DEFAULT_FRONTIER_MODEL;
  const hasFrontier = Boolean(env.FRONTIER_BASE_URL?.trim() && env.FRONTIER_API_KEY?.trim());

  const gateway = new Gateway({
    clerk: {
      issuer,
      jwksUrl,
      audience: env.CLERK_AUDIENCE?.trim() || undefined,
    },
    entitlements: new EntitlementStore({ url: supabaseUrl, serviceRoleKey }),
    ledger: new Ledger(
      new SupabaseLedgerStore({ url: supabaseUrl, serviceRoleKey }),
    ),
    isFrontierModel: (m) => m === frontierModel,
  });

  const fetchProvider: LlmGatewayDeps["fetchProvider"] = (url, init) =>
    fetch(url, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });

  return { gateway, fetchProvider, fastModel, frontierModel, hasFrontier };
}

/** Resolved upstream target for an authorized model. */
function resolveUpstream(
  model: string,
  env: GatewayEnv,
  deps: LlmGatewayDeps,
):
  | { ok: true; url: string; authorization: string }
  | { ok: false; error: MeteringError } {
  const isFrontier = deps.isFrontierModel
    ? deps.isFrontierModel(model)
    : model === deps.frontierModel;
  if (isFrontier) {
    const base = env.FRONTIER_BASE_URL?.trim();
    const key = env.FRONTIER_API_KEY?.trim();
    if (!base || !key || !deps.hasFrontier) {
      return {
        ok: false,
        error: {
          code: "FRONTIER_NOT_CONFIGURED",
          message: "The requested model tier is not available on this deployment yet.",
          suggestedFix: "Try the default model, or contact support about Pro model access.",
          httpStatus: 503,
        },
      };
    }
    return {
      ok: true,
      url: `${base.replace(/\/$/, "")}/v1/chat/completions`,
      authorization: `Bearer ${key}`,
    };
  }
  // Fast model → Cloudflare Workers AI (OpenAI-compatible surface).
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!apiToken || !accountId) {
    return {
      ok: false,
      error: {
        code: "GATEWAY_NOT_CONFIGURED",
        message: "LLM gateway is not configured on this deployment (missing Pages secrets).",
        suggestedFix: "Contact support.",
        httpStatus: 503,
      },
    };
  }
  return {
    ok: true,
    url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`,
    authorization: `Bearer ${apiToken}`,
  };
}

/** The tier's allowed model ids (for the authenticated /v1/models endpoint). */
function allowedModelsFor(deps: LlmGatewayDeps, tier: PlanTier): string[] {
  const base = [deps.fastModel];
  if (tier === "pro" && deps.frontierModel) base.push(deps.frontierModel);
  return base;
}

export async function handleLlmGateway(
  request: Request,
  env: GatewayEnv,
  path: string,
  deps?: LlmGatewayDeps,
): Promise<Response> {
  const corsHeaders = getCorsHeaders(request);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonError("Method not allowed", 405, "METHOD_NOT_ALLOWED", corsHeaders);
  }

  const normalizedPath = `/${path.split("/").filter(Boolean).join("/")}`;
  if (!ALLOWED_PATHS.includes(normalizedPath)) {
    return jsonError(`Path not allowed: ${normalizedPath}`, 404, "NOT_FOUND", corsHeaders);
  }

  // Resolve deps: injected (tests) or built from env (production).
  let resolved: LlmGatewayDeps;
  try {
    resolved = deps ?? buildProductionDeps(env);
  } catch {
    return jsonError(
      "LLM gateway is not configured on this deployment (missing Pages secrets).",
      503,
      "GATEWAY_NOT_CONFIGURED",
      corsHeaders,
    );
  }

  const isCompletions = normalizedPath === "/v1/chat/completions";
  if (isCompletions && request.method !== "POST") {
    return jsonError("Method not allowed", 405, "METHOD_NOT_ALLOWED", corsHeaders);
  }

  // Fast-path reject on a declared oversized body; the streaming cap below is
  // the authoritative check (covers chunked transfers with no Content-Length).
  if (request.headers.has("Content-Length")) {
    const contentLength = parseInt(request.headers.get("Content-Length") ?? "0", 10);
    if (contentLength > MAX_REQUEST_BODY_BYTES) {
      return jsonError("Request body too large", 413, "BODY_TOO_LARGE", corsHeaders);
    }
  }

  // Buffer + parse the body (if any) so the requested model is known BEFORE
  // the policy gates run (model routing depends on it).
  let payload: Record<string, unknown> = {};
  let hadBody = false;
  if (isCompletions) {
    let requestBody: ArrayBuffer | undefined;
    try {
      requestBody = await readBodyCapped(request, MAX_REQUEST_BODY_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return jsonError("Request body too large", 413, "BODY_TOO_LARGE", corsHeaders);
      }
      throw err;
    }
    if (requestBody) {
      try {
        payload = JSON.parse(new TextDecoder().decode(requestBody)) as Record<string, unknown>;
        hadBody = true;
      } catch {
        return jsonError("Request body must be valid JSON", 400, "BAD_REQUEST", corsHeaders);
      }
    }
  }
  const requestedModel =
    typeof payload.model === "string" && payload.model.trim()
      ? payload.model.trim()
      : undefined;

  // AUTH + ENTITLEMENT + QUOTA + BUDGET (401 / 403 / 429 / 504).
  const authorized = await resolved.gateway.authorize(request, { requestedModel });
  if (!authorized.ok) return meteringErrorToResponse(authorized.error, corsHeaders);

  // /v1/models: authenticated, NOT billable — the tier's allowed models.
  if (normalizedPath === "/v1/models") {
    return new Response(
      JSON.stringify({ models: allowedModelsFor(resolved, authorized.turn.tier) }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }

  // Enforce the authorized model — never trust the client's model choice.
  payload.model = authorized.turn.model;
  const finalBody = hadBody || Object.keys(payload).length > 0 ? JSON.stringify(payload) : undefined;

  const upstream = resolveUpstream(authorized.turn.model, env, resolved);
  if (!upstream.ok) return meteringErrorToResponse(upstream.error, corsHeaders);

  const turn = authorized.turn;
  const completed = await resolved.gateway.complete(
    turn,
    () =>
      resolved.fetchProvider(upstream.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: upstream.authorization,
        },
        body: finalBody,
      }),
  );
  if (!completed.ok) return meteringErrorToResponse(completed.error, corsHeaders);

  // Strip CF-internal headers before forwarding to the browser.
  const responseHeaders = new Headers(completed.response.headers);
  for (const hop of ["cf-ray", "cf-cache-status", "set-cookie", "connection"]) {
    responseHeaders.delete(hop);
  }
  for (const [key, value] of Object.entries(corsHeaders)) {
    responseHeaders.set(key, value);
  }
  // Advertise replay accounting to the client (informational, no secrets).
  responseHeaders.set("X-Kove-Billed", completed.billed ? "1" : "0");
  responseHeaders.set("X-Kove-Replayed", completed.replayed ? "1" : "0");

  return new Response(completed.response.body, {
    status: completed.response.status,
    statusText: completed.response.statusText,
    headers: responseHeaders,
  });
}

/**
 * Pages Function entrypoint. `path` is the remainder after /api/llm.
 * NOTE: no request/prompt logging here — media and prompts must not enter
 * logs (the ledger stores only token counts + latency, never content).
 */
export const onRequest = async (context: GatewayContext): Promise<Response> => {
  const rawPath = Array.isArray(context.params?.catchall)
    ? (context.params?.catchall as string[]).join("/")
    : typeof context.params?.catchall === "string"
      ? (context.params?.catchall as string)
      : "";
  return handleLlmGateway(context.request, context.env, rawPath);
};
