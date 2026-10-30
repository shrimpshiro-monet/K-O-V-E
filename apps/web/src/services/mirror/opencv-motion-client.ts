import type { CameraMotionSample } from "@kove-advanced/core/vision/camera-motion-extractor";

export interface MotionInput {
  prev: Uint8ClampedArray;
  curr: Uint8ClampedArray;
  width: number;
  height: number;
  frame: number;
  scaleX: number;
  scaleY: number;
}

export interface OpenCvMotionClient {
  /** Resolves true once the worker's OpenCV runtime is usable, false on failure. */
  readonly ready: Promise<boolean>;
  /** Always resolves (null on worker failure or timeout): never rejects. */
  sample(input: MotionInput): Promise<CameraMotionSample | null>;
  dispose(): void;
}

let warmClient: OpenCvMotionClient | null = null;

/** Page-wide worker shared by every measurement: OpenCV's Emscripten eval
 * takes far longer than a measurement's head start, so the worker is warmed
 * once at app idle and stays ready. Never disposed (lives with the page). */
export function getWarmOpenCvMotionClient(): OpenCvMotionClient {
  if (!warmClient) warmClient = createOpenCvMotionClient();
  return warmClient;
}

/** Idle boot hook: start loading the OpenCV runtime before any file is attached. */
export function warmOpenCvMotionWorker(): void {
  void getWarmOpenCvMotionClient();
}

/** Bridges the measurement loop to the OpenCV worker. The Emscripten eval and
 * all LK optical flow run off the main thread, so a cold or wedged OpenCV
 * load can never freeze the tab. In environments without Worker (jsdom), the
 * client reports not-ready and callers use the JS matcher. */
export function createOpenCvMotionClient(): OpenCvMotionClient {
  if (typeof Worker === "undefined") {
    return { ready: Promise.resolve(false), sample: async () => null, dispose: () => {} };
  }
  const worker = new Worker(
    new URL("../../workers/opencv-motion-worker.ts", import.meta.url),
    { type: "module" },
  );
  let nextId = 0;
  let disposed = false;
  let readySettled = false;
  const pending = new Map<number, (sample: CameraMotionSample | null) => void>();
  const ready = new Promise<boolean>((resolve) => {
    const settle = (ok: boolean) => {
      if (!readySettled) { readySettled = true; resolve(ok); }
    };
    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as { type?: string; ok?: boolean; id?: number; sample?: CameraMotionSample | null };
      if (message.type === "ready") {
        settle(message.ok === true);
        return;
      }
      if (message.type === "motion" && typeof message.id === "number") {
        const callback = pending.get(message.id);
        if (callback) { pending.delete(message.id); callback(message.sample ?? null); }
      }
    };
    worker.onerror = (event) => {
      console.warn("[kove/mirror] OpenCV motion worker failed:", event.message);
      settle(false);
      for (const callback of pending.values()) callback(null);
      pending.clear();
    };
  });
  worker.postMessage({ type: "init" });
  return {
    ready,
    sample(input: MotionInput) {
      if (disposed) return Promise.resolve(null);
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        // Copies keep the caller's reused frame buffers intact across transfer.
        const prev = input.prev.slice();
        const curr = input.curr.slice();
        worker.postMessage(
          {
            type: "motion", id,
            frame: input.frame, width: input.width, height: input.height,
            scaleX: input.scaleX, scaleY: input.scaleY,
            prev: prev.buffer, curr: curr.buffer,
          },
          [prev.buffer, curr.buffer],
        );
        // A wedged worker degrades to the JS matcher instead of hanging the run.
        setTimeout(() => {
          if (pending.delete(id)) resolve(null);
        }, 10_000);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const callback of pending.values()) callback(null);
      pending.clear();
      worker.terminate();
    },
  };
}
