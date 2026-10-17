import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionHistory } from "./action-history";
import { keepRateForActionType } from "./local-preferences";
afterEach(() => { vi.useRealTimers(); });
describe("session-local taste hook", () => {
  it("counts quick undo but not a delayed undo as an immediate rejection", () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const history = new ActionHistory();
    const type = "taste/quick-undo-test";
    const act = (id: string) => ({ id, type, timestamp: Date.now(), params: {} });
    history.push(act("one"), act("inverse-one"));
    vi.advanceTimersByTime(2000);
    history.undo();
    expect(keepRateForActionType(type)).toBeCloseTo(1 / 3);
    history.push(act("two"), act("inverse-two"));
    vi.advanceTimersByTime(9000);
    history.push({ ...act("three"), type: "taste/other-action" });
    expect(keepRateForActionType(type)).toBeCloseTo(0.5);
  });
});
