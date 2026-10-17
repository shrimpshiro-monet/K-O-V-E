/** Deterministic sequential conform. Cycle source list by shot; wrap each source
 * to zero only when there is no room for the next whole shot. */
export function allocateSourceRanges(
  durations: readonly number[],
  sources: readonly { id: string; duration: number }[],
): Array<{ mediaId: string; inPoint: number; outPoint: number }> {
  if (!sources.length) throw new Error("At least one source is required");
  const cursors = new Map<string, number>();
  return durations.map((duration, index) => {
    const source = sources[index % sources.length];
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(source.duration) || source.duration + 1e-4 < duration)
      throw new Error(`Source ${source.id} is shorter than shot ${index}`);
    let cursor = cursors.get(source.id) ?? 0;
    if (cursor + duration > source.duration + 1e-4) cursor = 0;
    cursors.set(source.id, cursor + duration);
    return { mediaId: source.id, inPoint: cursor, outPoint: cursor + duration };
  });
}
