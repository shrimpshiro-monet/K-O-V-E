import { describe, expect, it, vi } from "vitest";
import { executeTool } from "./executor";
import { HeadlessHost } from "./headless-host";
import { makeProjectWithClip } from "./test-fixtures";
import { getTool } from "./registry";
import type { TimelineFrame, TimelineFrameRequest } from "./host";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

/** Test-only host that pretends to own a compositor. HeadlessHost itself must not. */
class RenderingHost extends HeadlessHost {
  readonly calls: TimelineFrameRequest[] = [];
  constructor(private readonly reply: () => Promise<TimelineFrame | { code: "unsupported_host"; error: string }>) {
    super(makeProjectWithClip());
  }
  override features() {
    return { ...super.features(), renderTimelineFrame: true };
  }
  async renderTimelineFrame(request: TimelineFrameRequest) {
    this.calls.push(request);
    return this.reply();
  }
}
const good = (over: Partial<TimelineFrame> = {}) => async (): Promise<TimelineFrame> => ({
  dataUrl: PNG, mimeType: "image/png", width: 768, height: 432, renderer: "test", ...over,
});

describe("render_timeline_frame", () => {
  it("is strict, read-only, and requires time", () => {
    const t = getTool("render_timeline_frame")!;
    expect(t.strict).toBe(true);
    expect(t.readOnly).toBe(true);
    expect(t.inputSchema.required).toEqual(["time"]);
    expect(t.inputSchema.additionalProperties).toBe(false);
  });

  it("HeadlessHost cannot render: UNSUPPORTED_HOST, no image, and get_capabilities says so", async () => {
    const host = new HeadlessHost(makeProjectWithClip());
    const r = await executeTool("render_timeline_frame", { time: 1 }, host);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("UNSUPPORTED_HOST");
    expect(r.error?.suggestedFix).toMatch(/get_capabilities/);
    expect(r.image).toBeUndefined();
    const caps = await executeTool("get_capabilities", {}, host);
    expect((caps.data as { host: { renderTimelineFrame: boolean } }).host.renderTimelineFrame).toBe(false);
  });

  it("passes the request through with defaults and returns the image", async () => {
    const host = new RenderingHost(good());
    const r = await executeTool("render_timeline_frame", { time: 2.5 }, host);
    expect(r.ok).toBe(true);
    expect(host.calls).toEqual([{ time: 2.5, maxDimension: 768, format: "png" }]);
    expect(r.image).toEqual({ dataUrl: PNG, mimeType: "image/png" });
    expect(r.data).toMatchObject({ time: 2.5, width: 768, height: 432, renderer: "test" });
  });

  it("honours maxDimension and jpeg", async () => {
    const host = new RenderingHost(good({ mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,/9j/4AA=", width: 256, height: 144 }));
    const r = await executeTool("render_timeline_frame", { time: 0, maxDimension: 256, format: "jpeg" }, host);
    expect(r.ok).toBe(true);
    expect(host.calls[0]).toEqual({ time: 0, maxDimension: 256, format: "jpeg" });
  });

  it("rejects bad arguments before touching the host", async () => {
    const host = new RenderingHost(good());
    const bad: Record<string, unknown>[] = [{}, { time: -1 }, { time: 1, maxDimension: 10 }, { time: 1, maxDimension: 4096 }, { time: 1, format: "gif" }, { time: 1, timeSeconds: 1 }];
    for (const args of bad) {
      const r = await executeTool("render_timeline_frame", args, host);
      expect(r.ok, JSON.stringify(args)).toBe(false);
      expect(r.error?.code).toBe("INVALID_PARAMS");
      expect(r.error?.suggestedFix).toBeTruthy();
    }
    expect(host.calls).toHaveLength(0);
  });

  it("rejects a time past the end of the timeline with the valid range", async () => {
    const host = new RenderingHost(good());
    const r = await executeTool("render_timeline_frame", { time: 999 }, host);
    expect(r.error?.code).toBe("INVALID_PARAMS");
    expect(r.error?.suggestedFix).toMatch(/between 0 and 5/);
    expect(host.calls).toHaveLength(0);
  });

  it("a host that answers unsupported_host at call time is reported as UNSUPPORTED_HOST", async () => {
    const host = new RenderingHost(async () => ({ code: "unsupported_host", error: "no GPU" }));
    const r = await executeTool("render_timeline_frame", { time: 1 }, host);
    expect(r.error?.code).toBe("UNSUPPORTED_HOST");
    expect(r.image).toBeUndefined();
  });

  it("refuses a malformed frame instead of passing it on", async () => {
    for (const over of [{ dataUrl: "not-a-data-url" }, { mimeType: "image/jpeg" as const }, { width: 0 }]) {
      const host = new RenderingHost(good(over));
      const r = await executeTool("render_timeline_frame", { time: 1 }, host);
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("RENDER_FAILED");
      expect(r.image).toBeUndefined();
    }
  });

  it("a flag of false wins even if the method exists", async () => {
    const spy = vi.fn();
    class Lying extends HeadlessHost { async renderTimelineFrame() { spy(); return good()(); } }
    const r = await executeTool("render_timeline_frame", { time: 1 }, new Lying(makeProjectWithClip()));
    expect(r.error?.code).toBe("UNSUPPORTED_HOST");
    expect(spy).not.toHaveBeenCalled();
  });
});
