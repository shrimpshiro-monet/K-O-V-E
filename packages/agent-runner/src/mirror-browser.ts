import { VideoEngine } from "@kove-advanced/core/video/video-engine";
import { SCHEMA_VERSION, type ProjectFile } from "@kove-advanced/core/storage/project-serializer";
import type { Project } from "@kove-advanced/core/types/project";

/** This module runs only inside Playwright's page, never in Node. */
interface BrowserSnapshot {
  json: string;
  hash: string;
  mediaIds: readonly string[];
}

let loaded: { hash: string; project: Project; engine: VideoEngine } | undefined;
const frames = new Map<string, number[]>();

async function loadSnapshot(snapshot: BrowserSnapshot): Promise<typeof loaded & {}> {
  if (loaded?.hash === snapshot.hash) return loaded;
  loaded?.engine.dispose();
  loaded = undefined;
  frames.clear();
  const file = JSON.parse(snapshot.json) as ProjectFile;
  if (file.version !== SCHEMA_VERSION || !file.project?.timeline || !file.project.mediaLibrary) {
    throw new Error("Unsupported or incomplete mirror project snapshot");
  }
  const expected = new Set(snapshot.mediaIds);
  const items = await Promise.all(file.project.mediaLibrary.items.map(async (item) => {
    if (!expected.has(item.id)) return item;
    const response = await fetch(`/__mirror_media/${encodeURIComponent(snapshot.hash)}/${encodeURIComponent(item.id)}`);
    if (!response.ok) throw new Error(`Missing snapshot media ${item.id}: HTTP ${response.status}`);
    const blob = await response.blob();
    if (!blob.size) throw new Error(`Empty snapshot media ${item.id}`);
    if (item.type === "image") {
      // The compositor can otherwise silently skip an image it cannot decode.
      const bitmap = await createImageBitmap(blob);
      bitmap.close();
    }
    return { ...item, blob, isPlaceholder: false };
  }));
  const project: Project = { ...file.project, mediaLibrary: { items } };
  const engine = new VideoEngine({ maxFrames: 1 });
  // Export semantics retry/abort failed effects instead of silently showing a
  // preview fallback that would look like a successfully measured candidate.
  engine.exportMode = true;
  await engine.initialize();
  loaded = { hash: snapshot.hash, project, engine };
  return loaded;
}

async function render(snapshot: BrowserSnapshot, timeSeconds: number): Promise<number[]> {
  if (!Number.isFinite(timeSeconds) || timeSeconds < 0) throw new Error("Invalid mirror sample time");
  const { project, engine } = await loadSnapshot(snapshot);
  const key = `${snapshot.hash}:${timeSeconds}`;
  const cached = frames.get(key);
  if (cached) return cached;
  // VideoEngine's preview path intentionally skips an undecodable clip. A
  // critic must instead fail, not quietly compare a fabricated black canvas.
  for (const track of project.timeline.tracks) for (const clip of track.clips) {
    if (track.hidden || timeSeconds < clip.startTime || timeSeconds >= clip.startTime + clip.duration) continue;
    const item = project.mediaLibrary.items.find((media) => media.id === clip.mediaId);
    if (item?.type !== "video" || !item.blob) continue;
    const sourceTime = clip.inPoint + (timeSeconds - clip.startTime) * (clip.speed ?? 1);
    let probe = typeof VideoDecoder === "undefined" ? null :
      await engine.decodeFrameWithMediaBunny(item.blob, sourceTime, 64, 64, item.id);
    if (!probe) probe = await engine.decodeFrameWithVideoElement(item.id, item.blob, sourceTime, 64, 64);
    if (!probe) throw new Error(`Cannot decode snapshot video ${item.id}`);
    probe.close();
  }
  const frame = await engine.renderFrame(project, timeSeconds, 64, 64);
  try {
    const canvas = new OffscreenCanvas(64, 64);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("No 2D canvas available to read compositor pixels");
    ctx.drawImage(frame.image, 0, 0, 64, 64);
    const rgba = ctx.getImageData(0, 0, 64, 64).data;
    const luma = new Array<number>(4096);
    for (let i = 0; i < 4096; i++) {
      const offset = 4 * i;
      // BT.601 full-range RGB->Y; FFmpeg's raw gray output uses the same luma scale.
      luma[i] = Math.round(0.299 * rgba[offset]! + 0.587 * rgba[offset + 1]! + 0.114 * rgba[offset + 2]!);
    }
    frames.set(key, luma);
    return luma;
  } finally {
    frame.image.close();
  }
}

interface MirrorWindow extends Window {
  koveMirrorRender?: typeof render;
}
(window as MirrorWindow).koveMirrorRender = render;
