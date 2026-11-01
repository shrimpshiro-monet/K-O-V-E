import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForExportStage } from "./export-watchdog";

describe("export stage watchdog", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("returns a completed operation and removes its timer", async () => {
    vi.useFakeTimers();
    await expect(waitForExportStage(Promise.resolve(42), "encoding", undefined, 1000)).resolves.toBe(42);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails a stalled operation with a useful stage and timeout", async () => {
    vi.useFakeTimers();
    const result = waitForExportStage(new Promise(() => {}), "finalizing the video file", undefined, 5000);
    const assertion = expect(result).rejects.toMatchObject({
      name: "TimeoutError",
      message: expect.stringContaining("finalizing the video file for 5 seconds"),
    });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts promptly even when the underlying codec never settles", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const result = waitForExportStage(new Promise(() => {}), "encoding", controller.signal);
    const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles an already aborted signal and observes a late rejection", async () => {
    const controller = new AbortController();
    controller.abort();
    let rejectOperation!: (error: Error) => void;
    const operation = new Promise<void>((_resolve, reject) => { rejectOperation = reject; });
    await expect(waitForExportStage(operation, "encoding", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    rejectOperation(new Error("late codec failure"));
    await Promise.resolve();
  });
});
