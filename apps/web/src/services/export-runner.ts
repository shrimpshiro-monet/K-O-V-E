import { useCallback, useRef, useState } from "react";
import { waitForExportStage } from "@kove-advanced/core/export/export-watchdog";
import {
  getExportEngine,
  type VideoExportSettings,
  type AudioExportSettings,
  type ExportResult,
  type EncoderBackendFactory,
  type Project,
} from "@kove-advanced/core";

export interface ExportRunnerState {
  isExporting: boolean;
  progress: number;
  phase: string;
  error: string | null;
  complete: boolean;
}

export type ExportContainer = "mp4" | "webm" | "mov" | "wav";

const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  wav: "audio/wav",
  zip: "application/zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

export function mimeForExt(ext: string): string {
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export function extForFormat(format: string, codec?: string): ExportContainer {
  if (codec === "prores") return "mov";
  if (format === "mov") return "mov";
  if (format === "webm") return "webm";
  if (format === "wav") return "wav";
  return "mp4";
}

const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*]/g;

export function sanitizeFilenameBase(name: string): string {
  const withoutControls = Array.from(name, (ch) =>
    ch.charCodeAt(0) < 0x20 ? " " : ch,
  ).join("");
  return withoutControls
    .replace(ILLEGAL_FILENAME_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 200)
    .trim();
}

export function exportFilename(projectName: string | undefined, ext: string): string {
  const cleaned = projectName ? sanitizeFilenameBase(projectName) : "";
  const base = cleaned.length > 0 ? cleaned : "export";
  return `${base}.${ext}`;
}

export async function writeBlobToWritable(
  blob: Blob,
  writable: FileSystemWritableFileStream,
  signal?: AbortSignal,
): Promise<void> {
  const reader = blob.stream().getReader();
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await waitForExportStage(reader.read(), "reading audio data", signal);
      if (done) break;
      if (value) await waitForExportStage(writable.write(value), "writing the audio file", signal);
    }
    signal?.throwIfAborted();
    await waitForExportStage(writable.close(), "saving the audio file", signal);
  } catch (error) {
    await waitForExportStage(
      Promise.resolve().then(() => writable.abort()),
      "discarding the incomplete audio file",
      undefined,
      5_000,
    ).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function progressPhaseLabel(phase: string): string {
  return phase === "complete" ? "Complete!" : `${phase}...`;
}

function isAbortError(error: unknown): boolean {
  return !!error && typeof error === "object" && "name" in error && error.name === "AbortError";
}

// Allow the browser plenty of time to start reading the Blob before releasing
// its URL and any OPFS backing file. Existing downloads retain their own handle.
const DOWNLOAD_RELEASE_DELAY_MS = 10 * 60 * 1000;

function triggerAnchorDownload(data: Blob, filename: string, onRelease?: () => void): void {
  const url = URL.createObjectURL(data);
  const anchor = document.createElement("a");
  let released = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    if (released) return;
    released = true;
    if (timer !== undefined) clearTimeout(timer);
    window.removeEventListener("pagehide", release);
    URL.revokeObjectURL(url);
    onRelease?.();
  };
  try {
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    timer = setTimeout(release, DOWNLOAD_RELEASE_DELAY_MS);
    window.addEventListener("pagehide", release, { once: true });
  } catch (error) {
    release();
    throw error;
  } finally {
    anchor.remove();
  }
}

const OPFS_TMP_PREFIX = ".kove-advanced-export-";
const OPFS_TMP_TTL_MS = 60 * 60 * 1000;

type OpfsWriteHandle = FileSystemFileHandle & {
  createWritable?: (opts?: { keepExistingData?: boolean }) => Promise<FileSystemWritableFileStream>;
};

type OpfsDirHandle = FileSystemDirectoryHandle & {
  keys?: () => AsyncIterableIterator<string>;
};

async function getOpfsRoot(): Promise<OpfsDirHandle | null> {
  try {
    const storage = navigator.storage as StorageManager & {
      getDirectory?: () => Promise<OpfsDirHandle>;
    };
    if (!storage || typeof storage.getDirectory !== "function") return null;
    return await storage.getDirectory();
  } catch {
    return null;
  }
}

function opfsLockName(name: string): string {
  return `kove-advanced-export:${name}`;
}

async function sweepStaleOpfsTemps(root: OpfsDirHandle, now: number, locks: LockManager): Promise<void> {
  if (typeof root.keys !== "function") return;
  try {
    for await (const name of root.keys()) {
      if (!name.startsWith(OPFS_TMP_PREFIX)) continue;
      const stamp = Number(name.slice(OPFS_TMP_PREFIX.length).split("-")[0]);
      if (!Number.isFinite(stamp) || now - stamp <= OPFS_TMP_TTL_MS) continue;
      // A long export in another tab may be older than the TTL. Only sweep a
      // file if its owner is no longer holding the cross-tab Web Lock.
      await locks.request(opfsLockName(name), { ifAvailable: true }, async (lock) => {
        if (lock) await root.removeEntry(name).catch(() => undefined);
      });
    }
  } catch {
    // Browsers without a usable lock manager retain stale files rather than
    // risking removal of an active export.
  }
}

async function holdOpfsTempLock(locks: LockManager, name: string): Promise<(() => void) | null> {
  let release!: () => void;
  let resolveReady!: (acquired: boolean) => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<boolean>((resolve) => { resolveReady = resolve; });
  try {
    void locks.request(opfsLockName(name), { ifAvailable: true }, async (lock) => {
      resolveReady(Boolean(lock));
      if (lock) await held;
    }).catch(() => resolveReady(false));
  } catch {
    return null;
  }
  return (await ready) ? release : null;
}

async function createOpfsDownloadWritable(
  filename: string,
): Promise<FileSystemWritableFileStream | null> {
  const root = await getOpfsRoot();
  if (!root) return null;

  const now = Date.now();
  const locks = typeof navigator.locks?.request === "function" ? navigator.locks : null;
  if (locks) await sweepStaleOpfsTemps(root, now, locks);

  const tmpName = `${OPFS_TMP_PREFIX}${now}-${Math.random().toString(36).slice(2)}.tmp`;
  const releaseLock = locks ? await holdOpfsTempLock(locks, tmpName) : () => undefined;
  if (!releaseLock) return null;
  let fileHandle: OpfsWriteHandle;
  let writable: FileSystemWritableFileStream;
  let created = false;
  try {
    fileHandle = (await root.getFileHandle(tmpName, { create: true })) as OpfsWriteHandle;
    created = true;
    if (typeof fileHandle.createWritable !== "function") {
      await root.removeEntry(tmpName).catch(() => undefined);
      releaseLock();
      return null;
    }
    writable = await fileHandle.createWritable({ keepExistingData: false });
  } catch (error) {
    if (created) await root.removeEntry(tmpName).catch(() => undefined);
    releaseLock();
    console.warn("[export-runner] OPFS streaming unavailable; using in-memory fallback", error);
    return null;
  }

  return {
    async seek(position: number) {
      await writable.seek(position);
    },
    async write(data: unknown) {
      await writable.write(data as Parameters<typeof writable.write>[0]);
    },
    async truncate(size: number) {
      await writable.truncate(size);
    },
    async close() {
      try {
        await writable.close();
        const file = await fileHandle.getFile();
        triggerAnchorDownload(file, filename, () => {
          void root.removeEntry(tmpName).catch(() => undefined).finally(releaseLock);
        });
      } catch (error) {
        await root.removeEntry(tmpName).catch(() => undefined);
        releaseLock();
        throw error;
      }
    },
    async abort() {
      try {
        await writable.abort();
      } catch {
        void 0;
      }
      await root.removeEntry(tmpName).catch(() => undefined);
      releaseLock();
    },
  } as unknown as FileSystemWritableFileStream;
}

type ExportWriteCommand = {
  type: "write" | "seek" | "truncate";
  data?: unknown;
  position?: number | null;
  size?: number | null;
};

function isWriteCommand(value: unknown): value is ExportWriteCommand {
  if (!value || typeof value !== "object" || value instanceof Blob) return false;
  if (!("type" in value)) return false;
  return value.type === "write" || value.type === "seek" || value.type === "truncate";
}

function validPosition(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Export file position must be a non-negative integer");
  }
  return value;
}

async function exportChunkBytes(data: unknown): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Blob) {
    if (typeof data.arrayBuffer === "function") return new Uint8Array(await data.arrayBuffer());
    // Older browser implementations expose Blob through FileReader only.
    const result = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error ?? new Error("Could not read export data"));
      reader.readAsArrayBuffer(data);
    });
    return new Uint8Array(result);
  }
  throw new TypeError("Unsupported data written to export file");
}

function createBufferedDownloadWritable(
  filename: string,
  mime: string,
): FileSystemWritableFileStream {
  let buffer = new Uint8Array(16 * 1024 * 1024);
  let length = 0;
  let cursor = 0;
  let closed = false;

  const ensureOpen = () => {
    if (closed) throw new TypeError("Export file is already closed");
  };
  const grow = (needed: number) => {
    if (needed <= buffer.length) return;
    let newSize = buffer.length;
    while (newSize < needed) newSize *= 2;
    const next = new Uint8Array(newSize);
    next.set(buffer.subarray(0, length));
    buffer = next;
  };
  const truncate = (size: number) => {
    ensureOpen();
    validPosition(size);
    grow(size);
    buffer.fill(0, Math.min(size, length), Math.max(size, length));
    length = size;
    cursor = Math.min(cursor, size);
  };
  const writeBytes = (bytes: Uint8Array) => {
    const end = cursor + bytes.byteLength;
    if (!Number.isSafeInteger(end)) throw new TypeError("Export file is too large");
    grow(end);
    if (cursor > length) buffer.fill(0, length, cursor);
    buffer.set(bytes, cursor);
    if (end > length) length = end;
    cursor = end;
  };

  return {
    async seek(position: number) {
      ensureOpen();
      cursor = validPosition(position);
    },
    async write(data: unknown) {
      ensureOpen();
      if (isWriteCommand(data)) {
        if (data.type === "seek") {
          cursor = validPosition(data.position);
          return;
        }
        if (data.type === "truncate") {
          truncate(validPosition(data.size));
          return;
        }
        if (data.position != null) cursor = validPosition(data.position);
        data = data.data;
      }
      const bytes = await exportChunkBytes(data);
      ensureOpen();
      writeBytes(bytes);
    },
    async close() {
      ensureOpen();
      triggerAnchorDownload(new Blob([buffer.slice(0, length)], { type: mime }), filename);
      closed = true;
      buffer = new Uint8Array(0);
    },
    async abort() {
      closed = true;
      buffer = new Uint8Array(0);
      length = 0;
      cursor = 0;
    },
    async truncate(size: number) {
      truncate(size);
    },
  } as unknown as FileSystemWritableFileStream;
}

/** Stream all standard file chunks through the desktop bridge, including ZIP Blobs. */
export async function createDesktopStreamWritable(chosen: string): Promise<FileSystemWritableFileStream> {
  const bridge = window["kove-advanced"]!.fs;
  const handleId = await bridge.openWrite(chosen);
  let cursor = 0;
  let closed = false;
  const ensureOpen = () => {
    if (closed) throw new TypeError("Export file is already closed");
  };
  const truncate = async (size: number) => {
    ensureOpen();
    const safeSize = validPosition(size);
    if (!bridge.truncateWrite) throw new Error("This desktop version cannot truncate export files. Update the app and try again.");
    await bridge.truncateWrite(handleId, safeSize);
    cursor = Math.min(cursor, safeSize);
  };
  return {
    async seek(position: number) {
      ensureOpen();
      cursor = validPosition(position);
    },
    async write(data: unknown) {
      ensureOpen();
      if (isWriteCommand(data)) {
        if (data.type === "seek") {
          cursor = validPosition(data.position);
          return;
        }
        if (data.type === "truncate") {
          await truncate(validPosition(data.size));
          return;
        }
        if (data.position != null) cursor = validPosition(data.position);
        data = data.data;
      }
      const bytes = await exportChunkBytes(data);
      ensureOpen();
      await bridge.writeChunk(handleId, bytes, cursor);
      cursor += bytes.byteLength;
    },
    async close() {
      ensureOpen();
      await bridge.closeWrite(handleId);
      closed = true;
    },
    async abort() {
      if (closed) return;
      closed = true;
      await bridge.abortWrite(handleId);
    },
    truncate,
  } as unknown as FileSystemWritableFileStream;
}

async function createFallbackWritable(
  filename: string,
  mime: string,
): Promise<FileSystemWritableFileStream> {
  return (await createOpfsDownloadWritable(filename)) ?? createBufferedDownloadWritable(filename, mime);
}

export async function createDownloadWritable(
  filename: string,
  mime: string,
): Promise<FileSystemWritableFileStream> {
  const ext = filename.split(".").pop() || "mp4";

  if (typeof window["kove-advanced"]?.fs?.showSaveDialog === "function") {
    const chosen = await window["kove-advanced"].fs.showSaveDialog({
      defaultPath: filename,
      filters: [{ name: "Media file", extensions: [ext] }],
    });
    if (!chosen) {
      throw new DOMException("User cancelled", "AbortError");
    }
    (window as unknown as Record<string, string | undefined>).__kove_advancedExportPath = chosen;
    return createDesktopStreamWritable(chosen);
  }

  if ("showSaveFilePicker" in window) {
    try {
      const handle = await (
        window as unknown as {
          showSaveFilePicker: (opts: unknown) => Promise<FileSystemFileHandle>;
        }
      ).showSaveFilePicker({
        suggestedName: filename,
        types: [
          {
            description: "Media file",
            accept: { [mime]: [`.${ext}`] },
          },
        ],
      });
      return handle.createWritable();
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      console.warn(
        "[export-runner] showSaveFilePicker unavailable; streaming to a downloaded file instead",
        error,
      );
    }
  }

  return createFallbackWritable(filename, mime);
}

const INITIAL_STATE: ExportRunnerState = {
  isExporting: false,
  progress: 0,
  phase: "",
  error: null,
  complete: false,
};

interface ExportRunnerOptions {
  project: Project;
  onExported?: (settings: Partial<VideoExportSettings>) => void;
}

export interface UseExportRunner {
  state: ExportRunnerState;
  runExport: (
    videoSettings: Partial<VideoExportSettings>,
    ext: string,
    writableStream: FileSystemWritableFileStream,
    backendFactory?: EncoderBackendFactory,
  ) => Promise<void>;
  runAudioExport: (
    settings: Partial<AudioExportSettings>,
    writableStream: FileSystemWritableFileStream,
  ) => Promise<void>;
  showSavePicker: (filename: string, ext: string, opts?: { streamToFile?: boolean }) => Promise<FileSystemWritableFileStream>;
  reportProgress: (progress01: number, phase: string) => void;
  markComplete: () => void;
  beginExport: () => void;
  finishExportSoon: () => void;
  failExport: (error: unknown) => void;
  cancel: () => void;
  resetError: () => void;
}

export function useExportRunner(options: ExportRunnerOptions): UseExportRunner {
  const { project, onExported } = options;
  const [state, setState] = useState<ExportRunnerState>(INITIAL_STATE);
  const activeRun = useRef<AbortController | null>(null);
  const runSequence = useRef(0);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const beginExport = useCallback(() => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    activeRun.current?.abort();
    activeRun.current = new AbortController();
    runSequence.current += 1;
    setState({
      isExporting: true,
      progress: 0,
      phase: "Initializing...",
      error: null,
      complete: false,
    });
  }, []);

  const reportProgress = useCallback((progress01: number, phase: string) => {
    setState((prev) => ({
      ...prev,
      progress: progress01 * 100,
      phase: progressPhaseLabel(phase),
    }));
  }, []);

  const markComplete = useCallback(() => {
    setState((prev) => ({ ...prev, isExporting: false, progress: 100, complete: true, phase: "Saved!" }));
  }, []);

  const finishExportSoon = useCallback(() => {
    const sequence = runSequence.current;
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => {
      if (sequence === runSequence.current) setState(INITIAL_STATE);
      resetTimer.current = null;
    }, 2000);
  }, []);

  const failExport = useCallback((error: unknown) => {
    if (error && typeof error === "object" && "name" in error && error.name === "AbortError") {
      const sequence = (error as { exportSequence?: number }).exportSequence;
      if (sequence === undefined || sequence === runSequence.current) setState(INITIAL_STATE);
      return;
    }
    setState((prev) => ({
      ...prev,
      isExporting: false,
      error: error instanceof Error ? error.message : "Export failed",
    }));
  }, []);

  const resetError = useCallback(() => {
    setState((prev) => ({ ...prev, error: null }));
  }, []);

  const runExport = useCallback(
    async (
      videoSettings: Partial<VideoExportSettings>,
      _ext: string,
      writableStream: FileSystemWritableFileStream,
      backendFactory?: EncoderBackendFactory,
    ): Promise<void> => {
      const engine = getExportEngine();
      const controller = activeRun.current ?? new AbortController();
      activeRun.current = controller;
      const sequence = runSequence.current;
      let generatorStarted = false;
      let generator: ReturnType<typeof engine.exportVideo> | null = null;
      const cancelled = (): DOMException & { exportSequence: number } => {
        const error = new DOMException("Export cancelled", "AbortError") as DOMException & { exportSequence: number };
        error.exportSequence = sequence;
        return error;
      };
      const ensureCurrent = () => {
        if (controller.signal.aborted || sequence !== runSequence.current) throw cancelled();
      };

      try {
        setState((prev) => sequence === runSequence.current ? { ...prev, phase: "Loading export engine..." } : prev);
        await waitForExportStage(engine.initialize(), "loading the export engine", controller.signal);
        ensureCurrent();
        setState((prev) => sequence === runSequence.current ? { ...prev, phase: "Preparing renderer..." } : prev);

        generator = engine.exportVideo(project, videoSettings, writableStream, backendFactory);
        let finalResult: ExportResult | undefined;
        let lastProgressUpdateAt = 0;
        let lastProgressPhase: string | null = null;
        while (true) {
          ensureCurrent();
          generatorStarted = true;
          const { value, done } = await generator.next();
          ensureCurrent();
          if (done) {
            finalResult = value;
            break;
          }

          const now = performance.now();
          if (
            value.phase !== lastProgressPhase ||
            now - lastProgressUpdateAt >= 250 ||
            value.phase === "complete"
          ) {
            setState((prev) => sequence === runSequence.current ? {
              ...prev,
              progress: value.progress * 100,
              phase: progressPhaseLabel(value.phase),
            } : prev);
            lastProgressUpdateAt = now;
            lastProgressPhase = value.phase;
          }
        }

        if (!finalResult?.success) {
          if (finalResult?.error?.code === "CANCELLED") throw cancelled();
          throw new Error(finalResult?.error?.message || "Export failed");
        }
        ensureCurrent();
        setState((prev) => sequence === runSequence.current ? {
          ...prev, isExporting: false, progress: 100, complete: true, phase: "Saved!",
        } : prev);
        try {
          onExported?.(videoSettings);
        } catch (error) {
          // Analytics or another notification must not turn a saved file into
          // an apparent export failure.
          console.warn("[export-runner] Export completed, but the completion callback failed", error);
        }
      } catch (error) {
        if (generatorStarted && generator) {
          // If cancellation happened between progress yields, close the paused
          // generator so its backend and file cleanup actually run.
          await waitForExportStage(
            generator.return({ success: false }),
            "stopping the export",
            undefined,
            6_000,
          ).catch(() => undefined);
        } else {
          // Before the generator starts, the engine does not yet own the file.
          await waitForExportStage(
            Promise.resolve().then(() => writableStream.abort()),
            "discarding the incomplete export",
            undefined,
            5_000,
          ).catch(() => undefined);
        }
        if (controller.signal.aborted || sequence !== runSequence.current) throw cancelled();
        throw error;
      } finally {
        if (activeRun.current === controller) activeRun.current = null;
      }
    },
    [project, onExported],
  );

  const runAudioExport = useCallback(
    async (
      settings: Partial<AudioExportSettings>,
      writableStream: FileSystemWritableFileStream,
    ): Promise<void> => {
      const engine = getExportEngine();
      const controller = activeRun.current ?? new AbortController();
      activeRun.current = controller;
      const sequence = runSequence.current;
      let generatorStarted = false;
      let generator: ReturnType<typeof engine.exportAudio> | null = null;
      const cancelled = (): DOMException & { exportSequence: number } => {
        const error = new DOMException("Export cancelled", "AbortError") as DOMException & { exportSequence: number };
        error.exportSequence = sequence;
        return error;
      };
      const ensureCurrent = () => {
        if (controller.signal.aborted || sequence !== runSequence.current) throw cancelled();
      };

      try {
        setState((prev) => sequence === runSequence.current ? { ...prev, phase: "Loading export engine..." } : prev);
        await waitForExportStage(engine.initialize(), "loading the export engine", controller.signal);
        ensureCurrent();
        generator = engine.exportAudio(project, settings);
        let finalResult: ExportResult | undefined;
        for (;;) {
          ensureCurrent();
          generatorStarted = true;
          const { value, done } = await generator.next();
          ensureCurrent();
          if (done) {
            finalResult = value;
            break;
          }
          setState((prev) => sequence === runSequence.current ? {
            ...prev, progress: value.progress * 100, phase: progressPhaseLabel(value.phase),
          } : prev);
        }
        if (!finalResult?.success || !finalResult.blob) {
          if (finalResult?.error?.code === "CANCELLED") throw cancelled();
          throw new Error(finalResult?.error?.message || "Audio export failed");
        }
        ensureCurrent();
        await writeBlobToWritable(finalResult.blob, writableStream, controller.signal);
        ensureCurrent();
        setState((prev) => sequence === runSequence.current ? {
          ...prev, isExporting: false, progress: 100, complete: true, phase: "Saved!",
        } : prev);
      } catch (error) {
        if (generatorStarted && generator) {
          await waitForExportStage(generator.return({ success: false }), "stopping the audio export", undefined, 6_000).catch(() => undefined);
        }
        await waitForExportStage(
          Promise.resolve().then(() => writableStream.abort()),
          "discarding the incomplete audio file",
          undefined,
          5_000,
        ).catch(() => undefined);
        if (controller.signal.aborted || sequence !== runSequence.current) throw cancelled();
        throw error;
      } finally {
        if (activeRun.current === controller) activeRun.current = null;
      }
    },
    [project],
  );

  const showSavePicker = useCallback(
    async (
      filename: string,
      ext: string,
      opts?: { streamToFile?: boolean },
    ): Promise<FileSystemWritableFileStream> => {
      const mime = mimeForExt(ext);

      if (typeof window["kove-advanced"]?.fs?.showSaveDialog === "function") {
        const chosen = await window["kove-advanced"].fs.showSaveDialog({
          defaultPath: filename,
          filters: [{ name: "Media file", extensions: [ext] }],
        });
        if (!chosen) {
          throw new DOMException("User cancelled", "AbortError");
        }
        (window as unknown as Record<string, string | undefined>).__kove_advancedExportPath = chosen;

        // The WAV path and any WebCodecs export (streamToFile) mux directly to
        // disk through the fs bridge. The native ffmpeg video path writes the
        // file itself via __kove-advancedExportPath, so it gets the no-op stub below.
        if (ext === "wav" || opts?.streamToFile === true) {
          return createDesktopStreamWritable(chosen);
        }

        return {
          async seek() {},
          async write() {},
          async close() {},
          async abort() {},
          async truncate() {},
        } as unknown as FileSystemWritableFileStream;
      }

      if ("showSaveFilePicker" in window) {
        try {
          const handle = await (
            window as unknown as {
              showSaveFilePicker: (opts: unknown) => Promise<FileSystemFileHandle>;
            }
          ).showSaveFilePicker({
            suggestedName: filename,
            types: [
              {
                description: "Media file",
                accept: { [mime]: [`.${ext}`] },
              },
            ],
          });
          return handle.createWritable();
        } catch (error) {
          if (isAbortError(error)) {
            throw error;
          }
          console.warn(
            "[export-runner] showSaveFilePicker unavailable; streaming to a downloaded file instead",
            error,
          );
          return createFallbackWritable(filename, mime);
        }
      }

      return createFallbackWritable(filename, mime);
    },
    [],
  );

  const cancel = useCallback(() => {
    activeRun.current?.abort();
    activeRun.current = null;
    runSequence.current += 1;
    if (resetTimer.current) clearTimeout(resetTimer.current);
    getExportEngine().cancel();
    setState(INITIAL_STATE);
  }, []);

  return {
    state,
    runExport,
    runAudioExport,
    showSavePicker,
    reportProgress,
    markComplete,
    beginExport,
    finishExportSoon,
    failExport,
    cancel,
    resetError,
  };
}
