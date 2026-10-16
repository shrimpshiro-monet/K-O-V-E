/** Session-local aggregate only: never saves media, text, project state or action parameters. */
const counts = new Map<string, { kept: number; undone: number }>();
export function recordLocalPreference(type: string, kept: boolean): void {
  const entry = counts.get(type) ?? { kept: 0, undone: 0 };
  if (kept) entry.kept++; else entry.undone++;
  counts.set(type, entry);
}
export function keepRateForActionType(type: string): number {
  const entry = counts.get(type);
  // Laplace prior avoids extreme bias from a single undo.
  return entry ? (entry.kept + 1) / (entry.kept + entry.undone + 2) : 0.5;
}
