import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callVisionWorker,
  pollAnalysisJob,
  VisionWorkerHttpError,
} from "./frame-extraction";

interface FakeResponse {
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
}

const jsonResponse = (body: unknown, ok = true, status = 200): FakeResponse => ({
  ok,
  status,
  json: async () => body,
});

const DESCRIPTION = {
  timestamp: 1,
  description: "establishing - low motion",
  sceneType: "establishing",
  motionLevel: "low",
  hasDialogue: false,
  confidence: 0.9,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("callVisionWorker", () => {
  it("keeps the legacy sync path for backends that answer with batches", async () => {
    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
      jsonResponse({ batches: [{ batchIndex: 0, descriptions: [DESCRIPTION] }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callVisionWorker("https://worker.example/run", "v1", 10, []);

    expect(result).toEqual([DESCRIPTION]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no polling happened
  });

  it("polls /jobs/{id} when the backend answers with a jobId", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (!url.includes("/jobs/")) {
        return jsonResponse({ jobId: "abc123", status: "pending" });
      }
      // First poll: still running. Second poll: done.
      if (calls.filter((c) => c.includes("/jobs/")).length < 2) {
        return jsonResponse({ status: "running", result: null });
      }
      return jsonResponse({
        status: "completed",
        result: { batches: [{ batchIndex: 0, descriptions: [DESCRIPTION] }] },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await callVisionWorker("http://localhost:8000/analyze-frames", "v1", 10, []);

    expect(result).toEqual([DESCRIPTION]);
    expect(calls[0]).toBe("http://localhost:8000/analyze-frames");
    expect(calls.slice(1)).toEqual([
      "http://localhost:8000/jobs/abc123",
      "http://localhost:8000/jobs/abc123",
    ]);
  }, 10_000);
});

/**
 * A locked-down backend refuses requests that carry no token: the Cloudflare
 * worker answers 503 until `WORKER_AUTH_TOKEN` exists, and the Python engine
 * answers 401 once `KOVE_ENGINE_TOKEN` is set. The client therefore has to send
 * the bearer token on the POST *and* on every job poll — a token that only
 * reached the first request would leave the analysis hanging on a 401.
 */
describe("callVisionWorker authentication", () => {
  const headerOf = (init: RequestInit | undefined): unknown =>
    (init?.headers as Record<string, unknown> | undefined)?.["Authorization"] ??
    (init?.headers as Record<string, unknown> | undefined)?.["authorization"];

  it("sends no Authorization header when no token is configured", async () => {
    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
      jsonResponse({ batches: [{ batchIndex: 0, descriptions: [DESCRIPTION] }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await callVisionWorker("https://worker.example/run", "v1", 10, []);

    expect(headerOf(fetchMock.mock.calls[0]?.[1] as RequestInit)).toBeUndefined();
  });

  it("sends the bearer token with the frames", async () => {
    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
      jsonResponse({ batches: [{ batchIndex: 0, descriptions: [DESCRIPTION] }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await callVisionWorker("https://worker.example/run", "v1", 10, [], {
      authToken: "s3cret",
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ Authorization: "Bearer s3cret" });
    // The content type must survive alongside the token, or the backend rejects
    // the body before it ever looks at the Authorization header.
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
  });

  it("sends the token on every job poll, not just the submit", async () => {
    let posts = 0;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("/jobs/")) {
        posts += 1;
        return jsonResponse({ jobId: "abc123", status: "pending" });
      }
      if (posts === 1 && !headerOf(init)) {
        return jsonResponse({ error: "Unauthorized" }, false, 401);
      }
      return jsonResponse({
        status: "completed",
        result: { batches: [{ batchIndex: 0, descriptions: [DESCRIPTION] }] },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await callVisionWorker(
      "http://localhost:8000/analyze-frames",
      "v1",
      10,
      [],
      { authToken: "s3cret" },
    );

    expect(result).toEqual([DESCRIPTION]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(headerOf(init as RequestInit)).toBe("Bearer s3cret");
    }
  });

  it("ignores a blank token rather than sending an empty bearer", async () => {
    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
      jsonResponse({ batches: [{ batchIndex: 0, descriptions: [DESCRIPTION] }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await callVisionWorker("https://worker.example/run", "v1", 10, [], {
      authToken: "   ",
    });

    expect(headerOf(fetchMock.mock.calls[0]?.[1] as RequestInit)).toBeUndefined();
  });
});

describe("callVisionWorker failures", () => {
  it("reports the status when a locked-down backend refuses the request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "Unauthorized" }, false, 401)),
    );

    await expect(
      callVisionWorker("https://worker.example/run", "v1", 10, []),
    ).rejects.toThrow(/HTTP 401/);
  });

  it("reports 503 for a backend that refuses to serve without a token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: "server_misconfigured" }, false, 503),
      ),
    );

    await expect(
      callVisionWorker("https://worker.example/run", "v1", 10, []),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("carries the status on the error so callers can tell refusal from absence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "Forbidden" }, false, 403)),
    );

    const error = await callVisionWorker(
      "https://worker.example/run",
      "v1",
      10,
      [],
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(VisionWorkerHttpError);
    expect((error as VisionWorkerHttpError).status).toBe(403);
  });

  it("still reports a status when the failure body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        text: async () => "<html>no token configured</html>",
      })),
    );

    await expect(
      callVisionWorker("https://worker.example/run", "v1", 10, []),
    ).rejects.toThrow(/HTTP 503/);
  });
});

describe("pollAnalysisJob", () => {
  it("returns the result once the job completes", async () => {
    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
      jsonResponse({
        status: "completed",
        result: { batches: [{ batchIndex: 0, descriptions: [DESCRIPTION] }] },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollAnalysisJob("http://localhost:8000/jobs/x", {
      pollIntervalMs: 1,
    });
    expect(result.batches[0]?.descriptions).toEqual([DESCRIPTION]);
  });

  it("throws on a failed job", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ status: "failed", result: { error: "boom" } }),
      ),
    );
    await expect(
      pollAnalysisJob("http://localhost:8000/jobs/x", { pollIntervalMs: 1 }),
    ).rejects.toThrow(/failed/i);
  });

  it("throws when the job is unknown (expired/swept)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "unknown", error: "job not found" })),
    );
    await expect(
      pollAnalysisJob("http://localhost:8000/jobs/x", { pollIntervalMs: 1 }),
    ).rejects.toThrow(/not found/i);
  });

  it("throws when a completed job has no usable batches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "completed", result: null })),
    );
    await expect(
      pollAnalysisJob("http://localhost:8000/jobs/x", { pollIntervalMs: 1 }),
    ).rejects.toThrow(/usable result/i);
  });

  it("times out instead of polling forever", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "running", result: null })),
    );
    await expect(
      pollAnalysisJob("http://localhost:8000/jobs/x", {
        pollIntervalMs: 1,
        timeoutMs: 5,
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it("sends the token when polling a locked-down engine", async () => {
    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
      jsonResponse({
        status: "completed",
        result: { batches: [{ batchIndex: 0, descriptions: [DESCRIPTION] }] },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await pollAnalysisJob("http://localhost:8000/jobs/x", {
      pollIntervalMs: 1,
      authToken: "engine-token",
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.headers).toMatchObject({ Authorization: "Bearer engine-token" });
  });

  it("reports a refusal from the poll endpoint with its status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "Unauthorized" }, false, 401)),
    );

    const error = await pollAnalysisJob("http://localhost:8000/jobs/x", {
      pollIntervalMs: 1,
    }).catch((caught: unknown) => caught);

    expect((error as VisionWorkerHttpError).status).toBe(401);
  });

  it("surfaces HTTP failures from the poll endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, false, 500)));
    await expect(
      pollAnalysisJob("http://localhost:8000/jobs/x", { pollIntervalMs: 1 }),
    ).rejects.toThrow(/HTTP 500/);
  });
});
