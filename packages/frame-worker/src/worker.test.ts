import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorize,
  corsHeaders,
  handleVisionRequest,
  isOriginAllowed,
  rateLimitAllows,
  resetRateLimiter,
  resolveAllowedOrigins,
  timingSafeEqual,
  type Env,
} from "./worker";

const TOKEN = "s3cret-token";

function env(overrides: Partial<Env> = {}): Env {
  return {
    CF_AI_MODEL: "@cf/meta/llama-3.2-11b-vision-instruct",
    CLOUDFLARE_ACCOUNT_ID: "acct",
    CLOUDFLARE_API_TOKEN: "api-token",
    WORKER_AUTH_TOKEN: TOKEN,
    ...overrides,
  };
}

function jsonBody(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

function frame(timestamp = 0, imageData = "AAAA") {
  return { timestamp, imageData, width: 64, height: 48 };
}

function request(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request("https://worker.example/analyze-frames", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function validBody(frameCount = 1) {
  return {
    videoId: "clip",
    totalDuration: 10,
    frames: [{ batchIndex: 0, frames: Array.from({ length: frameCount }, (_, i) => frame(i)) }],
  };
}

/** Stub the upstream AI call; `failAt` makes a specific frame index throw. */
function stubVision(options: { failAt?: number[] } = {}) {
  let calls = 0;
  const stub = vi.fn(async () => {
    const index = calls;
    calls += 1;
    if (options.failAt?.includes(index)) {
      return new Response("upstream detail that must not leak", { status: 500 });
    }
    return new Response(
      JSON.stringify({
        result: { response: JSON.stringify({ description: `frame ${index}`, sceneType: "b-roll" }) },
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

beforeEach(() => {
  resetRateLimiter();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("authorization", () => {
  it("refuses to serve when no token is configured", async () => {
    const response = await handleVisionRequest(request(validBody()), env({ WORKER_AUTH_TOKEN: undefined }));

    expect(response.status).toBe(503);
    expect((await jsonBody(response)).error).toContain("WORKER_AUTH_TOKEN");
  });

  it("rejects a missing token", async () => {
    const response = await handleVisionRequest(
      request(validBody(), { Authorization: "" }),
      env(),
    );

    expect(response.status).toBe(401);
  });

  it("rejects a wrong token", async () => {
    const response = await handleVisionRequest(
      request(validBody(), { Authorization: "Bearer nope" }),
      env(),
    );

    expect(response.status).toBe(401);
    expect((await jsonBody(response)).error).toBe("Invalid token.");
  });

  it("rejects a token of the right length but wrong content", async () => {
    const response = await handleVisionRequest(
      request(validBody(), { Authorization: `Bearer ${"x".repeat(TOKEN.length)}` }),
      env(),
    );

    expect(response.status).toBe(401);
  });

  it("accepts the configured token", async () => {
    stubVision();
    const response = await handleVisionRequest(request(validBody()), env());

    expect(response.status).toBe(200);
  });

  it("compares secrets without early exit", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "ab")).toBe(false);
  });

  it("classifies each rejection", () => {
    expect(authorize(request(validBody()), env())).toEqual({ ok: true });
    expect(authorize(request(validBody()), env({ WORKER_AUTH_TOKEN: undefined })).ok).toBe(false);
    expect(authorize(request(validBody(), { Authorization: "Basic x" }), env()).ok).toBe(false);
  });
});

describe("CORS", () => {
  it("sends no allow-origin header when nothing is configured", () => {
    const headers = corsHeaders(request(validBody(), { Origin: "https://evil.example" }), env());

    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
    // Never cacheable: one origin's answer must not be served to another.
    expect(headers.Vary).toBe("Origin");
  });

  it("allows a configured origin and no other", () => {
    const configured = env({ ALLOWED_ORIGINS: "https://app.example, https://staging.example" });

    expect(corsHeaders(request(validBody(), { Origin: "https://app.example" }), configured)["Access-Control-Allow-Origin"]).toBe("https://app.example");
    expect(corsHeaders(request(validBody(), { Origin: "https://evil.example" }), configured)["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("only honours a wildcard when it is asked for explicitly", () => {
    expect(resolveAllowedOrigins(env())).toEqual([]);
    expect(resolveAllowedOrigins(env({ ALLOWED_ORIGINS: "*" }))).toBe("*");
    expect(corsHeaders(request(validBody(), { Origin: "https://any.example" }), env({ ALLOWED_ORIGINS: "*" }))["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("rejects a disallowed browser origin with 403 before spending anything", async () => {
    const stub = stubVision();
    const response = await handleVisionRequest(
      request(validBody(), { Origin: "https://evil.example" }),
      env({ ALLOWED_ORIGINS: "https://app.example" }),
    );

    expect(response.status).toBe(403);
    expect(stub).not.toHaveBeenCalled();
  });

  it("lets a non-browser caller through, since it cannot be a cross-origin page", () => {
    expect(isOriginAllowed(request(validBody()), env({ ALLOWED_ORIGINS: "https://app.example" }))).toBe(true);
  });

  it("answers preflight with the allowlist and no auth", async () => {
    const response = await handleVisionRequest(
      new Request("https://worker.example/analyze-frames", {
        method: "OPTIONS",
        headers: { Origin: "https://app.example" },
      }),
      env({ ALLOWED_ORIGINS: "https://app.example" }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example");
  });

  it("rejects other methods", async () => {
    const response = await handleVisionRequest(
      new Request("https://worker.example/analyze-frames", { method: "GET" }),
      env(),
    );

    expect(response.status).toBe(405);
  });
});

describe("frame caps", () => {
  it("rejects a request over the frame cap", async () => {
    const stub = stubVision();
    const response = await handleVisionRequest(
      request(validBody(41)),
      env({ MAX_FRAMES_PER_REQUEST: "40" }),
    );

    expect(response.status).toBe(413);
    expect(stub).not.toHaveBeenCalled();
  });

  it("accepts a request at the cap when the batches respect the batch cap", async () => {
    stubVision();
    const batches = Array.from({ length: 5 }, (_, batchIndex) => ({
      batchIndex,
      frames: Array.from({ length: 8 }, (_, index) => frame(batchIndex * 8 + index)),
    }));
    const response = await handleVisionRequest(
      request({ videoId: "clip", totalDuration: 60, frames: batches }),
      env({ MAX_FRAMES_PER_REQUEST: "40", MAX_FRAMES_PER_BATCH: "8" }),
    );

    expect(response.status).toBe(200);
    expect((await jsonBody(response)).totalFrames).toBe(40);
  });

  it("rejects an oversized batch", async () => {
    stubVision();
    const response = await handleVisionRequest(request(validBody(9)), env({ MAX_FRAMES_PER_BATCH: "8" }));

    expect(response.status).toBe(413);
  });

  it("rejects an oversized frame", async () => {
    stubVision();
    const response = await handleVisionRequest(
      request({ videoId: "clip", totalDuration: 1, frames: [{ batchIndex: 0, frames: [frame(0, "a".repeat(50))] }] }),
      env({ MAX_FRAME_BYTES: "10" }),
    );

    expect(response.status).toBe(413);
  });

  it("applies a default cap with no configuration at all", async () => {
    const stub = stubVision();
    const response = await handleVisionRequest(request(validBody(100)), env());

    expect(response.status).toBe(413);
    expect(stub).not.toHaveBeenCalled();
  });

  it("rejects payloads that are not shaped like a request", async () => {
    stubVision();
    for (const body of [{}, { frames: [] }, { frames: [{}], videoId: "x" }, { frames: [{ batchIndex: 0, frames: "x" }], videoId: "x" }]) {
      const response = await handleVisionRequest(request(body), env());
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("rejects a body that is not JSON", async () => {
    const response = await handleVisionRequest(request("not json"), env());

    expect(response.status).toBe(400);
    expect((await jsonBody(response)).error).toBe("Body is not valid JSON.");
  });
});

describe("per-frame resilience", () => {
  it("keeps the frames that succeeded when one fails", async () => {
    stubVision({ failAt: [1] });
    const response = await handleVisionRequest(request(validBody(3)), env());

    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    // Previously one failure returned 500 and discarded all three.
    expect(body.totalFrames).toBe(2);
    expect(body.failedFrames).toBe(1);
    const descriptions = (
      body.batches as Array<{ descriptions: Array<{ description: string }> }>
    )[0]!.descriptions.map((description) => description.description);
    expect(descriptions).toEqual(["frame 0", "frame 2"]);
  });

  it("reports no failedFrames field when everything worked", async () => {
    stubVision();
    const response = await handleVisionRequest(request(validBody(2)), env());

    expect((await jsonBody(response)).failedFrames).toBeUndefined();
  });

  it("never returns the upstream error body", async () => {
    stubVision({ failAt: [0] });
    const response = await handleVisionRequest(request(validBody(1)), env());
    const text = JSON.stringify(await jsonBody(response));

    expect(text).not.toContain("upstream detail");
  });

  it("keeps a partially valid batch instead of failing the batch", async () => {
    stubVision({ failAt: [2] });
    const response = await handleVisionRequest(request(validBody(4)), env());
    const body = (await jsonBody(response)) as {
      batches: Array<{ descriptions: unknown[] }>;
      failedFrames?: number;
    };

    expect(body.batches[0]!.descriptions).toHaveLength(3);
    expect(body.failedFrames).toBe(1);
  });
});

describe("rate limiting", () => {
  it("allows up to the limit inside the window, then refuses", () => {
    const now = 1_000_000;
    for (let index = 0; index < 3; index += 1) {
      expect(rateLimitAllows("caller", 3, now)).toBe(true);
    }
    expect(rateLimitAllows("caller", 3, now)).toBe(false);
  });

  it("frees the budget once the window passes", () => {
    const now = 1_000_000;
    for (let index = 0; index < 3; index += 1) rateLimitAllows("caller", 3, now);

    expect(rateLimitAllows("caller", 3, now + 60_001)).toBe(true);
  });

  it("tracks callers separately", () => {
    const now = 1_000_000;
    expect(rateLimitAllows("a", 1, now)).toBe(true);
    expect(rateLimitAllows("b", 1, now)).toBe(true);
    expect(rateLimitAllows("a", 1, now)).toBe(false);
  });

  it("is disabled by a zero limit", () => {
    const now = 1_000_000;
    for (let index = 0; index < 5; index += 1) expect(rateLimitAllows("caller", 0, now)).toBe(true);
  });

  it("returns 429 once a caller exhausts its budget", async () => {
    stubVision();
    const withLimit = env({ MAX_REQUESTS_PER_MINUTE: "2" });

    expect((await handleVisionRequest(request(validBody()), withLimit)).status).toBe(200);
    expect((await handleVisionRequest(request(validBody()), withLimit)).status).toBe(200);
    const third = await handleVisionRequest(request(validBody()), withLimit);

    expect(third.status).toBe(429);
  });

  it("keys on the Cloudflare-set client IP, not a spoofable header", async () => {
    stubVision();
    const withLimit = env({ MAX_REQUESTS_PER_MINUTE: "1" });

    await handleVisionRequest(request(validBody(), { "cf-connecting-ip": "1.1.1.1" }), withLimit);
    const other = await handleVisionRequest(
      request(validBody(), { "cf-connecting-ip": "2.2.2.2", "x-forwarded-for": "1.1.1.1" }),
      withLimit,
    );

    expect(other.status).toBe(200);
  });
});

describe("successful response", () => {
  it("labels the response with a correlation id", async () => {
    stubVision();
    const response = await handleVisionRequest(request(validBody()), env());
    const body = (await jsonBody(response)) as {
      videoId: string;
      requestId: string;
      processingTimeMs: number;
    };

    expect(body.videoId).toBe("clip");
    expect(body.requestId).toMatch(/[0-9a-f-]{36}/);
    expect(typeof body.processingTimeMs).toBe("number");
  });
});
