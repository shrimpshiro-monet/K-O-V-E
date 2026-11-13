import type { JobKind, JobResult, JobRunner } from "@kove-advanced/agent";
import type {
  VideoExportSettings,
  AudioExportSettings,
  ExportProgress,
  ExportResult,
} from "@kove-advanced/core/export/types";
import type { Project } from "@kove-advanced/core/types/project";
import { getExportEngine, WebCodecsBackend, type EncoderBackendFactory } from "@kove-advanced/core";
import { waitForExportStage } from "@kove-advanced/core/export/export-watchdog";
import { useProjectStore } from "../../stores/project-store";
import { createDesktopStreamWritable, createDownloadWritable, writeBlobToWritable } from "../export-runner";
import { NativeFFmpegBackend } from "../native-ffmpeg-backend";
import { renderMotionCompositionFrameToDataUrl } from "../../motion/export-motion-frame";
import { getMediaBridge, initializeMediaBridge } from "../../bridges/media-bridge";
import { loadMediaBlob } from "../media-storage";

const VIDEO_FORMATS = new Set<VideoExportSettings["format"]>(["mp4", "webm", "mov"]);
const AUDIO_FORMATS = new Set<AudioExportSettings["format"]>(["mp3", "wav", "aac", "flac", "ogg"]);

const VIDEO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};
const AUDIO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  aac: "audio/aac",
  flac: "audio/flac",
  ogg: "audio/ogg",
};

function videoSettings(
  format: string,
  project: Project,
): Partial<VideoExportSettings> {
  const fmt = (VIDEO_FORMATS.has(format as VideoExportSettings["format"])
    ? format
    : "mp4") as VideoExportSettings["format"];
  const codec = fmt === "webm" ? "vp9" : fmt === "mov" ? "h265" : "h264";
  return {
    format: fmt,
    codec,
    width: project.settings.width,
    height: project.settings.height,
    frameRate: project.settings.frameRate,
    bitrate: 12000,
    bitrateMode: "vbr",
    quality: 85,
    keyframeInterval: 2,
  };
}

function audioSettings(format: string): Partial<AudioExportSettings> {
  const fmt = (AUDIO_FORMATS.has(format as AudioExportSettings["format"])
    ? format
    : "wav") as AudioExportSettings["format"];
  // Export settings express bitrate in kilobits per second.
  return { format: fmt, sampleRate: 48000, bitDepth: 16, bitrate: 192, channels: 2 };
}

async function drainExport(
  gen: AsyncGenerator<ExportProgress, ExportResult>,
): Promise<ExportResult> {
  let step = await gen.next();
  while (!step.done) {
    step = await gen.next();
  }
  return step.value;
}

function sanitizeName(name: string | undefined): string {
  const base = (name ?? "export").replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "");
  return base.slice(0, 60) || "export";
}

async function saveExportLocally(
  blob: Blob,
  projectName: string | undefined,
  ext: string,
  contentType: string,
): Promise<JobResult> {
  if (!blob.size) return { ok: false, error: "Export produced no data" };
  const bridge = window["kove-advanced"]?.fs;
  const filename = `${sanitizeName(projectName)}-${Date.now()}.${ext}`;
  const path = bridge ? await bridge.tempFilePath(ext) : undefined;
  const writable = path
    ? await createDesktopStreamWritable(path)
    : await createDownloadWritable(filename, contentType);
  await writeBlobToWritable(blob, writable);
  return {
    ok: true,
    data: {
      ...(path ? { path } : {}),
      filename,
      bytes: blob.size,
      format: ext,
      contentType,
      storage: path ? "local" : "browser-download",
    },
  };
}

export function createExportJobRunner(): JobRunner {
  return async (kind: JobKind, params: Record<string, unknown>): Promise<JobResult> => {
    try {
      const project = useProjectStore.getState().project;
      const engine = getExportEngine();

      if (kind === "extractVideoFrame") {
        const mediaId = typeof params.mediaId === "string" ? params.mediaId : "";
        if (!mediaId) {
          return { ok: false, error: "extractVideoFrame requires a mediaId" };
        }
        const media = (project.mediaLibrary?.items ?? []).find((m) => m.id === mediaId);
        if (!media) {
          return { ok: false, error: `Media not found: ${mediaId}` };
        }
        if (media.type !== "video") {
          return { ok: false, error: `Media is not a video: ${media.type}` };
        }
        const timeSeconds =
          typeof params.timeSeconds === "number" && Number.isFinite(params.timeSeconds)
            ? params.timeSeconds
            : 0;
        const maxWidth =
          typeof params.maxWidth === "number" && Number.isFinite(params.maxWidth)
            ? params.maxWidth
            : 320;

        const mediaBlob = media.blob ?? await loadMediaBlob(media.id);
        if (!mediaBlob) return { ok: false, error: "Media blob unavailable" };
        const mediaBridge = getMediaBridge();
        if (!mediaBridge.isInitialized()) await initializeMediaBridge();
        const frame = await mediaBridge.extractVideoFrame(mediaBlob, timeSeconds, maxWidth);
        if (!frame?.imageDataBase64) return { ok: false, error: "Failed to decode media frame" };

        return {
          ok: true,
          data: {
            imageDataBase64: frame.imageDataBase64,
            width: frame.width,
            height: frame.height,
          },
        };
      }

      if (kind === "extractVideoFrames") {
        const mediaId = typeof params.mediaId === "string" ? params.mediaId : "";
        const timestamps = params.timestamps;
        if (!mediaId || !Array.isArray(timestamps) || timestamps.length > 60) {
          return {
            ok: false,
            error: "extractVideoFrames requires a mediaId and at most 60 timestamps",
          };
        }
        const frameTimes = timestamps.filter(
          (timestamp): timestamp is number =>
            typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp >= 0,
        );
        if (frameTimes.length !== timestamps.length) {
          return { ok: false, error: "Frame timestamps must be finite non-negative numbers" };
        }
        const media = project.mediaLibrary.items.find((item) => item.id === mediaId);
        if (!media) return { ok: false, error: `Media not found: ${mediaId}` };
        if (media.type !== "video") {
          return { ok: false, error: `Media is not a video: ${media.type}` };
        }
        const mediaBlob = media.blob ?? await loadMediaBlob(media.id);
        if (!mediaBlob) return { ok: false, error: "Media blob unavailable" };
        const maxWidth =
          typeof params.maxWidth === "number" && Number.isFinite(params.maxWidth)
            ? Math.max(1, Math.min(960, Math.floor(params.maxWidth)))
            : 320;
        const mediaBridge = getMediaBridge();
        if (!mediaBridge.isInitialized()) await initializeMediaBridge();
        const onProgress =
          typeof params.onProgress === "function"
            ? params.onProgress as (completed: number, total: number) => void
            : undefined;
        const frames = await mediaBridge.extractVideoFrames(
          mediaBlob,
          frameTimes,
          maxWidth,
          onProgress,
        );
        return { ok: true, data: { frames } };
      }

      if (kind === "exportVideo") {
        const format = typeof params.format === "string" ? params.format : "mp4";
        const ext = VIDEO_FORMATS.has(format as VideoExportSettings["format"]) ? format : "mp4";
        const settings = videoSettings(format, project);
        const videoCodec = settings.codec === "h265" ? "hevc" : settings.codec === "vp9" ? "vp9" : "avc";
        const bridge = window["kove-advanced"]?.fs;
        const contentType = VIDEO_MIME[ext];
        const filename = `${sanitizeName(project.name)}-${Date.now()}.${ext}`;
        await waitForExportStage(engine.initialize(), "loading the export engine");
        const path = bridge ? await bridge.tempFilePath(ext) : undefined;

        const webCodecsFactory = (hardwareAcceleration: "prefer-hardware" | "prefer-software"): EncoderBackendFactory =>
        (mediabunny) => {
          if (!mediabunny) {
            throw new Error(`MediaBunny is unavailable for the ${hardwareAcceleration} video attempt`);
          }
          return new WebCodecsBackend(mediabunny, {
            hardwareAcceleration,
            videoCodecs: [videoCodec],
            clampResolution: !bridge,
          });
        };

        // A wedged browser encoder must not burn the whole export budget
        // retrying the same route: fall through hardware → software WebCodecs,
        // then (desktop only) to the native FFmpeg export job.
        const attempts: { label: string; factory: EncoderBackendFactory }[] = [
          { label: "hardware WebCodecs", factory: webCodecsFactory("prefer-hardware") },
          { label: "software WebCodecs", factory: webCodecsFactory("prefer-software") },
        ];
        if (bridge) {
          attempts.push({
            label: "native FFmpeg",
            factory: () => new NativeFFmpegBackend(() => path ?? ""),
          });
        }

        const isAbort = (error: unknown): boolean =>
          error instanceof Error && error.name === "AbortError";
        // Codec/settings problems fail identically on every attempt, and a
        // user cancellation must not relaunch the export.
        const retryable = (code: string | undefined): boolean =>
          code === "TIMEOUT" || code === "FRAME_ENCODE_FAILED" || code === "ENCODER_INIT_FAILED";

        let success: ExportResult | null = null;
        let failure: ExportResult["error"] | null = null;

        for (let index = 0; index < attempts.length; index++) {
          const { label, factory } = attempts[index];
          const writable = path
            ? await createDesktopStreamWritable(path)
            : await createDownloadWritable(filename, contentType);
          try {
            const attemptResult = await drainExport(engine.exportVideo(project, settings, writable, factory));
            if (attemptResult.success) {
              success = attemptResult;
              break;
            }
            failure = attemptResult.error ?? null;
            if (failure?.code === "CANCELLED" || !retryable(failure?.code)) break;
            console.warn(
              `[export-runner] ${label} video attempt failed (${failure?.code ?? "unknown"}: ${failure?.message ?? "no message"}); ` +
                `retrying with ${attempts[index + 1]?.label ?? "nothing left"}`,
            );
          } catch (error) {
            if (isAbort(error)) break;
            failure = { code: "FRAME_ENCODE_FAILED", message: error instanceof Error ? error.message : String(error), phase: "rendering", recoverable: true };
            console.warn(`[export-runner] ${label} video attempt threw; retrying with ${attempts[index + 1]?.label ?? "nothing left"}`, error);
          } finally {
            if (!success) await writable.abort().catch(() => undefined);
          }
        }

        if (!success) {
          return { ok: false, error: failure?.message ?? "Video export failed" };
        }
        const bytes = success.stats?.fileSize ?? 0;
        if (bytes <= 0) return { ok: false, error: "Video export produced no data" };
        return {
          ok: true,
          data: { ...(path ? { path } : {}), filename, bytes, format: ext, contentType, storage: path ? "local" : "browser-download" },
        };
      }

      if (kind === "exportAudio") {
        await waitForExportStage(engine.initialize(), "loading the export engine");
        const format = typeof params.format === "string" ? params.format : "wav";
        const result = await drainExport(engine.exportAudio(project, audioSettings(format)));
        if (!result.success || !result.blob) {
          return { ok: false, error: result.error?.message ?? "Audio export failed" };
        }
        const ext = (AUDIO_FORMATS.has(format as AudioExportSettings["format"]) ? format : "wav");
        return await saveExportLocally(result.blob, project.name, ext, result.blob.type || AUDIO_MIME[ext]);
      }

      if (kind === "exportFrame") {
        const compositionId =
          typeof params.compositionId === "string" ? params.compositionId : "";
        if (!compositionId) {
          return { ok: false, error: "exportFrame requires a compositionId" };
        }
        const composition = (project.motionCompositions ?? []).find(
          (candidate) => candidate.id === compositionId,
        );
        if (!composition) {
          return {
            ok: false,
            error: `Motion composition not found: ${compositionId}`,
          };
        }
        const timeSeconds =
          typeof params.timeSeconds === "number" && Number.isFinite(params.timeSeconds)
            ? params.timeSeconds
            : 0;
        const scale =
          typeof params.scale === "number" && Number.isFinite(params.scale)
            ? params.scale
            : undefined;
        const frame = await renderMotionCompositionFrameToDataUrl({
          composition,
          time: timeSeconds,
          compositionLibrary: project.motionCompositions ?? [composition],
          mediaItems: project.mediaLibrary.items,
          creation: project.creation,
          scale,
        });
        return {
          ok: true,
          data: {
            dataUrl: frame.dataUrl,
            width: frame.width,
            height: frame.height,
          },
        };
      }

      return { ok: false, error: `Job '${kind}' is not supported by the export runner` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}
