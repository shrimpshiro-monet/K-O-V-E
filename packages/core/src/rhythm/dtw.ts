/** Alignment cost in seconds (or whichever units the inputs use). */
export function dtwDistance(a: readonly number[], b: readonly number[]): { cost: number; path: Array<[number, number]> } {
  if (!a.length && !b.length) return { cost: 0, path: [] };
  if (!a.length || !b.length) return { cost: Infinity, path: [] };
  if (![...a, ...b].every((x) => Number.isFinite(x) && x >= 0)) throw new Error("DTW requires finite nonnegative durations");
  const d = Array.from({ length: a.length + 1 }, () => new Float64Array(b.length + 1).fill(Infinity));
  d[0][0] = 0;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.abs(a[i - 1] - b[j - 1]) + Math.min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1]);
  const path: Array<[number, number]> = [];
  let i = a.length, j = b.length;
  while (i && j) {
    path.push([i - 1, j - 1]);
    const prev = Math.min(d[i - 1][j - 1], d[i - 1][j], d[i][j - 1]);
    if (prev === d[i - 1][j - 1]) { i--; j--; }
    else if (prev === d[i - 1][j]) i--;
    else j--;
  }
  return { cost: d[a.length][b.length] / path.length, path: path.reverse() };
}

export function rhythmSimilarity(reference: readonly number[], candidate: readonly number[]): number {
  if (!reference.length || !candidate.length) return reference.length === candidate.length ? 1 : 0;
  const scale = Math.max(1e-9, ...reference, ...candidate);
  return Math.max(0, 1 - dtwDistance(reference, candidate).cost / scale);
}
