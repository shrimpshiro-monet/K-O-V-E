import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EngineRequestError,
  engineHealth,
  pollEngineJob,
  submitAnalysisUpload,
} from "./client";

/**
 * Every case here is a failure the frame-worker's original loop reported
 * badly: an HTML error page parsed as JSON, an expired job polled forever,
 * and a timeout with no idea what the job was last doing.
 */

const jobsUrl = "http://localhost:8000/jobs/abc123";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function stubFetch(responses: Array<Response | Error>): string[] {
  const urls: string[] = [];
  let index = 0;
  const fetchMock = vi.fn(
    async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      urls.push(String(input));
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (next instanceof Error) throw next;
      return next;
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("engine client hardening", () => {
  it("surfaces the HTTP status instead of a JSON SyntaxError", async () => {
    stubFetch([
      new Response("<html>Internal Server Error</html>", {
        status: 500,
        headers: { "content-type": "text/html" },
      }),
    ]);

    await expect(pollEngineJob("abc123")).rejects.toThrow(/HTTP 500/);
    await expect(pollEngineJob("abc123")).rejects.toBeInstanceOf(EngineRequestError);
  });

  it("reports the HTTP status on upload failures too", async () => {
    stubFetch([new Response("nope", { status: 500 })]);

    await expect(
      submitAnalysisUpload(new Blob(["x"]), "video-1", "reference"),
    ).rejects.toThrow(/Analysis upload failed: HTTP 500/);
  });

  it("fails with a transport error (not a TypeError) when the engine is down", async () => {
    stubFetch([new Error("fetch failed")]);

    await expect(engineHealth()).rejects.toThrow(/Is the python engine running/);
  });

  it("treats an unknown job status as terminal", async () => {
    stubFetch([jsonResponse({ status: "unknown", result: null })]);

    await expect(pollEngineJob("abc123")).rejects.toThrow(/not found/);
  });

  it("fails a job that reports failure", async () => {
    stubFetch([
      jsonResponse({ status: "failed", result: { error: "decoder exploded" } }),
    ]);

    await expect(pollEngineJob("abc123")).rejects.toThrow(/decoder exploded/);
  });

  it("names the last observed status when the poll times out", async () => {
    stubFetch([jsonResponse({ status: "running", result: null })]);

    await expect(
      pollEngineJob("abc123", {
        pollIntervalMs: 1,
        timeoutMs: 5,
        sleep: async () => {},
        now: (() => {
          let value = 0;
          return () => {
            value += 3;
            return value;
          };
        })(),
      }),
    ).rejects.toThrow(/last status: running/);
  });

  it("returns the completed result and polls the jobs endpoint", async () => {
    const urls = stubFetch([
      jsonResponse({ status: "running", result: null }),
      jsonResponse({ status: "completed", result: { analysisVersion: "1.2.0" } }),
    ]);

    const result = await pollEngineJob<{ analysisVersion: string }>("abc123", {
      pollIntervalMs: 1,
      sleep: async () => {},
    });

    expect(result.analysisVersion).toBe("1.2.0");
    expect(urls).toEqual([jobsUrl, jobsUrl]);
  });

  it("rejects a completed job with no result", async () => {
    stubFetch([jsonResponse({ status: "completed", result: null })]);

    await expect(pollEngineJob("abc123")).rejects.toThrow(/without a result/);
  });

  it("posts multipart fields the upload route requires", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ jobId: "job-1", status: "pending" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const accepted = await submitAnalysisUpload(new Blob(["x"]), "video-1", "reference", {
      baselineFps: 2,
    });

    expect(accepted.jobId).toBe("job-1");
    const init = fetchMock.mock.calls[0]?.[1] as { body: FormData };
    const form = init.body;
    expect(form.get("video_id")).toBe("video-1");
    expect(form.get("role")).toBe("reference");
    expect(form.get("baseline_fps")).toBe("2");
    expect(form.get("file")).toBeInstanceOf(Blob);
  });
});
