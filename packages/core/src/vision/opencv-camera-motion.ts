import type * as OpenCV from "@techstark/opencv-js";
import type { CameraMotionSample } from "./camera-motion-extractor";

/** This OpenCV distribution exposes LK flow but NOT estimateAffinePartial2D at runtime
 * (although its .d.ts declares it). Fit a partial affine from tracked points below. */
export async function loadOpenCv(): Promise<typeof OpenCV> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const module = await Promise.race([
    import("@techstark/opencv-js"),
    new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("OpenCV import timed out")), 5000); }),
  ]).finally(() => { if (timeout) clearTimeout(timeout); });
  // The runtime has a nonstandard `then` method which never resolves in some environments.
  // Do not await the object itself. Poll actual capabilities with a bounded timeout.
  const cv = module.default as typeof OpenCV;
  for (let i = 0; i < 100; i++) {
    if (typeof cv.Mat === "function" && typeof cv.calcOpticalFlowPyrLK === "function") {
      // An async function assimilates thenables *on return*, too. Hide the
      // nonstandard then method without cloning the large Emscripten runtime.
      return new Proxy(cv, { get(target, key) { return key === "then" ? undefined : Reflect.get(target, key); } });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("OpenCV did not initialize; use the JS motion backend");
}
type PointPair = [number, number, number, number];
function fit(pairs: readonly PointPair[]) {
  const n = pairs.length;
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n, my = pairs.reduce((s, p) => s + p[1], 0) / n;
  const nx = pairs.reduce((s, p) => s + p[2], 0) / n, ny = pairs.reduce((s, p) => s + p[3], 0) / n;
  let den = 0, real = 0, imag = 0;
  for (const [x, y, X, Y] of pairs) {
    const u = x - mx, v = y - my, U = X - nx, V = Y - ny;
    den += u*u + v*v; real += u*U + v*V; imag += u*V - v*U;
  }
  if (den < 1e-6) return null;
  const a = real / den, b = imag / den;
  return { a, b, tx: nx - a*mx + b*my, ty: ny - b*mx - a*my };
}
/** Sparse LK + deterministic two-point RANSAC + least-squares refit. Returns null if not enough tracks. */
export function extractFrameMotion(cv: typeof OpenCV, previous: OpenCV.Mat, current: OpenCV.Mat, frame: number): CameraMotionSample | null {
  const prevPts = new cv.Mat(), nextPts = new cv.Mat(), status = new cv.Mat(), errors = new cv.Mat();
  try {
    cv.goodFeaturesToTrack(previous, prevPts, 200, 0.01, 8);
    if (prevPts.rows < 6) return null;
    cv.calcOpticalFlowPyrLK(previous, current, prevPts, nextPts, status, errors);
    const pairs: PointPair[] = [];
    for (let i = 0; i < status.rows * status.cols; i++) {
      if (status.data[i] !== 1 || errors.data32F[i] >= 30) continue;
      pairs.push([prevPts.data32F[i*2], prevPts.data32F[i*2+1], nextPts.data32F[i*2], nextPts.data32F[i*2+1]]);
    }
    if (pairs.length < 6) return null;
    let best: PointPair[] = [];
    // Fixed pair schedule for reproducible measurement; two tracks determine a similarity transform.
    for (let k = 0; k < Math.min(80, pairs.length * 2); k++) {
      const first = k % pairs.length, second = (first + 1 + (k * 37) % (pairs.length - 1)) % pairs.length;
      const transform = fit([pairs[first], pairs[second]]);
      if (!transform) continue;
      const { a, b, tx, ty } = transform;
      const inliers = pairs.filter(([x, y, X, Y]) => Math.hypot(a*x - b*y + tx - X, b*x + a*y + ty - Y) < 3);
      if (inliers.length > best.length) best = inliers;
    }
    if (best.length < 6) return null;
    const transform = fit(best);
    if (!transform) return null;
    const { a, b, tx, ty } = transform, scale = Math.hypot(a, b);
    if (!Number.isFinite(scale) || scale < 0.75 || scale > 1.25) return null;
    return { frame, translateX: tx, translateY: ty, rotationRad: Math.atan2(b, a), scale };
  } finally { prevPts.delete(); nextPts.delete(); status.delete(); errors.delete(); }
}
