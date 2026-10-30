/// <reference lib="webworker" />
import { extractFrameMotion, loadOpenCv } from "@kove-advanced/core/vision/opencv-camera-motion";
import type { CameraMotionSample } from "@kove-advanced/core/vision/camera-motion-extractor";

type Cv = Awaited<ReturnType<typeof loadOpenCv>>;
type CvMat = InstanceType<Cv["Mat"]>;

/** OpenCV.js runs here instead of the main thread: its ~10MB Emscripten eval
 * pegs a thread for seconds, which froze the whole tab during measurement. */

interface MotionRequest {
  type: "motion";
  id: number;
  frame: number;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  prev: ArrayBuffer;
  curr: ArrayBuffer;
}
type WorkerRequest = { type: "init" } | MotionRequest;

interface ReadyResponse { type: "ready"; ok: boolean }
interface MotionResponse { type: "motion"; id: number; sample: CameraMotionSample | null }

let cvPromise: Promise<Cv | null> | null = null;
function ensureCv(): Promise<Cv | null> {
  if (!cvPromise) {
    cvPromise = (async () => {
      // loadOpenCv races a 5s import timeout; the Emscripten eval can outlast
      // it on a cold cache while the import keeps running, so retry briefly.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          return await loadOpenCv();
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
      return null;
    })();
  }
  return cvPromise;
}

function toGray(cv: Cv, rgba: Uint8ClampedArray, width: number, height: number): CvMat {
  const gray = new cv.Mat(height, width, cv.CV_8UC1);
  const data = gray.data;
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.round(rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114);
  }
  return gray;
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === "init") {
    void ensureCv().then((cv) => {
      const response: ReadyResponse = { type: "ready", ok: cv !== null };
      self.postMessage(response);
    });
    return;
  }
  void (async () => {
    const response: MotionResponse = { type: "motion", id: message.id, sample: null };
    try {
      const cv = await ensureCv();
      if (cv) {
        const previousMat = toGray(cv, new Uint8ClampedArray(message.prev), message.width, message.height);
        const currentMat = toGray(cv, new Uint8ClampedArray(message.curr), message.width, message.height);
        try {
          response.sample = extractFrameMotion(cv, previousMat, currentMat, message.frame);
        } finally {
          previousMat.delete();
          currentMat.delete();
        }
        if (response.sample) {
          response.sample.translateX *= message.scaleX;
          response.sample.translateY *= message.scaleY;
        }
      }
    } catch {
      response.sample = null;
    }
    self.postMessage(response);
  })();
};
