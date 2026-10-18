import { describe, expect, it } from "vitest";
import { verifyClerkJwt } from "./clerk";

/**
 * Clerk verification tests run against a LOCALLY generated ES256 (P-256)
 * key pair and an in-memory JWKS — no live Clerk endpoint, no secrets.
 */

const ISSUER = "https://test.clerk.accounts.dev";
const JWK_URL = "https://clerk.com/.well-known/jwks.json";

interface TestKeys {
  jwk: Record<string, unknown>;
  privateKey: CryptoKey;
}

async function makeKeys(): Promise<TestKeys> {
  const subtle = globalThis.crypto.subtle;
  const pair = await subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = (await subtle.exportKey("jwk", pair.publicKey)) as Record<
    string,
    unknown
  >;
  jwk.kid = "test-key-1";
  jwk.alg = "ES256";
  return { jwk, privateKey: pair.privateKey };
}

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function makeToken(
  keys: TestKeys,
  claims: Record<string, unknown>,
): Promise<string> {
  const subtle = globalThis.crypto.subtle;
  const header = { alg: "ES256", kid: "test-key-1", typ: "JWT" };
  const data = `${b64url(new TextEncoder().encode(JSON.stringify(header)))}.${b64url(
    new TextEncoder().encode(JSON.stringify(claims)),
  )}`;
  const sig = await subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keys.privateKey,
    new TextEncoder().encode(data).buffer as ArrayBuffer,
  );
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

function jwksFetch(jwk: Record<string, unknown>): typeof fetch {
  return (async (_url: string | URL | Request, _init?: RequestInit) =>
    Response.json({ keys: [jwk] })) as unknown as typeof fetch;
}

const baseOpts = {
  issuer: ISSUER,
  jwksUrl: JWK_URL,
  nowMs: 1_700_000_000_000,
};

describe("verifyClerkJwt", () => {
  it("accepts a valid token and extracts the user id", async () => {
    const keys = await makeKeys();
    const token = await makeToken(keys, {
      iss: ISSUER,
      sub: "user_123",
      exp: 1_700_003_600, // +1h
    });
    const res = await verifyClerkJwt(token, {
      ...baseOpts,
      fetchImpl: jwksFetch(keys.jwk),
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.session.userId).toBe("user_123");
  });

  it("rejects a tampered payload (signature mismatch)", async () => {
    const keys = await makeKeys();
    const token = await makeToken(keys, {
      iss: ISSUER,
      sub: "user_123",
      exp: 1_700_003_600,
    });
    const [h, , s] = token.split(".");
    // Flip a claim without re-signing.
    const evil = `${h}.${b64url(
      new TextEncoder().encode(JSON.stringify({ iss: ISSUER, sub: "attacker", exp: 1_700_003_600 })),
    )}.${s}`;
    const res = await verifyClerkJwt(evil, {
      ...baseOpts,
      fetchImpl: jwksFetch(keys.jwk),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("UNAUTHENTICATED");
      expect(res.error.httpStatus).toBe(401);
    }
  });

  it("rejects an expired token", async () => {
    const keys = await makeKeys();
    const token = await makeToken(keys, {
      iss: ISSUER,
      sub: "user_123",
      exp: 1_699_999_999, // already past nowMs
    });
    const res = await verifyClerkJwt(token, {
      ...baseOpts,
      fetchImpl: jwksFetch(keys.jwk),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects a token from a different issuer", async () => {
    const keys = await makeKeys();
    const token = await makeToken(keys, {
      iss: "https://other-tenant.clerk.accounts.dev",
      sub: "user_123",
      exp: 1_700_003_600,
    });
    const res = await verifyClerkJwt(token, {
      ...baseOpts,
      fetchImpl: jwksFetch(keys.jwk),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("UNAUTHENTICATED");
  });

  it("checks audience when configured", async () => {
    const keys = await makeKeys();
    const token = await makeToken(keys, {
      iss: ISSUER,
      sub: "user_123",
      aud: "api.test.example",
      exp: 1_700_003_600,
    });
    const ok = await verifyClerkJwt(token, {
      ...baseOpts,
      audience: "api.test.example",
      fetchImpl: jwksFetch(keys.jwk),
    });
    expect(ok.ok).toBe(true);

    const bad = await verifyClerkJwt(token, {
      ...baseOpts,
      audience: "api.OTHER.example",
      fetchImpl: jwksFetch(keys.jwk),
    });
    expect(bad.ok).toBe(false);
  });

  it("rejects malformed tokens without throwing", async () => {
    const res = await verifyClerkJwt("not-a-jwt", {
      ...baseOpts,
      fetchImpl: jwksFetch({}),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.httpStatus).toBe(401);
  });

  it("fails closed when the JWKS endpoint is unreachable", async () => {
    const keys = await makeKeys();
    const token = await makeToken(keys, {
      iss: ISSUER,
      sub: "user_123",
      exp: 1_700_003_600,
    });
    const failingFetch = (async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    const res = await verifyClerkJwt(token, {
      ...baseOpts,
      fetchImpl: failingFetch,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.httpStatus).toBe(401);
  });
});
