/**
 * Client-side session + idempotency for the server-side LLM gateway (§2).
 *
 * The gateway (apps/web/functions/api/llm) requires:
 *   - `Authorization: Bearer <Clerk session JWT>` on every request, and
 *   - `Idempotency-Key` on completion requests (metering dedup — a replayed
 *     request must never create a second billable event).
 *
 * TOKEN
 *   The app registers a session provider once it has a sign-in (Clerk is the
 *   owner's chosen identity provider). Until the app wires Clerk, no provider
 *   is registered and requests go out WITHOUT a token: the production gateway
 *   answers 401 (correct — fail closed), and the local dev proxy still works
 *   for development (documented in docs/SMOKE-TEST-CHECKLIST.md).
 *
 * IDEMPOTENCY KEY
 *   Derived deterministically from the exact request (model + messages +
 *   max tokens). `withRetry` re-invokes the send with the IDENTICAL body on
 *   a retry, so every retry of the same logical call reuses the same key and
 *   the ledger dedups it. Different logical calls have different bodies and
 *   therefore different keys.
 */

/** Provides the current session token (Clerk JWT) when signed in. */
export interface GatewaySession {
  /** Returns the session JWT, or undefined when not signed in. */
  getToken(): string | undefined | Promise<string | undefined>;
}

let session: GatewaySession | undefined;

/** Register the app's session provider (e.g. once Clerk sign-in lands). */
export function setGatewaySession(next: GatewaySession | undefined): void {
  session = next;
}

export async function getGatewayToken(): Promise<string | undefined> {
  if (!session) return undefined;
  const t = await session.getToken();
  return t && t.trim() ? t : undefined;
}

/** FNV-1a 32-bit fallback for contexts without WebCrypto (non-secure origins). */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Stable string for the parts of the body that define the LLM call. */
function canonicalCallKey(model: unknown, body: unknown): string {
  const b = (body ?? {}) as Record<string, unknown>;
  const messages = Array.isArray(b.messages)
    ? b.messages
        .map((m: Record<string, unknown>) =>
          JSON.stringify([m.role, typeof m.content === "string" ? m.content : JSON.stringify(m.content)]),
        )
        .join("\u0000")
    : "";
  return `${model ?? ""}\u0001${messages}\u0001${b.max_tokens ?? b.maxTokens ?? ""}`;
}

/**
 * Derives the Idempotency-Key for a gateway completion call. Deterministic in
 * the request content: retries of the same call reuse the key (ledger dedup),
 * distinct calls get distinct keys.
 */
export async function deriveIdempotencyKey(model: unknown, body: unknown): Promise<string> {
  const canonical = canonicalCallKey(model, body);
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      const digest = await subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonical),
      );
      return `v1.${b64urlFromBytes(new Uint8Array(digest)).slice(0, 32)}`;
    }
  } catch {
    // fall through to the FNV fallback
  }
  return `v1.f.${fnv1a(canonical)}`;
}

// ---- Structured gateway errors --------------------------------------------

export type GatewayErrorCode =
  | "UNAUTHENTICATED"
  | "MODEL_NOT_ALLOWED"
  | "QUOTA_EXCEEDED"
  | "BUDGET_EXCEEDED"
  | "FRONTIER_NOT_CONFIGURED"
  | "GATEWAY_NOT_CONFIGURED"
  | "INTERNAL";

/**
 * A structured error returned by the gateway. Intentionally NOT an
 * LLMHttpError, so withRetry does NOT retry it (quota/auth failures are not
 * transient).
 */
export class GatewayLlmError extends Error {
  constructor(
    readonly code: GatewayErrorCode | string,
    message: string,
    readonly httpStatus: number,
    readonly suggestedFix?: string,
  ) {
    super(message);
    this.name = "GatewayLlmError";
  }
}

interface GatewayErrorBody {
  error?: { code?: string; message?: string; suggestedFix?: string };
}

/** Parses a non-OK gateway response into a structured error when possible. */
export function parseGatewayError(
  status: number,
  text: string,
): GatewayLlmError | undefined {
  if (status < 400) return undefined;
  let parsed: GatewayErrorBody;
  try {
    parsed = JSON.parse(text) as GatewayErrorBody;
  } catch {
    return undefined;
  }
  const { code, message, suggestedFix } = parsed.error ?? {};
  if (!code || typeof code !== "string") return undefined;
  return new GatewayLlmError(
    code,
    typeof message === "string" && message ? message : `Gateway error (${status})`,
    status,
    typeof suggestedFix === "string" ? suggestedFix : undefined,
  );
}
