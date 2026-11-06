import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { Project, VideoExportSettings, ExportResult } from "@kove-advanced/core";
import {
  useExportRunner,
  mimeForExt,
  extForFormat,
  exportFilename,
  sanitizeFilenameBase,
  writeBlobToWritable,
  progressPhaseLabel,
  createDownloadWritable,
} from "./export-runner";

const { mockEngine, getExportEngineMock } = vi.hoisted(() => {
  const engine = {
    initialize: vi.fn().mockResolvedValue(undefined),
    exportVideo: vi.fn(),
    exportAudio: vi.fn(),
    cancel: vi.fn(),
  };
  return {
    mockEngine: engine,
    getExportEngineMock: vi.fn(() => engine),
  };
});

vi.mock("@kove-advanced/core", () => ({
  getExportEngine: getExportEngineMock,
}));

function fakeProject(): Project {
  return {
    name: "My Movie",
    settings: { width: 1920, height: 1080, frameRate: 30 },
    timeline: { duration: 10 },
  } as unknown as Project;
}

async function* successGenerator(): AsyncGenerator<
  { phase: ExportResult extends never ? never : "rendering" | "encoding" | "complete"; progress: number },
  ExportResult
> {
  yield { phase: "rendering", progress: 0.25 };
  yield { phase: "encoding", progress: 0.75 };
  yield { phase: "complete", progress: 1 };
  return { success: true } as ExportResult;
}

async function* failureGenerator(): AsyncGenerator<
  { phase: "rendering"; progress: number },
  ExportResult
> {
  yield { phase: "rendering", progress: 0.5 };
  return { success: false, error: { message: "boom" } } as unknown as ExportResult;
}

function fakeBlob(chunks: Uint8Array[]): Blob {
  return {
    stream() {
      let index = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index < chunks.length) {
            controller.enqueue(chunks[index]);
            index += 1;
          } else {
            controller.close();
          }
        },
      });
    },
  } as unknown as Blob;
}

function fakeStream(): FileSystemWritableFileStream {
  return {
    seek: vi.fn().mockResolvedValue(undefined),
    write: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    truncate: vi.fn().mockResolvedValue(undefined),
  } as unknown as FileSystemWritableFileStream;
}

describe("export-runner pure helpers", () => {
  it("maps extension to mime", () => {
    expect(mimeForExt("mp4")).toBe("video/mp4");
    expect(mimeForExt("mov")).toBe("video/quicktime");
    expect(mimeForExt("webm")).toBe("video/webm");
    expect(mimeForExt("wav")).toBe("audio/wav");
    expect(mimeForExt("xyz")).toBe("application/octet-stream");
  });

  it("resolves container ext from format", () => {
    expect(extForFormat("mov")).toBe("mov");
    expect(extForFormat("webm")).toBe("webm");
    expect(extForFormat("wav")).toBe("wav");
    expect(extForFormat("mp4")).toBe("mp4");
    expect(extForFormat("unknown")).toBe("mp4");
  });

  it("builds export filename with fallback", () => {
    expect(exportFilename("Vacation", "mp4")).toBe("Vacation.mp4");
    expect(exportFilename("", "mov")).toBe("export.mov");
    expect(exportFilename(undefined, "webm")).toBe("export.webm");
    expect(exportFilename("   ", "mp4")).toBe("export.mp4");
  });

  it("strips filesystem-illegal characters from the suggested filename", () => {
    expect(exportFilename("Vlog: Ep 1", "mp4")).toBe("Vlog Ep 1.mp4");
    expect(exportFilename("6/14/2026", "mov")).toBe("6 14 2026.mov");
    expect(exportFilename('a<b>c:"d"|e?f*g\\h', "webm")).toBe("a b c d e f g h.webm");
    expect(exportFilename("...hidden", "mp4")).toBe("hidden.mp4");
    expect(exportFilename("///", "mp4")).toBe("export.mp4");
  });

  it("keeps legal filename characters intact", () => {
    expect(exportFilename("My-Video_v2 (final)", "mp4")).toBe("My-Video_v2 (final).mp4");
    expect(sanitizeFilenameBase("café déjà-vu")).toBe("café déjà-vu");
  });

  it("labels progress phase", () => {
    expect(progressPhaseLabel("rendering")).toBe("rendering...");
    expect(progressPhaseLabel("encoding")).toBe("encoding...");
    expect(progressPhaseLabel("complete")).toBe("Complete!");
  });
});

describe("extForFormat codec-awareness", () => {
  it("forces mov for prores regardless of format", () => {
    expect(extForFormat("mp4", "prores")).toBe("mov");
  });
  it("keeps format-based extension otherwise", () => {
    expect(extForFormat("mp4", "h264")).toBe("mp4");
    expect(extForFormat("mov")).toBe("mov");
  });
});

describe("useExportRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEngine.initialize.mockResolvedValue(undefined);
  });

  it("advances progress and completes on success", async () => {
    mockEngine.exportVideo.mockImplementation(() => successGenerator());
    const onExported = vi.fn();
    const { result } = renderHook(() =>
      useExportRunner({ project: fakeProject(), onExported }),
    );

    expect(result.current.state.isExporting).toBe(false);

    await act(async () => {
      result.current.beginExport();
    });
    expect(result.current.state.isExporting).toBe(true);
    expect(result.current.state.phase).toBe("Initializing...");

    const settings: Partial<VideoExportSettings> = { format: "mp4", codec: "h264" };
    await act(async () => {
      await result.current.runExport(settings, "mp4", fakeStream());
    });

    expect(mockEngine.initialize).toHaveBeenCalledTimes(1);
    expect(result.current.state.complete).toBe(true);
    expect(result.current.state.isExporting).toBe(false);
    expect(result.current.state.phase).toBe("Saved!");
    expect(result.current.state.progress).toBe(100);
    expect(onExported).toHaveBeenCalledWith(settings);
  });

  it("does not announce 100% until the export generator has finished cleanup", async () => {
    let finishCleanup!: () => void;
    async function* delayedCompletion(): AsyncGenerator<
      { phase: "complete"; progress: number },
      ExportResult
    > {
      yield { phase: "complete", progress: 1 };
      await new Promise<void>((resolve) => { finishCleanup = resolve; });
      return { success: true } as ExportResult;
    }
    mockEngine.exportVideo.mockImplementation(() => delayedCompletion());
    const { result } = renderHook(() => useExportRunner({ project: fakeProject() }));
    act(() => result.current.beginExport());
    let run!: Promise<void>;
    act(() => { run = result.current.runExport({ format: "mp4" }, "mp4", fakeStream()); });
    await waitFor(() => expect(result.current.state.phase).toBe("Finishing export..."));
    expect(result.current.state).toMatchObject({ isExporting: true, complete: false });
    expect(result.current.state.progress).toBeLessThan(100);
    await act(async () => {
      finishCleanup();
      await run;
    });
    expect(result.current.state).toMatchObject({ isExporting: false, complete: true, progress: 100, phase: "Saved!" });
  });

  it("keeps a successful export successful if its notification fails", async () => {
    mockEngine.exportVideo.mockImplementation(() => successGenerator());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useExportRunner({
      project: fakeProject(), onExported: () => { throw new Error("analytics unavailable"); },
    }));
    const factory = vi.fn();
    act(() => result.current.beginExport());
    await act(async () => { await result.current.runExport({ format: "mp4" }, "mp4", fakeStream(), factory); });
    expect(result.current.state).toMatchObject({ complete: true, isExporting: false, error: null });
    expect(mockEngine.exportVideo.mock.calls[0][3]).toBe(factory);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("throws and surfaces error on failed result", async () => {
    mockEngine.exportVideo.mockImplementation(() => failureGenerator());
    const { result } = renderHook(() => useExportRunner({ project: fakeProject() }));

    await act(async () => {
      result.current.beginExport();
    });

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.runExport({ format: "mp4" }, "mp4", fakeStream());
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("boom");

    act(() => {
      result.current.failExport(caught);
    });
    expect(result.current.state.isExporting).toBe(false);
    expect(result.current.state.error).toBe("boom");
  });

  it("swallows AbortError without surfacing an error", () => {
    const { result } = renderHook(() => useExportRunner({ project: fakeProject() }));
    act(() => {
      result.current.beginExport();
    });
    const abort = new Error("User cancelled");
    abort.name = "AbortError";
    act(() => {
      result.current.failExport(abort);
    });
    expect(result.current.state.isExporting).toBe(false);
    expect(result.current.state.error).toBeNull();
  });

  it("cancels stalled initialization, aborts the destination, and never starts a generator", async () => {
    mockEngine.initialize.mockReturnValueOnce(new Promise(() => {}));
    const writable = fakeStream();
    const { result } = renderHook(() => useExportRunner({ project: fakeProject() }));
    act(() => result.current.beginExport());
    let pending!: Promise<void>;
    act(() => { pending = result.current.runExport({ format: "mp4" }, "mp4", writable); });
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    act(() => result.current.cancel());
    await act(async () => { await assertion; });
    expect(writable.abort).toHaveBeenCalled();
    expect(mockEngine.exportVideo).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({ isExporting: false, error: null, complete: false });
  });

  it("does not let an old cancelled run reset a newer export", async () => {
    mockEngine.initialize.mockReturnValueOnce(new Promise(() => {}));
    const { result } = renderHook(() => useExportRunner({ project: fakeProject() }));
    act(() => result.current.beginExport());
    let oldRun!: Promise<void>;
    act(() => { oldRun = result.current.runExport({ format: "mp4" }, "mp4", fakeStream()); });
    const oldError = oldRun.catch((error: unknown) => error);
    act(() => { result.current.cancel(); result.current.beginExport(); });
    const error = await oldError;
    act(() => result.current.failExport(error));
    expect(error).toMatchObject({ name: "AbortError" });
    expect(result.current.state).toMatchObject({ isExporting: true, phase: "Initializing...", error: null });
  });

  it("aborts the file and exposes an initialization failure", async () => {
    mockEngine.initialize.mockRejectedValueOnce(new Error("renderer unavailable"));
    const writable = fakeStream();
    const { result } = renderHook(() => useExportRunner({ project: fakeProject() }));
    act(() => result.current.beginExport());
    await act(async () => {
      try { await result.current.runExport({ format: "mp4" }, "mp4", writable); }
      catch (error) { result.current.failExport(error); }
    });
    expect(writable.abort).toHaveBeenCalled();
    expect(mockEngine.exportVideo).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({ isExporting: false, error: "renderer unavailable", complete: false });
  });

  it("writes a successful audio export and reports completion", async () => {
    mockEngine.exportAudio.mockImplementation(async function* () {
      yield { phase: "rendering", progress: 0.5 };
      return { success: true, blob: fakeBlob([new Uint8Array([1, 2, 3])]) } as ExportResult;
    });
    const writable = fakeStream();
    const { result } = renderHook(() => useExportRunner({ project: fakeProject() }));
    act(() => result.current.beginExport());
    await act(async () => { await result.current.runAudioExport({ format: "wav" }, writable); });
    expect(writable.write).toHaveBeenCalledTimes(1);
    expect(writable.close).toHaveBeenCalledTimes(1);
    expect(result.current.state).toMatchObject({ isExporting: false, complete: true, progress: 100, error: null });
  });

  it("cancels an audio render and discards the incomplete file", async () => {
    let rejectRender!: (error: Error) => void;
    const rendering = new Promise<void>((_resolve, reject) => { rejectRender = reject; });
    const renderStarted = vi.fn();
    mockEngine.exportAudio.mockImplementation(async function* () {
      yield { phase: "preparing", progress: 0 };
      renderStarted();
      await rendering;
      return { success: true, blob: fakeBlob([new Uint8Array([1])]) } as ExportResult;
    });
    mockEngine.cancel.mockImplementationOnce(() => rejectRender(new DOMException("Cancelled", "AbortError")));
    const writable = fakeStream();
    const { result } = renderHook(() => useExportRunner({ project: fakeProject() }));
    act(() => result.current.beginExport());
    let pending!: Promise<void>;
    act(() => { pending = result.current.runAudioExport({ format: "wav" }, writable); });
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await act(async () => { await vi.waitFor(() => expect(renderStarted).toHaveBeenCalled()); });
    act(() => result.current.cancel());
    await act(async () => { await assertion; });
    expect(writable.abort).toHaveBeenCalled();
    expect(writable.close).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({ isExporting: false, complete: false, error: null });
  });

  it("cancels a stalled audio-file write instead of reporting completion", async () => {
    mockEngine.exportAudio.mockImplementation(async function* () {
      yield { phase: "preparing", progress: 0 };
      return { success: true, blob: fakeBlob([new Uint8Array([1, 2, 3])]) } as ExportResult;
    });
    const writable = fakeStream();
    vi.mocked(writable.write).mockReturnValueOnce(new Promise(() => {}));
    const { result } = renderHook(() => useExportRunner({ project: fakeProject() }));
    act(() => result.current.beginExport());
    let pending!: Promise<void>;
    act(() => { pending = result.current.runAudioExport({ format: "wav" }, writable); });
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await act(async () => { await vi.waitFor(() => expect(writable.write).toHaveBeenCalled()); });
    act(() => result.current.cancel());
    await act(async () => { await assertion; });
    expect(writable.abort).toHaveBeenCalled();
    expect(writable.close).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({ isExporting: false, complete: false, error: null });
  });

  it("cancel calls engine.cancel and resets state", () => {
    const { result } = renderHook(() => useExportRunner({ project: fakeProject() }));
    act(() => {
      result.current.beginExport();
    });
    act(() => {
      result.current.cancel();
    });
    expect(mockEngine.cancel).toHaveBeenCalledTimes(1);
    expect(result.current.state.isExporting).toBe(false);
    expect(result.current.state.progress).toBe(0);
  });
});

describe("writeBlobToWritable", () => {
  it("streams blob bytes into a plain-object writable and closes it", async () => {
    const chunks: number[] = [];
    let closed = false;
    const writable = {
      seek: vi.fn().mockResolvedValue(undefined),
      write: vi.fn(async (data: ArrayBufferView) => {
        chunks.push(data.byteLength);
      }),
      close: vi.fn(async () => {
        closed = true;
      }),
      abort: vi.fn().mockResolvedValue(undefined),
      truncate: vi.fn().mockResolvedValue(undefined),
    } as unknown as FileSystemWritableFileStream;

    const blob = fakeBlob([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]);
    await writeBlobToWritable(blob, writable);

    expect(closed).toBe(true);
    expect(chunks.reduce((sum, n) => sum + n, 0)).toBe(5);
  });

  it("aborts and rethrows when a write fails", async () => {
    const writable = {
      seek: vi.fn().mockResolvedValue(undefined),
      write: vi.fn(async () => {
        throw new Error("disk full");
      }),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
      truncate: vi.fn().mockResolvedValue(undefined),
    } as unknown as FileSystemWritableFileStream;

    const blob = fakeBlob([new Uint8Array([1, 2, 3])]);
    await expect(writeBlobToWritable(blob, writable)).rejects.toThrow("disk full");
    expect(writable.abort).toHaveBeenCalledTimes(1);
    expect(writable.close).not.toHaveBeenCalled();
  });
});

describe("useExportRunner showSavePicker fallback", () => {
  const win = window as unknown as Record<string, unknown>;
  const urlApi = URL as unknown as {
    createObjectURL?: unknown;
    revokeObjectURL?: unknown;
  };
  const hadPicker = "showSaveFilePicker" in window;
  const originalPicker = win.showSaveFilePicker;
  const originalCreate = urlApi.createObjectURL;
  const originalRevoke = urlApi.revokeObjectURL;
  const originalStorage = Object.getOwnPropertyDescriptor(navigator, "storage");

  let createObjectURL: ReturnType<typeof vi.fn>;
  let click: MockInstance;

  const setOpfs = (value: unknown) => {
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value,
    });
  };

  beforeEach(() => {
    createObjectURL = vi.fn().mockReturnValue("blob:fake");
    urlApi.createObjectURL = createObjectURL;
    urlApi.revokeObjectURL = vi.fn();
    click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    setOpfs(undefined);
  });

  afterEach(() => {
    // Release delayed download resources while their mocked OPFS methods still exist.
    window.dispatchEvent(new Event("pagehide"));
    vi.restoreAllMocks();
    urlApi.createObjectURL = originalCreate;
    urlApi.revokeObjectURL = originalRevoke;
    if (originalStorage) {
      Object.defineProperty(navigator, "storage", originalStorage);
    } else {
      delete (navigator as unknown as Record<string, unknown>).storage;
    }
    if (hadPicker) {
      win.showSaveFilePicker = originalPicker;
    } else {
      delete win.showSaveFilePicker;
    }
    delete win["kove-advanced"];
    delete win.__kove_advancedExportPath;
  });

  it("falls back to an in-memory download when OPFS is unavailable and the picker is blocked", async () => {
    const picker = vi.fn().mockRejectedValue(
      new DOMException(
        "Failed to execute 'showSaveFilePicker' on 'Window': Cross origin sub frames aren't allowed to show a file picker.",
        "SecurityError",
      ),
    );
    win.showSaveFilePicker = picker;

    const { result } = renderHook(() => useExportRunner({ project: fakeProject() }));

    const writable = await result.current.showSavePicker("My Movie.mp4", "mp4");
    expect(picker).toHaveBeenCalledTimes(1);

    await writeBlobToWritable(fakeBlob([new Uint8Array([1, 2, 3, 4])]), writable);

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("streams to an OPFS temp file (not memory) when the picker is blocked", async () => {
    win.showSaveFilePicker = vi
      .fn()
      .mockRejectedValue(new DOMException("blocked", "SecurityError"));

    const opfsWrites: number[] = [];
    let opfsClosed = false;
    const opfsWritable = {
      seek: vi.fn().mockResolvedValue(undefined),
      write: vi.fn(async (chunk: ArrayBufferView) => {
        opfsWrites.push(chunk.byteLength);
      }),
      truncate: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(async () => {
        opfsClosed = true;
      }),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    const fileHandle = {
      createWritable: vi.fn().mockResolvedValue(opfsWritable),
      getFile: vi.fn().mockResolvedValue(new Blob([new Uint8Array([9, 9, 9])])),
    };
    const getFileHandle = vi.fn().mockResolvedValue(fileHandle);
    async function* noKeys(): AsyncGenerator<string> {}
    const getDirectory = vi.fn().mockResolvedValue({
      getFileHandle,
      removeEntry: vi.fn().mockResolvedValue(undefined),
      keys: noKeys,
    });
    setOpfs({ getDirectory });

    const { result } = renderHook(() => useExportRunner({ project: fakeProject() }));
    const writable = await result.current.showSavePicker("Clip.mp4", "mp4");

    expect(getDirectory).toHaveBeenCalledTimes(1);
    expect(fileHandle.createWritable).toHaveBeenCalledTimes(1);

    await writeBlobToWritable(fakeBlob([new Uint8Array([1, 2, 3, 4, 5])]), writable);

    expect(opfsWrites.reduce((sum, n) => sum + n, 0)).toBe(5);
    expect(opfsClosed).toBe(true);
    expect(fileHandle.getFile).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("rethrows AbortError so a user cancel is not turned into a download", async () => {
    const picker = vi
      .fn()
      .mockRejectedValue(new DOMException("User cancelled", "AbortError"));
    win.showSaveFilePicker = picker;

    const { result } = renderHook(() => useExportRunner({ project: fakeProject() }));

    await expect(
      result.current.showSavePicker("My Movie.mp4", "mp4"),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("createDownloadWritable uses the browser save picker when available", async () => {
    const writable = fakeStream();
    const handle = {
      createWritable: vi.fn().mockResolvedValue(writable),
    };
    const picker = vi.fn().mockResolvedValue(handle);
    win.showSaveFilePicker = picker;

    await expect(
      createDownloadWritable("Motion Scene.mp4", "video/mp4"),
    ).resolves.toBe(writable);
    expect(picker).toHaveBeenCalledWith({
      suggestedName: "Motion Scene.mp4",
      types: [
        {
          description: "Media file",
          accept: { "video/mp4": [".mp4"] },
        },
      ],
    });
  });

  it("createDownloadWritable resolves the native ffmpeg output path on desktop", async () => {
    const showSaveDialog = vi
      .fn()
      .mockResolvedValue("/Users/me/Movies/Rubik.mp4");
    win["kove-advanced"] = {
      platform: "desktop",
      fs: {
        showSaveDialog,
        openWrite: vi.fn().mockResolvedValue("handle-1"),
        writeChunk: vi.fn().mockResolvedValue(undefined),
        closeWrite: vi.fn().mockResolvedValue(undefined),
        abortWrite: vi.fn().mockResolvedValue(undefined),
      },
    };

    const writable = await createDownloadWritable("Rubik.mp4", "video/mp4");

    expect(showSaveDialog).toHaveBeenCalledTimes(1);
    expect(win.__kove_advancedExportPath).toBe("/Users/me/Movies/Rubik.mp4");
    expect(writable).toBeDefined();
  });

  it("desktop stream writable forwards Uint8Array chunks without an ArrayBuffer copy", async () => {
    const writeChunk = vi.fn().mockResolvedValue(undefined);
    win["kove-advanced"] = {
      platform: "desktop",
      fs: {
        showSaveDialog: vi.fn().mockResolvedValue("/Users/me/Movies/Rubik.mp4"),
        openWrite: vi.fn().mockResolvedValue("handle-1"),
        writeChunk,
        closeWrite: vi.fn().mockResolvedValue(undefined),
        abortWrite: vi.fn().mockResolvedValue(undefined),
      },
    };

    const { result } = renderHook(() => useExportRunner({ project: fakeProject() }));
    const writable = await result.current.showSavePicker(
      "Rubik.mp4",
      "mp4",
      { streamToFile: true },
    );
    const chunk = new Uint8Array([1, 2, 3]);

    await writable.write(chunk);

    expect(writeChunk).toHaveBeenCalledWith("handle-1", chunk, 0);
  });

  it("writes Blob ZIP data, seek/truncate commands and holes in the memory fallback", async () => {
    delete win.showSaveFilePicker;
    const writable = await createDownloadWritable("frames.zip", mimeForExt("zip"));
    await writable.write(new Blob([new Uint8Array([65, 66])], { type: "application/zip" }));
    await writable.write({ type: "write", position: 4, data: new Uint8Array([69, 70]) });
    await writable.write({ type: "seek", position: 2 });
    await writable.write(new Uint8Array([67]));
    await writable.write({ type: "truncate", size: 5 });
    await writable.close();
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });
    expect(blob.type).toBe("application/zip");
    expect([...bytes]).toEqual([65, 66, 67, 0, 69]);
    await expect(writable.write(new Uint8Array([1]))).rejects.toThrow(/closed/i);
  });

  it("rejects invalid data and aborts without downloading the memory fallback", async () => {
    delete win.showSaveFilePicker;
    const writable = await createDownloadWritable("frames.zip", mimeForExt("zip"));
    await expect(writable.write({} as never)).rejects.toThrow(/unsupported data/i);
    await expect(writable.seek(-1)).rejects.toThrow(/non-negative/i);
    await writable.abort();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("writes Blob data and truncation commands to the desktop stream", async () => {
    const writeChunk = vi.fn().mockResolvedValue(undefined);
    const truncateWrite = vi.fn().mockResolvedValue(undefined);
    const abortWrite = vi.fn().mockResolvedValue(undefined);
    win["kove-advanced"] = { platform: "desktop", fs: {
      showSaveDialog: vi.fn().mockResolvedValue("/tmp/frames.zip"),
      openWrite: vi.fn().mockResolvedValue("handle-1"), writeChunk, truncateWrite,
      closeWrite: vi.fn().mockResolvedValue(undefined), abortWrite,
    } };
    const writable = await createDownloadWritable("frames.zip", mimeForExt("zip"));
    await writable.write(new Blob([new Uint8Array([1, 2, 3])]));
    await writable.write({ type: "write", position: 1, data: new Uint8Array([9]) });
    await writable.truncate(2);
    expect(writeChunk).toHaveBeenNthCalledWith(1, "handle-1", new Uint8Array([1, 2, 3]), 0);
    expect(writeChunk).toHaveBeenNthCalledWith(2, "handle-1", new Uint8Array([9]), 1);
    expect(truncateWrite).toHaveBeenCalledWith("handle-1", 2);
    await writable.abort();
    expect(abortWrite).toHaveBeenCalledOnce();
  });

  it("cleans up OPFS files when opening or publishing them fails", async () => {
    delete win.showSaveFilePicker;
    const removeEntry = vi.fn().mockResolvedValue(undefined);
    const fileHandle = { createWritable: vi.fn().mockRejectedValueOnce(new Error("open failed")) };
    setOpfs({ getDirectory: vi.fn().mockResolvedValue({
      getFileHandle: vi.fn().mockResolvedValue(fileHandle), removeEntry,
    }) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fallback = await createDownloadWritable("fallback.zip", "application/zip");
    expect(removeEntry).toHaveBeenCalledTimes(1);
    await fallback.abort();
    fileHandle.createWritable.mockResolvedValueOnce({ close: vi.fn().mockResolvedValue(undefined) });
    Object.assign(fileHandle, { getFile: vi.fn().mockRejectedValue(new Error("read failed")) });
    const opfs = await createDownloadWritable("broken.zip", "application/zip");
    await expect(opfs.close()).rejects.toThrow("read failed");
    expect(removeEntry).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("releases a successful OPFS download on pagehide", async () => {
    delete win.showSaveFilePicker;
    const removeEntry = vi.fn().mockResolvedValue(undefined);
    setOpfs({ getDirectory: vi.fn().mockResolvedValue({
      getFileHandle: vi.fn().mockResolvedValue({
        createWritable: vi.fn().mockResolvedValue({ close: vi.fn().mockResolvedValue(undefined) }),
        getFile: vi.fn().mockResolvedValue(new Blob(["ok"])),
      }), removeEntry,
    }) });
    const writable = await createDownloadWritable("ok.zip", "application/zip");
    await writable.close();
    expect(removeEntry).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("pagehide"));
    expect(removeEntry).toHaveBeenCalledTimes(1);
    expect(urlApi.revokeObjectURL).toHaveBeenCalledWith("blob:fake");
  });

  it("does not sweep an old OPFS export that another tab still owns", async () => {
    delete win.showSaveFilePicker;
    const stamp = Date.now() - 2 * 60 * 60 * 1000;
    const active = `.kove-advanced-export-${stamp}-active.tmp`;
    const stale = `.kove-advanced-export-${stamp}-stale.tmp`;
    const removeEntry = vi.fn().mockResolvedValue(undefined);
    async function* keys() { yield active; yield stale; }
    setOpfs({ getDirectory: vi.fn().mockResolvedValue({
      keys, removeEntry, getFileHandle: vi.fn().mockResolvedValue({
        createWritable: vi.fn().mockResolvedValue({ abort: vi.fn().mockResolvedValue(undefined) }),
      }),
    }) });
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
    const request = vi.fn((name: string, _options: unknown, callback: (lock: unknown) => Promise<void>) =>
      Promise.resolve(callback(name.endsWith(active) ? null : { name })));
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
    try {
      const writable = await createDownloadWritable("new.zip", "application/zip");
      expect(removeEntry).toHaveBeenCalledWith(stale);
      expect(removeEntry).not.toHaveBeenCalledWith(active);
      await writable.abort();
    } finally {
      if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks);
      else delete (navigator as unknown as Record<string, unknown>).locks;
    }
  });

  it("recognizes cross-realm AbortError objects from the picker", async () => {
    win.showSaveFilePicker = vi.fn().mockRejectedValue({ name: "AbortError" });
    await expect(createDownloadWritable("cancel.zip", "application/zip")).rejects.toMatchObject({ name: "AbortError" });
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("createDownloadWritable rethrows AbortError when the native save dialog is cancelled", async () => {
    win["kove-advanced"] = {
      platform: "desktop",
      fs: {
        showSaveDialog: vi.fn().mockResolvedValue(null),
        openWrite: vi.fn(),
      },
    };

    await expect(
      createDownloadWritable("Rubik.mp4", "video/mp4"),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(win.__kove_advancedExportPath).toBeUndefined();
  });
});
