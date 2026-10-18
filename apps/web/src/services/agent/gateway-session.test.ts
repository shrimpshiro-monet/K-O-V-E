import { afterEach, describe, expect, it } from "vitest";
import {
  deriveIdempotencyKey,
  getGatewayToken,
  GatewayLlmError,
  parseGatewayError,
  setGatewaySession,
} from "./gateway-session";

describe("gateway-session", () => {
  afterEach(() => {
    setGatewaySession(undefined);
  });

  describe("session token", () => {
    it("returns undefined when no session is registered", async () => {
      expect(await getGatewayToken()).toBeUndefined();
    });

    it("returns the token from a registered session", async () => {
      setGatewaySession({ getToken: () => "jwt-abc" });
      expect(await getGatewayToken()).toBe("jwt-abc");
    });

    it("awaits an async session provider", async () => {
      setGatewaySession({
        getToken: async () => "async-jwt",
      });
      expect(await getGatewayToken()).toBe("async-jwt");
    });

    it("treats blank tokens as absent", async () => {
      setGatewaySession({ getToken: () => "   " });
      expect(await getGatewayToken()).toBeUndefined();
    });
  });

  describe("deriveIdempotencyKey", () => {
    const body = {
      model: "@cf/google/gemma-4-26b-a4b-it",
      messages: [{ role: "user", content: "trim the intro" }],
      max_tokens: 1024,
    };

    it("is deterministic for the same call (retries reuse the key)", async () => {
      const a = await deriveIdempotencyKey(body.model, body);
      const b = await deriveIdempotencyKey(body.model, { ...body });
      expect(a).toBe(b);
      expect(a).toMatch(/^v1\./);
    });

    it("changes when the messages change (distinct calls get distinct keys)", async () => {
      const a = await deriveIdempotencyKey(body.model, body);
      const b = await deriveIdempotencyKey(body.model, {
        ...body,
        messages: [{ role: "user", content: "a DIFFERENT brief" }],
      });
      expect(a).not.toBe(b);
    });

    it("changes when the model changes", async () => {
      const a = await deriveIdempotencyKey("model-a", body);
      const b = await deriveIdempotencyKey("model-b", body);
      expect(a).not.toBe(b);
    });

    it("is stable under message-content normalization order (string content)", async () => {
      const a = await deriveIdempotencyKey(body.model, body);
      const reshaped = { ...body, messages: [{ role: "user", content: body.messages[0].content }] };
      expect(await deriveIdempotencyKey(body.model, reshaped)).toBe(a);
    });
  });

  describe("parseGatewayError", () => {
    it("parses a structured gateway error (code + message + suggestedFix)", () => {
      const text = JSON.stringify({
        error: {
          code: "QUOTA_EXCEEDED",
          message: "Daily limit reached",
          suggestedFix: "Upgrade or try tomorrow.",
        },
      });
      const err = parseGatewayError(429, text);
      expect(err).toBeInstanceOf(GatewayLlmError);
      expect(err).toMatchObject({
        code: "QUOTA_EXCEEDED",
        httpStatus: 429,
        suggestedFix: "Upgrade or try tomorrow.",
      });
    });

    it("returns undefined for a non-structured body (falls back to plain HTTP error)", () => {
      expect(parseGatewayError(500, "internal upstream blip")).toBeUndefined();
      expect(parseGatewayError(401, JSON.stringify({ error: "invalid token" }))).toBeUndefined();
    });

    it("returns undefined for 2xx", () => {
      expect(parseGatewayError(200, JSON.stringify({ error: { code: "X" } }))).toBeUndefined();
    });

    it("preserves the UNAUTHENTICATED code so the UI can prompt sign-in", () => {
      const err = parseGatewayError(
        401,
        JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "sign in" } }),
      );
      expect(err?.code).toBe("UNAUTHENTICATED");
    });
  });
});
