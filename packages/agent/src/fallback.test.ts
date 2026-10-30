import { describe, expect, it, vi } from "vitest";
import { makeFallbackClient } from "./fallback";
import type { LLMClient, LLMTurnInput, LLMResponse } from "./llm";

const input: LLMTurnInput = {
  system: "edit the video",
  messages: [{ role: "user", content: "trim the intro" }],
  tools: [{ type: "function", function: { name: "a", arguments: "{}" } }],
};

const response = (text: string): LLMResponse => ({
  text,
  toolUses: [],
  stopReason: "end_turn",
});

function client(impl: (input: LLMTurnInput) => Promise<LLMResponse>): LLMClient {
  return { complete: impl };
}

describe("makeFallbackClient", () => {
  it("serves from the primary and never touches the secondary", async () => {
    const primary = vi.fn(async () => response("from-primary"));
    const secondary = vi.fn(async () => response("from-secondary"));
    const llm = makeFallbackClient({ primary: client(primary), secondary: client(secondary) });

    await expect(llm.complete(input)).resolves.toMatchObject({ text: "from-primary" });
    expect(secondary).not.toHaveBeenCalled();
  });

  it("replays the same turn on the secondary when the primary fails", async () => {
    const primary = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const secondary = vi.fn(async () => response("from-secondary"));
    const onFallback = vi.fn();
    const llm = makeFallbackClient({
      primary: client(primary),
      secondary: client(secondary),
      onFallback,
    });

    await expect(llm.complete(input)).resolves.toMatchObject({ text: "from-secondary" });
    expect(secondary).toHaveBeenCalledWith(input);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback.mock.calls[0][0]).toBeInstanceOf(TypeError);
  });

  it("cools the primary down after a failure instead of re-paying it every call", async () => {
    let clock = 1_000;
    const now = (): number => clock;
    const primary = vi.fn(async () => {
      throw new TypeError("gateway down");
    });
    const secondary = vi.fn(async () => response("from-secondary"));
    const llm = makeFallbackClient({
      primary: client(primary),
      secondary: client(secondary),
      cooldownMs: 60_000,
      now,
    });

    await llm.complete(input);
    clock += 30_000;
    await llm.complete(input);
    expect(primary).toHaveBeenCalledTimes(1);
    expect(secondary).toHaveBeenCalledTimes(2);

    // After the window the ladder probes the primary again.
    clock += 31_000;
    await llm.complete(input);
    expect(primary).toHaveBeenCalledTimes(2);
  });

  it("rethrows a user abort instead of burning the secondary", async () => {
    const abort = new DOMException("Aborted", "AbortError");
    const primary = vi.fn(async () => {
      throw abort;
    });
    const secondary = vi.fn(async () => response("from-secondary"));
    const onFallback = vi.fn();
    const llm = makeFallbackClient({
      primary: client(primary),
      secondary: client(secondary),
      onFallback,
    });

    await expect(llm.complete(input)).rejects.toBe(abort);
    expect(secondary).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("adapts the replayed input for the secondary side only", async () => {
    const primary = vi.fn(async (_input: LLMTurnInput) => {
      throw new TypeError("gateway down");
    });
    const seen: LLMTurnInput[] = [];
    const secondary = client(async (replayed) => {
      seen.push(replayed);
      return response("from-secondary");
    });
    const llm = makeFallbackClient({
      primary: client(primary),
      secondary,
      secondaryInput: (replayed) => ({ ...replayed, tools: [] }),
    });

    await llm.complete(input);
    expect(seen).toHaveLength(1);
    expect(seen[0].tools).toEqual([]);
    expect(seen[0].system).toBe("edit the video");
    // The primary always sees the untouched input.
    expect(primary.mock.calls[0][0]).toEqual(input);
  });

  it("surfaces the secondary's error unchanged so provider-specific handling survives", async () => {
    const quota = Object.assign(new Error("cloudflare-ai 429: daily free allocation"), {
      status: 429,
      name: "LLMHttpError",
    });
    const primary = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const secondary = vi.fn(async () => {
      throw quota;
    });
    const llm = makeFallbackClient({ primary: client(primary), secondary: client(secondary) });

    await expect(llm.complete(input)).rejects.toBe(quota);
  });

  it("keeps a healthy primary across calls (no cooldown without failure)", async () => {
    const primary = vi.fn(async () => response("from-primary"));
    const secondary = vi.fn(async () => response("from-secondary"));
    const llm = makeFallbackClient({ primary: client(primary), secondary: client(secondary) });

    await llm.complete(input);
    await llm.complete(input);
    expect(primary).toHaveBeenCalledTimes(2);
    expect(secondary).not.toHaveBeenCalled();
  });

  it("falls through to the tertiary when the secondary also fails", async () => {
    const primary = vi.fn(async () => {
      throw new TypeError("gateway down");
    });
    const secondary = vi.fn(async () => {
      throw new TypeError("workers down");
    });
    const tertiary = vi.fn(async () => response("from-nim"));
    const onFallback = vi.fn();
    const llm = makeFallbackClient({
      primary: client(primary),
      secondary: client(secondary),
      tertiary: client(tertiary),
      onFallback,
    });

    await expect(llm.complete(input)).resolves.toMatchObject({ text: "from-nim" });
    expect(tertiary).toHaveBeenCalledWith(input);
    expect(onFallback).toHaveBeenCalledTimes(2);
    expect(onFallback.mock.calls[0][1]).toBe("primary");
    expect(onFallback.mock.calls[1][1]).toBe("secondary");
  });

  it("rethrows when the tertiary also fails", async () => {
    const primary = vi.fn(async () => {
      throw new TypeError("gateway down");
    });
    const secondary = vi.fn(async () => {
      throw new TypeError("workers down");
    });
    const tertiary = vi.fn(async () => {
      throw new Error("nim down");
    });
    const llm = makeFallbackClient({
      primary: client(primary),
      secondary: client(secondary),
      tertiary: client(tertiary),
    });

    await expect(llm.complete(input)).rejects.toThrow("nim down");
  });
});
