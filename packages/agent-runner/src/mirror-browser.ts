import { VideoEngine } from "@kove-advanced/core/video/video-engine";
import { ExportEngine } from "@kove-advanced/core/export/export-engine";
import { titleEngine } from "@kove-advanced/core/text/title-engine";
import type { VideoExportSettings } from "@kove-advanced/core/export/types";
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
  titleEngine.loadTextClips(project.textClips ?? []);
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let start = 0; start < bytes.length; start += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunkSize));
  }
  return btoa(binary);
}

async function exportTimeline(
  snapshot: BrowserSnapshot,
  settings: Partial<VideoExportSettings>,
): Promise<{ duration: number; framesRendered: number; fileSize: number }> {
  const { project } = await loadSnapshot(snapshot);
  const exportWindow = window as MirrorWindow;
  let position = 0;
  const writable = {
    async write(chunk: unknown): Promise<void> {
      let bytes: Uint8Array;
      if (chunk instanceof Uint8Array) bytes = chunk;
      else if (chunk instanceof ArrayBuffer) bytes = new Uint8Array(chunk);
      else if (ArrayBuffer.isView(chunk)) {
        bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      } else {
        throw new Error("Timeline exporter wrote an unsupported chunk");
      }
      if (!exportWindow.__koveWriteExportChunk) throw new Error("Timeline export writer is unavailable");
      await exportWindow.__koveWriteExportChunk(position, bytesToBase64(bytes));
      position += bytes.byteLength;
    },
    async seek(nextPosition: number): Promise<void> {
      if (!Number.isSafeInteger(nextPosition) || nextPosition < 0) throw new Error("Invalid timeline export seek");
      position = nextPosition;
    },
    async truncate(size: number): Promise<void> {
      if (!exportWindow.__koveTruncateExport) throw new Error("Timeline export writer is unavailable");
      await exportWindow.__koveTruncateExport(size);
    },
    async close(): Promise<void> {
      if (!exportWindow.__koveCloseExport) throw new Error("Timeline export writer is unavailable");
      await exportWindow.__koveCloseExport();
    },
    async abort(): Promise<void> {
      await exportWindow.__koveAbortExport?.();
    },
  } as unknown as FileSystemWritableFileStream;

  const exporter = new ExportEngine();
  try {
    await exporter.initialize();
    await exportWindow.__koveExportProgress?.("Starting timeline export (audio is mixed before video frames).");
    const generator = exporter.exportVideo(project, settings, writable);
    let finalResult;
    let lastReportedFrame = -1;
    while (true) {
      const next = await generator.next();
      if (next.done) {
        finalResult = next.value;
        break;
      }
      const progress = next.value;
      if (progress.phase === "preparing") {
        await exportWindow.__koveExportProgress?.("Preparing render and mixing timeline audio.");
      } else if (
        progress.phase === "rendering" &&
        (progress.currentFrame === 1 || progress.currentFrame - lastReportedFrame >= (settings.frameRate ?? 30) * 5)
      ) {
        lastReportedFrame = progress.currentFrame;
        await exportWindow.__koveExportProgress?.(
          `Rendering ${progress.currentFrame}/${progress.totalFrames} frames (${Math.round(progress.progress * 100)}%).`,
        );
      } else if (progress.phase === "muxing") {
        await exportWindow.__koveExportProgress?.("Finalizing MP4.");
      }
    }
    if (!finalResult.success) {
      throw new Error(finalResult.error?.message ?? "Timeline export failed");
    }
    return {
      duration: finalResult.stats?.duration ?? project.timeline.duration,
      framesRendered: finalResult.stats?.framesRendered ?? 0,
      fileSize: finalResult.stats?.fileSize ?? position,
    };
  } finally {
    exporter.dispose();
  }
}

interface MirrorWindow extends Window {
  koveMirrorRender?: typeof render;
  koveMirrorExport?: typeof exportTimeline;
  __koveWriteExportChunk?: (position: number, base64: string) => Promise<void>;
  __koveTruncateExport?: (size: number) => Promise<void>;
  __koveCloseExport?: () => Promise<void>;
  __koveAbortExport?: () => Promise<void>;
  __koveExportProgress?: (message: string) => Promise<void>;
}
const mirrorWindow = window as MirrorWindow;
mirrorWindow.koveMirrorRender = render;
mirrorWindow.koveMirrorExport = exportTimeline;
