import { describe, it, expect, vi, afterEach } from "vitest";
import { withRetry, LLMHttpError, llmHttpError, parseRetryAfterMs, LLMNetworkError } from "./llm";

const noSleep = async (): Promise<void> => {};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfterMs("5")).toBe(5000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });
  it("returns undefined for missing/garbage", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("soon")).toBeUndefined();
  });
});

describe("withRetry Retry-After", () => {
  it("waits at least the Retry-After when it exceeds the computed backoff", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const sleeps: number[] = [];
    const send = vi
      .fn()
      .mockRejectedValueOnce(new LLMHttpError("rate limited", 429, 5000))
      .mockResolvedValueOnce("ok");
    const wrapped = withRetry(send, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await expect(wrapped({})).resolves.toBe("ok");
    expect(sleeps[0]).toBe(5000);
  });
});

describe("withRetry", () => {
  it("retries on 429 then succeeds", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new LLMHttpError("rate limited", 429))
      .mockResolvedValueOnce({ ok: true });
    const wrapped = withRetry(send, { sleep: noSleep });
    await expect(wrapped({})).resolves.toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("retries on 5xx", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new LLMHttpError("boom", 503))
      .mockResolvedValueOnce("ok");
    const wrapped = withRetry(send, { sleep: noSleep });
    await expect(wrapped({})).resolves.toBe("ok");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 4xx (except 429)", async () => {
    const send = vi.fn().mockRejectedValue(new LLMHttpError("bad request", 400));
    const wrapped = withRetry(send, { sleep: noSleep });
    await expect(wrapped({})).rejects.toThrow("bad request");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry budget", async () => {
    const send = vi.fn().mockRejectedValue(new LLMHttpError("rate limited", 429));
    const wrapped = withRetry(send, { sleep: noSleep, retries: 2 });
    await expect(wrapped({})).rejects.toThrow("rate limited");
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-HTTP errors", async () => {
    const send = vi.fn().mockRejectedValue(new Error("network"));
    const wrapped = withRetry(send, { sleep: noSleep });
    await expect(wrapped({})).rejects.toThrow("network");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries transport-level network failures (no answer ever came back)", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new LLMNetworkError("proxy down"))
      .mockResolvedValueOnce("ok");
    const wrapped = withRetry(send, { sleep: noSleep });
    await expect(wrapped({})).resolves.toBe("ok");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("gives up on network failures after the retry budget", async () => {
    const send = vi.fn().mockRejectedValue(new LLMNetworkError("proxy down"));
    const wrapped = withRetry(send, { sleep: noSleep, retries: 1 });
    await expect(wrapped({})).rejects.toThrow("proxy down");
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("quota errors", () => {
  const quotaBody = JSON.stringify({
    success: false,
    errors: [
      {
        code: 4006,
        message: "you have used up your daily free allocation of 10,000 neurons",
      },
    ],
  });

  it("parses the upstream code out of the error body", () => {
    expect(llmHttpError("cloudflare-ai", 429, quotaBody).code).toBe(4006);
    expect(llmHttpError("cloudflare-ai", 429, "not json").code).toBeUndefined();
    expect(llmHttpError("cloudflare-ai", 500, '{"errors":[]}').code).toBeUndefined();
  });

  it("does not retry a spent daily allocation", async () => {
    const send = vi
      .fn()
      .mockRejectedValue(llmHttpError("cloudflare-ai", 429, quotaBody));
    const wrapped = withRetry(send, { sleep: noSleep });

    await expect(wrapped({})).rejects.toMatchObject({ status: 429, code: 4006 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("still retries an ordinary 429", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(llmHttpError("cloudflare-ai", 429, '{"errors":[{"code":4211}]}'))
      .mockResolvedValueOnce("ok");
    const wrapped = withRetry(send, { sleep: noSleep });

    await expect(wrapped({})).resolves.toBe("ok");
    expect(send).toHaveBeenCalledTimes(2);
  });
});
