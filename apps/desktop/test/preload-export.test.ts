import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const mocks = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), emitter: null as unknown as EventEmitter }));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: {
    invoke: mocks.invoke,
    on: (...args: Parameters<EventEmitter["on"]>) => mocks.emitter.on(...args),
    removeListener: (...args: Parameters<EventEmitter["removeListener"]>) => mocks.emitter.removeListener(...args),
  },
  webUtils: {},
}));

import { CHANNELS } from "../src/shared/channels";

type ExportBridge = { export: { start(args: unknown): Promise<{ jobId: string }> } };

describe("preload native export startup", () => {
  let bridge: ExportBridge;
  let postMessage: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.emitter = new EventEmitter();
    postMessage = vi.fn();
    vi.stubGlobal("window", { postMessage });
    await import("../src/preload/index");
    bridge = mocks.expose.mock.calls.find((call) => call[0] === "kove-advanced")![1] as ExportBridge;
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("rejects and removes the listener when the main process rejects startup", async () => {
    mocks.invoke.mockRejectedValue(new Error("encoder unavailable"));
    await expect(bridge.export.start({ codec: "vp9" })).rejects.toThrow("encoder unavailable");
    expect(mocks.emitter.listenerCount("kove-advanced:export-port")).toBe(0);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("correlates concurrent requests instead of transferring the wrong port", async () => {
    mocks.invoke.mockResolvedValueOnce({ jobId: "job-1" }).mockResolvedValueOnce({ jobId: "job-2" });
    const first = bridge.export.start({ codec: "h264" });
    const second = bridge.export.start({ codec: "vp9" });
    const firstRequest = mocks.invoke.mock.calls[0][1].requestId as string;
    const secondRequest = mocks.invoke.mock.calls[1][1].requestId as string;
    expect(firstRequest).not.toBe(secondRequest);
    const port1 = { close: vi.fn() };
    const port2 = { close: vi.fn() };
    mocks.emitter.emit("kove-advanced:export-port", { ports: [port2] }, { requestId: secondRequest, jobId: "job-2" });
    mocks.emitter.emit("kove-advanced:export-port", { ports: [port1] }, { requestId: firstRequest, jobId: "job-1" });
    await expect(first).resolves.toEqual({ jobId: "job-1" });
    await expect(second).resolves.toEqual({ jobId: "job-2" });
    expect(postMessage.mock.calls.map((call) => call[0].jobId)).toEqual(["job-2", "job-1"]);
    expect(mocks.emitter.listenerCount("kove-advanced:export-port")).toBe(0);
  });

  it("times out and cancels a main-process job that never supplies its port", async () => {
    vi.useFakeTimers();
    mocks.invoke.mockImplementation((channel: string) => channel === CHANNELS.exportStart
      ? Promise.resolve({ jobId: "late-job" }) : Promise.resolve());
    const pending = bridge.export.start({});
    const assertion = expect(pending).rejects.toThrow(/Timed out/);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(mocks.invoke).toHaveBeenCalledWith(CHANNELS.exportCancel, { jobId: "late-job" });
    expect(mocks.emitter.listenerCount("kove-advanced:export-port")).toBe(0);
  });

  it("cancels a job when transferring its port fails", async () => {
    mocks.invoke.mockResolvedValue({ jobId: "job-1" });
    postMessage.mockImplementation(() => { throw new Error("transfer failed"); });
    const pending = bridge.export.start({});
    const assertion = expect(pending).rejects.toThrow("transfer failed");
    const requestId = mocks.invoke.mock.calls[0][1].requestId as string;
    const port = { close: vi.fn() };
    mocks.emitter.emit("kove-advanced:export-port", { ports: [port] }, { requestId, jobId: "job-1" });
    await assertion;
    expect(port.close).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(CHANNELS.exportCancel, { jobId: "job-1" });
    expect(mocks.emitter.listenerCount("kove-advanced:export-port")).toBe(0);
  });
});
