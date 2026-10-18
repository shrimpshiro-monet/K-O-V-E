/**
 * Clerk JWT verification for the server-side gateway.
 *
 * Clerk issues ES256 (ECDSA P-256) JSON Web Tokens; the public keys are
 * published at a JWKS endpoint (default https://clerk.com/.well-known/jwks.json,
 * or a custom domain). This module verifies signature, issuer, audience and
 * expiry, then hands the gateway a {@link ClerkSession} (userId + claims).
 *
 * Dependency-free (WebCrypto only) and fully injectable: `fetchImpl`, the
 * subtle crypto, and `nowMs` are all overridable so CI can verify against a
 * locally generated key pair without any live Clerk endpoint.
 */
import { meteringError, type MeteringError } from "@kove-advanced/metering";

export interface JwtHeader {
  readonly alg: string;
  readonly kid?: string;
  readonly typ?: string;
}

export interface Jwk {
  readonly kty: string;
  readonly kid?: string;
  readonly use?: string;
  readonly alg?: string;
  // EC keys
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
  // RS keys (kept for forward-compat)
  readonly e?: string;
  readonly n?: string;
}

export interface JwksDoc {
  readonly keys: readonly Jwk[];
}

export interface ClerkSession {
  readonly userId: string;
  readonly raw: Record<string, unknown>;
}

export interface VerifyJwtOptions {
  /** Expected `iss` (your Clerk frontend API, e.g. https://xxxx.clerk.accounts.dev). */
  readonly issuer: string;
  /** Expected `aud`; omit to skip the audience check. */
  readonly audience?: string;
  /** JWKS URL. */
  readonly jwksUrl: string;
  readonly nowMs?: number;
  /** Injectable fetch (defaults to global). */
  readonly fetchImpl?: typeof fetch;
  /** Injectable WebCrypto subtle (defaults to globalThis.crypto.subtle). */
  readonly subtle?: SubtleCrypto;
  /** Injectable clock guard — defaults to subtle-based ES256. */
  readonly verifySignature?: (
    data: ArrayBuffer,
    signature: ArrayBuffer,
    key: CryptoKey,
    subtle: SubtleCrypto,
  ) => Promise<boolean>;
}

const b64urlDecode = (part: string): Uint8Array => {
  const pad = part.length % 4 === 0 ? "" : "=".repeat(4 - (part.length % 4));
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
};

const b64urlToJson = (part: string): unknown =>
  JSON.parse(new TextDecoder().decode(b64urlDecode(part))) as unknown;

function splitJwt(token: string): { header: JwtHeader; payload: Record<string, unknown>; data: string; signature: string } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed JWT");
  const [h, p, s] = parts;
  return {
    header: b64urlToJson(h) as JwtHeader,
    payload: b64urlToJson(p) as Record<string, unknown>,
    data: `${h}.${p}`,
    signature: s,
  };
}

/**
 * Imports a P-256 public key from a JWK.
 *
 * JWK import is the standard, unambiguous path (Node 22 webcrypto and
 * Cloudflare Workers both support it). The ambient `SubtleCrypto` typings in
 * this toolchain (inherited from the Vite/vitest dependency chain) omit the
 * "jwk" overload, so the call goes through a narrow local interface — a
 * deliberate, single-site type escape, not a behavior change.
 */
interface JwkImportable {
  importKey(
    format: "jwk",
    keyData: Record<string, unknown>,
    algorithm: { name: "ECDSA"; namedCurve: "P-256" },
    extractable: boolean,
    keyUsages: KeyUsage[],
  ): Promise<CryptoKey>;
}

async function jwkToPublicKey(jwk: Jwk, subtle: SubtleCrypto): Promise<CryptoKey> {
  if (jwk.kty === "EC" && jwk.crv === "P-256" && jwk.x && jwk.y) {
    return (subtle as unknown as JwkImportable).importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, kid: jwk.kid, alg: jwk.alg ?? "ES256" },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  }
  throw new Error(`unsupported JWK kty=${jwk.kty ?? "?"} crv=${jwk.crv ?? "?"}`);
}

const defaultVerifySignature = (
  data: ArrayBuffer,
  signature: ArrayBuffer,
  key: CryptoKey,
  subtle: SubtleCrypto,
): Promise<boolean> =>
  subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, data);

export type VerifyResult =
  | { ok: true; session: ClerkSession }
  | { ok: false; error: MeteringError };

/**
 * Verify a Clerk-issued access token. Returns a session on success, or a
 * structured 401 UNAUTHENTICATED error on any failure (we deliberately do not
 * distinguish "bad token" from "expired" to the client — both are 401).
 */
export async function verifyClerkJwt(
  token: string,
  opts: VerifyJwtOptions,
): Promise<VerifyResult> {
  const fail = (message: string): VerifyResult => ({
    ok: false,
    error: meteringError(
      "UNAUTHENTICATED",
      message,
      "Sign in to continue.",
      401,
    ),
  });

  let parsed;
  try {
    parsed = splitJwt(token);
  } catch {
    return fail("A valid sign-in is required.");
  }
  if (parsed.header.alg !== "ES256") return fail("Unsupported token algorithm.");

  const now = opts.nowMs ?? Date.now();
  const exp = parsed.payload.exp;
  if (typeof exp === "number" && now / 1000 >= exp) return fail("Your sign-in has expired.");

  const sub = parsed.payload.sub;
  if (typeof sub !== "string" || sub.length === 0) return fail("Token is missing a user id.");

  const iss = parsed.payload.iss;
  if (typeof iss !== "string" || !sameOrigin(iss, opts.issuer)) {
    return fail("Token issuer mismatch.");
  }
  if (opts.audience) {
    const aud = parsed.payload.aud;
    const audList = Array.isArray(aud) ? aud : [aud];
    if (!audList.includes(opts.audience)) return fail("Token audience mismatch.");
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const subtle = opts.subtle ?? globalThis.crypto.subtle;

  let keys: readonly Jwk[];
  try {
    const res = await fetchImpl(opts.jwksUrl, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return fail("Unable to verify sign-in (key service unavailable).");
    const doc = (await res.json()) as JwksDoc;
    keys = doc.keys ?? [];
  } catch {
    return fail("Unable to verify sign-in (key service unreachable).");
  }

  const kid = parsed.header.kid;
  const jwk =
    (kid && keys.find((k) => k.kid === kid)) ||
    keys.find((k) => !k.kid) ||
    keys[0];
  if (!jwk) return fail("No matching signing key found.");

  let key: CryptoKey;
  try {
    key = await jwkToPublicKey(jwk, subtle);
  } catch {
    return fail("Unsupported signing key.");
  }

  const data = new TextEncoder().encode(parsed.data).buffer as ArrayBuffer;
  const signature = b64urlDecode(parsed.signature).buffer as ArrayBuffer;

  let valid = false;
  try {
    valid = await (opts.verifySignature ?? defaultVerifySignature)(data, signature, key, subtle);
  } catch {
    valid = false;
  }
  if (!valid) return fail("Sign-in verification failed.");

  return { ok: true, session: { userId: sub, raw: parsed.payload } };
}

/** Compare origins ignoring trailing slash and case. */
function sameOrigin(a: string, b: string): boolean {
  const norm = (s: string) =>
    s.trim().replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}
