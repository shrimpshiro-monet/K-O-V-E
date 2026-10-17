export interface GrayImage { width: number; height: number; data: Uint8Array }
/** Global SSIM baseline. Compare same-size rendered frames only; not a semantic similarity model. */
export function ssim(a: GrayImage, b: GrayImage): number {
  if (a.width !== b.width || a.height !== b.height || a.data.length !== a.width * a.height || b.data.length !== b.width * b.height || !a.data.length) throw new Error("SSIM requires matching nonempty images");
  const n = a.data.length;
  let ma = 0, mb = 0, va = 0, vb = 0, cov = 0;
  for (let i = 0; i < n; i++) { ma += a.data[i]; mb += b.data[i]; }
  ma /= n; mb /= n;
  for (let i = 0; i < n; i++) { const x = a.data[i] - ma, y = b.data[i] - mb; va += x*x; vb += y*y; cov += x*y; }
  va /= n; vb /= n; cov /= n;
  const c1 = (0.01 * 255) ** 2, c2 = (0.03 * 255) ** 2;
  return Math.max(-1, Math.min(1, ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma*ma + mb*mb + c1) * (va + vb + c2))));
}
