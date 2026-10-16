import Color from "colorjs.io";
/** CIE Lab D50 statistics; the profile contains numbers, never source pixels. */
export interface LabStats { lMean: number; lStd: number; aMean: number; aStd: number; bMean: number; bStd: number }
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const linear = (v: number) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const gamma = (v: number) => v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
// Bradford-adapted sRGB D65 -> XYZ D50, then CIE 1976 Lab.
function toLab(r: number, g: number, b: number): [number, number, number] {
  const [R, G, B] = [linear(r), linear(g), linear(b)];
  const x = (0.4360747 * R + 0.3850649 * G + 0.1430804 * B) / 0.96422;
  const y = 0.2225045 * R + 0.7168786 * G + 0.0606169 * B;
  const z = (0.0139322 * R + 0.0971045 * G + 0.7141733 * B) / 0.82521;
  const f = (t: number) => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
function fromLab(l: number, a: number, b: number): [number, number, number] {
  const fy = (l + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (v: number) => v ** 3 > 216 / 24389 ? v ** 3 : (116 * v - 16) / (24389 / 27);
  const X = inv(fx) * 0.96422, Y = inv(fy), Z = inv(fz) * 0.82521;
  return [
    clamp(gamma(3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z)),
    clamp(gamma(-0.9787684 * X + 1.9161415 * Y + 0.033454 * Z)),
    clamp(gamma(0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z)),
  ];
}
export function computeLabStats(rgba: Uint8ClampedArray): LabStats {
  if (rgba.length === 0 || rgba.length % 4) throw new Error("Expected nonempty RGBA pixels");
  const sum = [0, 0, 0], squares = [0, 0, 0];
  const n = rgba.length / 4;
  for (let i = 0; i < rgba.length; i += 4) {
    const lab = toLab(rgba[i] / 255, rgba[i + 1] / 255, rgba[i + 2] / 255);
    for (let c = 0; c < 3; c++) { sum[c] += lab[c]; squares[c] += lab[c] ** 2; }
  }
  const mean = sum.map((v) => v / n), std = squares.map((v, c) => Math.sqrt(Math.max(0, v / n - mean[c] ** 2)));
  return { lMean: mean[0], lStd: std[0], aMean: mean[1], aStd: std[1], bMean: mean[2], bStd: std[2] };
}
export function applyReinhardTransfer(rgba: Uint8ClampedArray, ref: LabStats, target: LabStats): Uint8ClampedArray {
  if (rgba.length % 4) throw new Error("Expected RGBA pixels");
  const out = new Uint8ClampedArray(rgba.length);
  const from = [target.lMean, target.aMean, target.bMean], to = [ref.lMean, ref.aMean, ref.bMean];
  const srcStd = [target.lStd, target.aStd, target.bStd], dstStd = [ref.lStd, ref.aStd, ref.bStd];
  for (let i = 0; i < rgba.length; i += 4) {
    const lab = toLab(rgba[i] / 255, rgba[i + 1] / 255, rgba[i + 2] / 255);
    const rgb = fromLab(...(lab.map((v, c) => (v - from[c]) * (srcStd[c] < 1e-6 || dstStd[c] < 1e-6 ? 1 : dstStd[c] / srcStd[c]) + to[c]) as [number, number, number]));
    for (let c = 0; c < 3; c++) out[i + c] = Math.round(rgb[c] * 255);
    out[i + 3] = rgba[i + 3];
  }
  return out;
}
/** RGB 3D LUT for the existing clip grading pipeline; generated once, not per render pixel. */
export function createReinhardLut(ref: LabStats, target: LabStats, size = 17): { data: number[]; size: number; intensity: number } {
  if (!Number.isInteger(size) || size < 2 || size > 33) throw new Error("Invalid LUT size");
  const input = new Uint8ClampedArray(size ** 3 * 4);
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const i = ((b * size + g) * size + r) * 4;
    input[i] = Math.round(r * 255 / (size - 1));
    input[i + 1] = Math.round(g * 255 / (size - 1));
    input[i + 2] = Math.round(b * 255 / (size - 1));
    input[i + 3] = 255;
  }
  const data: number[] = [];
  const from = [target.lMean, target.aMean, target.bMean], to = [ref.lMean, ref.aMean, ref.bMean];
  const srcStd = [target.lStd, target.aStd, target.bStd], dstStd = [ref.lStd, ref.aStd, ref.bStd];
  for (let i = 0; i < input.length; i += 4) {
    // ColorJS is used for the once-per-shot LUT bake; full-frame stats/transfer use
    // the optimized D50 math above rather than millions of Color objects per frame.
    const lab = new Color("srgb", [input[i]/255, input[i+1]/255, input[i+2]/255]).to("lab");
    const coords = lab.coords.map((v, c) => (v - from[c]) * (srcStd[c] < 1e-6 || dstStd[c] < 1e-6 ? 1 : dstStd[c] / srcStd[c]) + to[c]);
    const rgb = new Color("lab", coords as [number, number, number]).to("srgb").coords;
    data.push(...rgb.map((v) => Math.round(clamp(v) * 255)));
  }
  return { data, size, intensity: 1 };
}
