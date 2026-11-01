import type { JSX } from "react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ToolcraftButton as Button } from "@kove-advanced/ui";
import type { VideoExportSettings } from "@kove-advanced/core";
import { WebCodecsBackend } from "@kove-advanced/core";
import { waitForExportStage } from "@kove-advanced/core/export/export-watchdog";
import { useProjectStore } from "../../stores/project-store";
import { ExportDialog } from "../../components/editor/ExportDialog";
import { deriveSourceExportMatch } from "../../services/export-source-match";
import { useExportRunner, extForFormat, exportFilename } from "../../services/export-runner";
import { NativeFFmpegBackend } from "../../services/native-ffmpeg-backend";
import { Icon } from "@/icons/Icon";

const NO_DRAG = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

const resolveExportOutputPath = (): string =>
  (window as unknown as Record<string, string | undefined>).__kove_advancedExportPath ?? "";

// Native ffmpeg writes the file itself via the resolved output path, so it does
// not consume the writable stream — a no-op stream satisfies the interface.
const NOOP_WRITABLE = {
  async seek() {},
  async write() {},
  async close() {},
  async abort() {},
  async truncate() {},
} as unknown as FileSystemWritableFileStream;

// WebCodecs hardware encoding (no per-frame GPU->CPU readback) is the fast path
// for the common H.264/HEVC fast/balanced case. ProRes, AV1, and the
// software-CRF "Smallest" mode stay on the native ffmpeg backend.
function shouldUseWebCodecs(settings: VideoExportSettings): boolean {
  const hasWebCodecs =
    typeof (globalThis as { VideoEncoder?: unknown }).VideoEncoder !==
    "undefined";
  const mode = settings.encodeMode ?? "balanced";
  return (
    hasWebCodecs &&
    (settings.codec === "h264" || settings.codec === "h265") &&
    (mode === "fast" || mode === "balanced")
  );
}

export function DesktopExportButton(): JSX.Element {
  const project = useProjectStore((state) => state.project);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const activeExport = useRef<AbortController | null>(null);

  const {
    state,
    runExport,
    showSavePicker,
    beginExport,
    finishExportSoon,
    failExport,
    cancel,
    resetError,
  } = useExportRunner({ project });

  useEffect(() => {
    const open = () => setIsDialogOpen(true);
    window.addEventListener("kove-advanced:menu:export", open);
    return () => {
      activeExport.current?.abort();
      window.removeEventListener("kove-advanced:menu:export", open);
    };
  }, []);

  const cancelExport = useCallback(() => {
    activeExport.current?.abort();
    cancel();
  }, [cancel]);

  const handleExport = useCallback(
    async (settings: VideoExportSettings) => {
      setIsDialogOpen(false);
      activeExport.current?.abort();
      const controller = new AbortController();
      activeExport.current = controller;
      const ensureCurrent = () => {
        if (controller.signal.aborted || activeExport.current !== controller) {
          throw new DOMException("Export cancelled", "AbortError");
        }
      };

      try {
        const ext = extForFormat(settings.format, settings.codec);
        const useWebCodecs = shouldUseWebCodecs(settings);
        const writable = await showSavePicker(
          exportFilename(project.name, ext),
          ext,
          { streamToFile: useWebCodecs },
        );
        if (controller.signal.aborted || activeExport.current !== controller) {
          await waitForExportStage(
            Promise.resolve().then(() => writable.abort()),
            "discarding the cancelled export",
            undefined,
            5_000,
          ).catch(() => undefined);
          ensureCurrent();
        }

        beginExport();

        const needsUpscaling =
          settings.width > project.settings.width ||
          settings.height > project.settings.height;

        const exportSettings: Partial<VideoExportSettings> = {
          ...settings,
          upscaling:
            settings.upscaling?.enabled && needsUpscaling ? settings.upscaling : undefined,
        };

        const nativeFactory = () => new NativeFFmpegBackend(resolveExportOutputPath);
        if (useWebCodecs) {
          const videoCodec = settings.codec === "h265" ? "hevc" : "avc";
          try {
            await runExport(exportSettings, ext, writable, (mediabunny) => {
              if (!mediabunny) throw new Error("MediaBunny is unavailable for WebCodecs export");
              return new WebCodecsBackend(mediabunny, {
                hardwareAcceleration: "prefer-hardware",
                videoCodecs: [videoCodec],
                // Desktop streams frames to disk; retain the full resolution.
                clampResolution: false,
              });
            });
          } catch (webCodecsError) {
            if (webCodecsError && typeof webCodecsError === "object" && "name" in webCodecsError && webCodecsError.name === "AbortError") {
              throw webCodecsError;
            }
            console.warn("[Export] WebCodecs export failed; falling back to native ffmpeg:", webCodecsError);
            await waitForExportStage(
              Promise.resolve().then(() => writable.abort()),
              "discarding the failed WebCodecs export",
              controller.signal,
              5_000,
            ).catch(() => undefined);
            ensureCurrent();
            await runExport(exportSettings, ext, NOOP_WRITABLE, nativeFactory);
          }
        } else {
          await runExport(exportSettings, ext, writable, nativeFactory);
        }

        ensureCurrent();
        finishExportSoon();
      } catch (error) {
        if (activeExport.current === controller) failExport(error);
      } finally {
        if (activeExport.current === controller) activeExport.current = null;
      }
    },
    [project, runExport, showSavePicker, beginExport, finishExportSoon, failExport],
  );

  if (state.isExporting) {
    return (
      <Button
        label={`${Math.round(state.progress)}%`}
        variant="secondary"
        size="sm"
        style={NO_DRAG}
        onClick={cancelExport}
        className="mr-2"
        aria-label="Cancel export"
      />
    );
  }

  if (state.error) {
    return (
      <Button
        label={state.error}
        variant="destructive"
        size="sm"
        style={NO_DRAG}
        onClick={resetError}
        className="mr-2 max-w-[200px] truncate"
        aria-label="Dismiss export error"
      />
    );
  }

  if (state.complete) {
    return (
      <Button
        label="Saved!"
        variant="secondary"
        size="sm"
        style={NO_DRAG}
        className="mr-2"
        isDisabled
      />
    );
  }

  return (
    <>
      <Button
        label="Export"
        variant="primary"
        size="sm"
        icon={<Icon name="square.and.arrow.up" size={15} ariaHidden />}
        style={NO_DRAG}
        onClick={() => setIsDialogOpen(true)}
        className="mr-2"
      />

      <ExportDialog
        isOpen={isDialogOpen}
        onClose={() => setIsDialogOpen(false)}
        onExport={handleExport}
        duration={project?.timeline?.duration ?? 0}
        projectWidth={project?.settings?.width ?? 1920}
        projectHeight={project?.settings?.height ?? 1080}
        frameRate={project?.settings?.frameRate ?? 30}
        sourceMatch={deriveSourceExportMatch(project)}
      />
    </>
  );
}
