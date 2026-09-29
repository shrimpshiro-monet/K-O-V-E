import type { EditPlan } from "@kove-advanced/creation-schema";

export type Word = { start: number; end: number };

export type BeatClip = { startTime: number; inPoint: number; duration: number };

export function timelineBeats(clips: ReadonlyArray<BeatClip>, sourceBeats: readonly number[]): number[] {
  const out = new Set<number>();
  for (const clip of clips) {
    for (const b of sourceBeats) {
      const t = clip.startTime + (b - clip.inPoint);
      if (t >= clip.startTime && t <= clip.startTime + clip.duration) out.add(t);
    }
  }
  return [...out].sort((a, b) => a - b);
}


export function cutTimesFromTimeline(
  tracks: ReadonlyArray<{ type: string; clips: ReadonlyArray<{ startTime: number }> }>,
  eps = 1 / 60,
): number[] {
  const starts = tracks
    .filter(t => t.type === "video")
    .flatMap(t => t.clips.map(c => c.startTime))
    .filter(s => s > eps)
    .sort((a, b) => a - b);
  return starts.filter((s, i) => i === 0 || s - starts[i - 1]! > eps);
}

export function beatError(cuts: number[], beats: number[]) {
  if (!beats.length) return { mean: Infinity, p90: Infinity };
  const errs = cuts
    .map(c => Math.min(...beats.map(b => Math.abs(b - c))))
    .sort((a, b) => a - b);
  return {
    mean: errs.reduce((a, b) => a + b, 0) / (errs.length || 1),
    p90: errs[Math.floor(errs.length * 0.9)] ?? 0,
  };
}

export function midWordCuts(plan: EditPlan, words: Record<string, Word[]>): number {
  const inside = (id: string, t: number) =>
    (words[id] ?? []).some(w => t > w.start + 0.03 && t < w.end - 0.03);
  return plan.segments.reduce(
    (n, s) => n + Number(inside(s.sourceVideoId, s.sourceStartTime)) + Number(inside(s.sourceVideoId, s.sourceEndTime)),
    0,
  );
}

export function snap(t: number, candidates: number[], maxShift = 0.25): number {
  let best = t;
  let bd = maxShift;
  for (const c of candidates) {
    const d = Math.abs(c - t);
    if (d <= bd) {
      best = c;
      bd = d;
    }
  }
  return best;
}

export async function pairwise<F>(
  judge: (a: F, b: F) => Promise<"A" | "B" | "tie">,
  a: F,
  b: F,
): Promise<number> {
  const [r1, r2] = await Promise.all([judge(a, b), judge(b, a)]);
  const s = (r: string, win: string) => (r === win ? 1 : r === "tie" ? 0.5 : 0);
  return (s(r1, "A") + s(r2, "B")) / 2;
}
