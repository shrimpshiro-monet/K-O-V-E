/** Frame-to-frame camera transform; translations are pixels at the analysis resolution. */
export interface CameraMotionSample { frame: number; translateX: number; translateY: number; rotationRad: number; scale: number }
export interface CameraMotionCurve { samples: CameraMotionSample[]; dominantMove: "static" | "pan" | "tilt" | "push" | "pull" | "handheld" | "orbit" }
export function classifyDominantMove(samples: readonly CameraMotionSample[]): CameraMotionCurve["dominantMove"] {
  if (!samples.length) return "static";
  const avg = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  const xs = samples.map((s) => s.translateX), ys = samples.map((s) => s.translateY);
  const jitter = (values: number[]) => Math.sqrt(avg(values.map((v) => (v - avg(values)) ** 2)));
  if (jitter(xs) + jitter(ys) > 4) return "handheld";
  if (Math.abs(avg(samples.map((s) => s.rotationRad))) > 0.01) return "orbit";
  const scale = avg(samples.map((s) => s.scale));
  if (scale > 1.01) return "push";
  if (scale < 0.99) return "pull";
  if (Math.abs(avg(xs)) > 0.5) return "pan";
  if (Math.abs(avg(ys)) > 0.5) return "tilt";
  return "static";
}

// Optional OpenCV backend lives in a separate module so importing the move
// classifier never downloads the OpenCV runtime.
export { extractFrameMotion, loadOpenCv } from "./opencv-camera-motion";
