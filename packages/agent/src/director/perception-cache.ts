import type {
  MediaItem,
  PerceptionCache,
  PerceptionCacheEntry,
  Project,
} from "@kove-advanced/core/types/project";
import type { SegmentMap } from "@kove-advanced/creation-schema";

/**
 * Perception cache helpers.
 *
 * Frame sampling + vision analysis (extract_segments) is the most expensive
 * part of an AI editing session — and behind the §2 gateway every vision
 * call is a billed LLM call. The analysis is a pure function of the media
 * content, so it is cached ON the project (`project.perceptionCache`,
 * mirroring the directorPlanState pattern) and reused:
 *
 *  - `extract_segments` returns cached perception for unchanged media
 *    (and reports the hit) instead of re-sampling / re-visioning.
 *  - `plan_edit` resolves a segmentMap from the cache when the LLM did not
 *    pass one, instead of degrading to the metadata-only fallback.
 *
 * Identity: an entry is valid only while the media's fingerprint matches —
 * a hash of the fields that identify the file (id, name, size, lastModified,
 * duration, resolution, frame rate). Replace or re-import the file and the
 * fingerprint changes, so stale perception can never drive a plan.
 */

const VERSION = 1;

/** FNV-1a over the media identity — collision risk irrelevant for cache keys. */
export function mediaFingerprint(media: MediaItem): string {
  const m = media as MediaItem & { sourceFile?: { name?: string; size?: number; lastModified?: number } };
  const parts = [
    media.id ?? "",
    media.name ?? "",
    m.sourceFile?.size ?? media.metadata?.fileSize ?? 0,
    m.sourceFile?.lastModified ?? 0,
    media.metadata?.duration ?? 0,
    media.metadata?.fileSize ?? 0,
    media.metadata?.width ?? 0,
    media.metadata?.height ?? 0,
    media.metadata?.frameRate ?? 0,
    media.analysisRole ?? "",
  ];
  const json = parts.join("\u0001");
  let hash = 2166136261;
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fp-${(hash >>> 0).toString(36)}-${json.length.toString(36)}`;
}

function isValidCache(cache: unknown): cache is PerceptionCache {
  if (!cache || typeof cache !== "object") return false;
  const candidate = cache as PerceptionCache;
  return (
    candidate.version === VERSION &&
    !!candidate.entries &&
    typeof candidate.entries === "object"
  );
}

function isValidEntry(entry: unknown): entry is PerceptionCacheEntry {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as PerceptionCacheEntry;
  return (
    typeof candidate.fingerprint === "string" &&
    candidate.fingerprint.length > 0 &&
    typeof candidate.capturedAtMs === "number" &&
    typeof candidate.frameCount === "number"
  );
}

/** Returns the project's perception cache, initializing it lazily in place. */
export function getPerceptionCache(project: Project): PerceptionCache {
  const existing = project.perceptionCache;
  if (existing && isValidCache(existing)) return existing;
  const cache: PerceptionCache = { version: VERSION, entries: {} };
  (project as { perceptionCache?: PerceptionCache }).perceptionCache = cache;
  return cache;
}

/**
 * The cached entry for `media`, or null when absent OR stale (fingerprint
 * mismatch — the file changed since it was analyzed).
 */
export function freshEntry(project: Project, media: MediaItem): PerceptionCacheEntry | null {
  const entry = getPerceptionCache(project).entries[media.id];
  if (!entry || !isValidEntry(entry)) return null;
  if (entry.fingerprint !== mediaFingerprint(media)) return null;
  return entry;
}

/** Stores entries keyed by media id (one call per analysis run). */
export function setPerceptionEntries(
  project: Project,
  entries: ReadonlyArray<{ media: MediaItem; entry: PerceptionCacheEntry }>,
): void {
  const cache = getPerceptionCache(project);
  for (const { media, entry } of entries) {
    cache.entries[media.id] = entry;
  }
}

/** Drops entries for media no longer in the library (cheap housekeeping). */
export function pruneStaleEntries(project: Project): void {
  const cache = getPerceptionCache(project);
  const ids = new Set((project.mediaLibrary?.items ?? []).map((item) => item.id));
  for (const key of Object.keys(cache.entries)) {
    if (!ids.has(key)) delete cache.entries[key];
  }
}

/**
 * Build a SegmentMap from cache for the given source media ids.
 * `complete` is true only when EVERY id has fresh perception — plan_edit
 * uses the cache only when it can resolve the full footage graph, otherwise
 * it keeps the existing metadata-only fallback (never a mixed map).
 */
export function cachedSegmentMap(
  project: Project,
  media: readonly MediaItem[],
): { map: SegmentMap; complete: boolean } {
  const videos = [];
  for (const item of media) {
    const entry = freshEntry(project, item);
    const videoMap = entry?.videoMap as SegmentMap["videos"][number] | undefined;
    if (!videoMap || !Array.isArray(videoMap.segments)) {
      return { map: { videos: [] }, complete: false };
    }
    videos.push(videoMap);
  }
  return { map: { videos }, complete: videos.length === media.length };
}

/**
 * Build a reference analysis ({ analysisVersion, videos }) from cache for the
 * given reference media ids. Returns null unless EVERY id is fresh —
 * a partial reference set would mislead the director's style target.
 */
export function cachedReferenceAnalysis(
  project: Project,
  media: readonly MediaItem[],
): { analysisVersion: string; videos: unknown[] } | null {
  if (media.length === 0) return null;
  const videos = [];
  for (const item of media) {
    const entry = freshEntry(project, item);
    const ref = entry?.referenceAnalysis;
    if (!ref || typeof ref !== "object") {
      return null;
    }
    videos.push(ref);
  }
  return { analysisVersion: "1.1.0", videos };
}
