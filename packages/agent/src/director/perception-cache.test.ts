import { describe, expect, it } from "vitest";
import type { MediaItem, Project } from "@kove-advanced/core/types/project";
import {
  mediaFingerprint,
  getPerceptionCache,
  freshEntry,
  setPerceptionEntries,
  pruneStaleEntries,
  cachedSegmentMap,
  cachedReferenceAnalysis,
} from "./perception-cache";

function makeMedia(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "video-1",
    name: "footage.mp4",
    type: "video",
    metadata: { duration: 10 },
    sourceFile: { name: "footage.mp4", size: 1000, lastModified: 1_700_000_000_000 },
    ...overrides,
  } as unknown as MediaItem;
}

function makeProject(media: MediaItem[] = [makeMedia()]): Project {
  return {
    id: "cache-project",
    name: "Cache",
    createdAt: 0,
    modifiedAt: 0,
    settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48000, channels: 2 },
    timeline: { duration: 0, tracks: [], subtitles: [], markers: [] },
    mediaLibrary: { items: media },
  } as unknown as Project;
}

const VIDEO_MAP = {
  videoId: "video-1",
  duration: 10,
  segments: [
    {
      id: "video-1-seg-0",
      startTime: 0,
      endTime: 10,
      description: "analyzed content",
      sceneType: "b-roll",
      motionLevel: "medium",
      hasDialogue: false,
      visualContent: "x",
      confidence: 0.9,
    },
  ],
};

const REF_ANALYSIS = {
  videoId: "ref-1",
  duration: 9,
  summary: { pacing: "fast", cutCount: 5, cutsPerMinute: 33, dialogueLed: false },
  timeline: [],
};

describe("mediaFingerprint", () => {
  it("is stable for identical media", () => {
    const a = makeMedia();
    const b = makeMedia();
    expect(mediaFingerprint(a)).toBe(mediaFingerprint(b));
  });

  it("changes when the file identity changes", () => {
    const base = mediaFingerprint(makeMedia());
    expect(mediaFingerprint(makeMedia({ sourceFile: { name: "footage.mp4", size: 2000, lastModified: 1_700_000_000_000 } }))).not.toBe(base);
    expect(mediaFingerprint(makeMedia({ sourceFile: { name: "footage.mp4", size: 1000, lastModified: 1_800_000_000_000 } }))).not.toBe(base);
    expect(mediaFingerprint(makeMedia({ metadata: { duration: 11 } as never }))).not.toBe(base);
    expect(mediaFingerprint(makeMedia({ id: "video-2" }))).not.toBe(base);
    expect(mediaFingerprint(makeMedia({ name: "other.mp4" }))).not.toBe(base);
  });
});

describe("getPerceptionCache", () => {
  it("initializes lazily and is idempotent", () => {
    const project = makeProject();
    const first = getPerceptionCache(project);
    expect(first.version).toBe(1);
    expect(first.entries).toEqual({});
    expect(getPerceptionCache(project)).toBe(first);
  });

  it("discards a corrupt cache (wrong version) instead of crashing", () => {
    const project = makeProject();
    (project as { perceptionCache?: unknown }).perceptionCache = { version: 99, entries: {} };
    const cache = getPerceptionCache(project);
    expect(cache.version).toBe(1);
    expect(cache.entries).toEqual({});
  });
});

describe("freshEntry", () => {
  it("returns null when absent or invalid", () => {
    const project = makeProject();
    expect(freshEntry(project, makeMedia())).toBeNull();
  });

  it("returns the entry while the fingerprint matches", () => {
    const project = makeProject();
    const media = makeMedia();
    const entry = {
      fingerprint: mediaFingerprint(media),
      capturedAtMs: 1,
      frameCount: 15,
      twoPass: true,
      videoMap: VIDEO_MAP,
    };
    setPerceptionEntries(project, [{ media, entry }]);
    expect(freshEntry(project, media)?.frameCount).toBe(15);
  });

  it("is stale when the media changed after capture", () => {
    const project = makeProject();
    const media = makeMedia();
    setPerceptionEntries(project, [
      {
        media,
        entry: {
          fingerprint: mediaFingerprint(media),
          capturedAtMs: 1,
          frameCount: 15,
          twoPass: false,
          videoMap: VIDEO_MAP,
        },
      },
    ]);
    // Re-imported file: same id/name, new size + mtime.
    const changed = makeMedia({
      sourceFile: { name: "footage.mp4", size: 9999, lastModified: 1_900_000_000_000 },
    });
    expect(freshEntry(project, changed)).toBeNull();
  });
});

describe("pruneStaleEntries", () => {
  it("drops entries for media removed from the library", () => {
    const kept = makeMedia({ id: "kept" });
    const gone = makeMedia({ id: "gone" });
    const project = makeProject([kept]);
    setPerceptionEntries(project, [
      { media: kept, entry: { fingerprint: mediaFingerprint(kept), capturedAtMs: 1, frameCount: 1, twoPass: false, videoMap: VIDEO_MAP } },
      { media: gone, entry: { fingerprint: mediaFingerprint(gone), capturedAtMs: 1, frameCount: 1, twoPass: false, videoMap: VIDEO_MAP } },
    ]);
    expect(Object.keys(getPerceptionCache(project).entries)).toHaveLength(2);
    pruneStaleEntries(project);
    expect(Object.keys(getPerceptionCache(project).entries)).toEqual(["kept"]);
  });
});

describe("cachedSegmentMap", () => {
  it("is complete only when every media has fresh perception", () => {
    const mediaA = makeMedia({ id: "a" });
    const mediaB = makeMedia({ id: "b" });
    const project = makeProject([mediaA, mediaB]);
    setPerceptionEntries(project, [
      {
        media: mediaA,
        entry: { fingerprint: mediaFingerprint(mediaA), capturedAtMs: 1, frameCount: 3, twoPass: true, videoMap: { ...VIDEO_MAP, videoId: "a" } },
      },
    ]);
    // Only "a" is cached — not complete for the full graph.
    const partial = cachedSegmentMap(project, [mediaA, mediaB]);
    expect(partial.complete).toBe(false);

    setPerceptionEntries(project, [
      {
        media: mediaB,
        entry: { fingerprint: mediaFingerprint(mediaB), capturedAtMs: 1, frameCount: 4, twoPass: true, videoMap: { ...VIDEO_MAP, videoId: "b" } },
      },
    ]);
    const full = cachedSegmentMap(project, [mediaA, mediaB]);
    expect(full.complete).toBe(true);
    expect(full.map.videos.map((v) => v.videoId).sort()).toEqual(["a", "b"]);
    expect(full.map.videos[0]!.segments[0]!.description).toBe("analyzed content");
  });
});

describe("cachedReferenceAnalysis", () => {
  it("returns null for an empty set and for partial coverage", () => {
    const refA = makeMedia({ id: "refA", analysisRole: "reference" });
    const refB = makeMedia({ id: "refB", analysisRole: "reference" });
    const project = makeProject([refA, refB]);
    expect(cachedReferenceAnalysis(project, [])).toBeNull();
    expect(cachedReferenceAnalysis(project, [refA, refB])).toBeNull();

    setPerceptionEntries(project, [
      {
        media: refA,
        entry: { fingerprint: mediaFingerprint(refA), capturedAtMs: 1, frameCount: 2, twoPass: true, referenceAnalysis: REF_ANALYSIS },
      },
    ]);
    expect(cachedReferenceAnalysis(project, [refA, refB])).toBeNull();
    setPerceptionEntries(project, [
      {
        media: refB,
        entry: { fingerprint: mediaFingerprint(refB), capturedAtMs: 1, frameCount: 2, twoPass: true, referenceAnalysis: { ...REF_ANALYSIS, videoId: "refB" } },
      },
    ]);
    const hit = cachedReferenceAnalysis(project, [refA, refB]);
    expect(hit?.videos).toHaveLength(2);
    expect(hit?.analysisVersion).toBe("1.1.0");
  });
});
