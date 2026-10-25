import { describe, expect, it, vi } from "vitest";
import {
  abortError,
  abortable,
  analysisDimensions,
  createReferenceProgressReporter,
  createWorkBudget,
  isAbortError,
  throwIfAborted,
  REFERENCE_ANALYSIS_MAX_DIMENSION,
  REFERENCE_FRAME_BUDGET_MS,
  REFERENCE_PROGRESS_INTERVAL_MS,
} from "./reference-measurement";

describe("analysisDimensions", () => {
  it("caps the long edge instead of following the source resolution", () => {
    // 4K, 1440p and 1080p all cost the same per sampled frame.
    for (const [sourceWidth, sourceHeight] of [[3840, 2160], [2560, 1440], [1920, 1080]]) {
      expect(analysisDimensions(sourceWidth, sourceHeight)).toEqual({ width: 160, height: 90 });
    }
  });

  it("keeps the source aspect ratio for portrait footage", () => {
    expect(analysisDimensions(1080, 1920)).toEqual({ width: 90, height: 160 });
    expect(analysisDimensions(3840, 2160)).toEqual({ width: 160, height: 90 });
  });

  it("leaves footage that is already small untouched and keeps dimensions even", () => {
    expect(analysisDimensions(96, 54)).toEqual({ width: 96, height: 54 });
    const portrait = analysisDimensions(607, 1080);
    expect(portrait.height % 2).toBe(0);
    expect(portrait.width % 2).toBe(0);
    expect(Math.max(portrait.width, portrait.height)).toBeLessThanOrEqual(REFERENCE_ANALYSIS_MAX_DIMENSION);
  });

  it("honours an explicit cap and never goes below a usable size", () => {
    expect(analysisDimensions(3840, 2160, 64)).toEqual({ width: 64, height: 36 });
    // An extreme aspect ratio still yields at least one 16px block.
    expect(analysisDimensions(10000, 20).height).toBe(16);
  });

  it("rejects unusable input rather than producing a zero-sized buffer", () => {
    expect(() => analysisDimensions(0, 1080)).toThrow(RangeError);
    expect(() => analysisDimensions(Number.NaN, 1080)).toThrow(RangeError);
    expect(() => analysisDimensions(1920, 1080, 4)).toThrow(RangeError);
  });
});

describe("createWorkBudget", () => {
  it("expires after the budget and restarts on reset", () => {
    const budget = createWorkBudget(8, 1_000);
    expect(budget.budgetMs).toBe(8);
    expect(budget.expired(1_004)).toBe(false);
    expect(budget.expired(1_008)).toBe(true);
    budget.reset(2_000);
    expect(budget.expired(2_006)).toBe(false);
    expect(budget.expired(2_100)).toBe(true);
  });

  it("falls back to the documented budget for nonsense values", () => {
    expect(createWorkBudget(Number.NaN, 0).budgetMs).toBe(REFERENCE_FRAME_BUDGET_MS);
    expect(createWorkBudget(-5, 0).budgetMs).toBe(REFERENCE_FRAME_BUDGET_MS);
  });
});

describe("createReferenceProgressReporter", () => {
  it("emits the first sample immediately and then at most four notices per second", () => {
    let clock = 0;
    const notices: Array<[number, number]> = [];
    const reporter = createReferenceProgressReporter(
      (done, total) => notices.push([done, total]),
      REFERENCE_PROGRESS_INTERVAL_MS,
      () => clock,
    );

    // 1000ms of measurement, reporting after every 10ms of work.
    for (let i = 1; i <= 100; i++) {
      clock += 10;
      reporter.report(i, 100);
    }

    expect(notices[0]).toEqual([1, 100]);
    expect(notices.length).toBeGreaterThanOrEqual(4);
    expect(notices.length).toBeLessThanOrEqual(6);
  });

  it("never repeats a sample and never goes backwards", () => {
    let clock = 0;
    const notices: number[] = [];
    const reporter = createReferenceProgressReporter((done) => notices.push(done), 250, () => clock);
    reporter.report(5, 10);
    clock += 300;
    reporter.report(5, 10);
    clock += 300;
    reporter.report(4, 10);
    clock += 300;
    reporter.report(9, 10);

    expect(notices).toEqual([5, 9]);
  });

  it("forces the final notice even inside the throttle window", () => {
    let clock = 0;
    const notices: number[] = [];
    const reporter = createReferenceProgressReporter((done) => notices.push(done), 250, () => clock);
    reporter.report(1, 10);
    clock += 10;
    reporter.report(2, 10);
    reporter.report(10, 10, { force: true });

    expect(notices).toEqual([1, 10]);
    expect(reporter.reported).toBe(10);
  });

  it("tracks progress without a listener and tolerates a nonsense interval", () => {
    const reporter = createReferenceProgressReporter(undefined, Number.NaN);
    expect(() => reporter.report(3, 10)).not.toThrow();
    expect(reporter.reported).toBe(3);
  });
});

describe("cancellation helpers", () => {
  it("throws a normalized AbortError only once the signal aborts", () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(undefined)).not.toThrow();
    expect(() => throwIfAborted(controller.signal)).not.toThrow();

    controller.abort();
    let caught: unknown;
    try {
      throwIfAborted(controller.signal);
    } catch (error) {
      caught = error;
    }
    expect(isAbortError(caught)).toBe(true);
    expect((caught as Error).message).toMatch(/cancelled/i);
  });

  it("keeps an explicit cancel reason in the message", () => {
    const controller = new AbortController();
    controller.abort("Stopped by the user");
    expect(abortError(controller.signal).message).toBe("Stopped by the user");
    expect(isAbortError(new Error("not a cancel"))).toBe(false);
  });

  it("settles a pending decode as soon as the signal aborts", async () => {
    const controller = new AbortController();
    const pending = new Promise<string>(() => {});
    const raced = abortable(pending, controller.signal);
    controller.abort();

    const error = await raced.catch((reason: unknown) => reason);
    expect(isAbortError(error)).toBe(true);
  });

  it("passes through values and real failures, and drops the abort listener", async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    await expect(abortable(Promise.resolve(7), controller.signal)).resolves.toBe(7);
    await expect(abortable(Promise.reject(new Error("decode failed")), controller.signal)).rejects.toThrow(
      "decode failed",
    );
    expect(removeListener).toHaveBeenCalled();
    expect(abortable(Promise.resolve(1), undefined)).resolves.toBe(1);
  });

  it("rejects an already-aborted signal without waiting for the promise", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await abortable(new Promise<void>(() => {}), controller.signal).catch(
      (reason: unknown) => reason,
    );
    expect(isAbortError(error)).toBe(true);
  });
});
