import { afterEach, describe, expect, it, vi } from "vitest";
import { callVisionWorker, pollAnalysisJob } from "./frame-extraction";

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
    const fetchMock = vi.fn(async () =>
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

describe("pollAnalysisJob", () => {
  it("returns the result once the job completes", async () => {
    const fetchMock = vi.fn(async () =>
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

  it("surfaces HTTP failures from the poll endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, false, 500)));
    await expect(
      pollAnalysisJob("http://localhost:8000/jobs/x", { pollIntervalMs: 1 }),
    ).rejects.toThrow(/HTTP 500/);
  });
});
