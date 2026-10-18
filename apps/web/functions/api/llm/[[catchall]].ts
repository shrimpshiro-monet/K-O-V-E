/**
 * Server-side LLM gateway (Cloudflare Pages Function) — `/api/llm/*`.
 *
 * This is the ONLY path the web client uses for Cloudflare Workers AI calls.
 * Provider credentials live in Pages secrets (`CLOUDFLARE_API_TOKEN`,
 * `CLOUDFLARE_ACCOUNT_ID` — set via `wrangler pages secret put`) and are
 * attached here, on the server. The client sends an unauthenticated JSON body
 * and never sees a provider token.
 *
 * PR2 (§2) layers on top of this file: session auth on every request, the
 * usage ledger, plans/quotas/rate limits, and role-based model routing.
 * Until then it is a credential-injecting passthrough with the same hardening
 * as the legacy BYOK proxy (strict CORS, 8 MB streaming body cap, no body
 * logging).
 *
 * Dev: the Vite dev proxy (apps/web/vite.config.ts) provides the same
 * same-origin `/api/llm/*` path with server-side credentials from .dev.vars.
 * Desktop: the Electron main process provides it from its runtime env.
 */

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

interface GatewayEnv {
  readonly CLOUDFLARE_API_TOKEN?: string;
  readonly CLOUDFLARE_ACCOUNT_ID?: string;
}

interface GatewayContext {
  readonly request: Request;
  readonly params?: Record<string, string | string[] | undefined>;
  readonly env: GatewayEnv;
}

class BodyTooLargeError extends Error {}

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
    "Access-Control-Allow-Headers": "Content-Type",
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

export async function handleLlmGateway(
  request: Request,
  env: GatewayEnv,
  path: string,
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

  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!apiToken || !accountId) {
    return jsonError(
      "LLM gateway is not configured on this deployment (missing Pages secrets).",
      503,
      "GATEWAY_NOT_CONFIGURED",
      corsHeaders,
    );
  }

  // Fast-path reject on a declared oversized body; the streaming cap below is
  // the authoritative check (covers chunked transfers with no Content-Length).
  if (request.headers.has("Content-Length")) {
    const contentLength = parseInt(request.headers.get("Content-Length") ?? "0", 10);
    if (contentLength > MAX_REQUEST_BODY_BYTES) {
      return jsonError("Request body too large", 413, "BODY_TOO_LARGE", corsHeaders);
    }
  }

  let requestBody: ArrayBuffer | undefined;
  if (request.method === "POST") {
    try {
      requestBody = await readBodyCapped(request, MAX_REQUEST_BODY_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return jsonError("Request body too large", 413, "BODY_TOO_LARGE", corsHeaders);
      }
      throw err;
    }
  }

  const originalUrl = new URL(request.url);
  const targetUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai${normalizedPath}${originalUrl.search}`;

  const upstreamHeaders = new Headers();
  const contentType = request.headers.get("Content-Type");
  if (contentType) upstreamHeaders.set("Content-Type", contentType);
  upstreamHeaders.set("Authorization", `Bearer ${apiToken}`);

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(targetUrl, {
      method: request.method,
      headers: upstreamHeaders,
      body: request.method === "POST" ? requestBody : undefined,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const message =
      err instanceof DOMException && err.name === "TimeoutError"
        ? "Upstream request timed out"
        : "Failed to reach upstream service";
    return jsonError(message, 502, "UPSTREAM_ERROR", corsHeaders);
  }

  // Strip CF-internal headers before forwarding to the browser.
  const responseHeaders = new Headers(upstreamResponse.headers);
  for (const hop of ["cf-ray", "cf-cache-status", "set-cookie", "connection"]) {
    responseHeaders.delete(hop);
  }
  for (const [key, value] of Object.entries(corsHeaders)) {
    responseHeaders.set(key, value);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}

/**
 * Pages Function entrypoint. `path` is the remainder after /api/llm.
 * NOTE: no request/prompt logging here — media and prompts must not enter
 * logs (billing/debugging needs a redacted trace, added with the ledger in
 * PR2).
 */
export const onRequest = async (context: GatewayContext): Promise<Response> => {
  const rawPath = Array.isArray(context.params?.catchall)
    ? (context.params?.catchall as string[]).join("/")
    : typeof context.params?.catchall === "string"
      ? (context.params?.catchall as string)
      : "";
  return handleLlmGateway(context.request, context.env, rawPath);
};
