import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  setFactory: vi.fn(),
  showSavePicker: vi.fn(),
  runExport: vi.fn(),
  beginExport: vi.fn(),
  finishExportSoon: vi.fn(),
  failExport: vi.fn(),
  cancel: vi.fn(),
  abort: vi.fn(),
  state: { isExporting: false, progress: 0, error: null, complete: false },
}));

vi.mock("@kove-advanced/core", () => ({
  setEncoderBackendFactory: mocks.setFactory,
  WebCodecsBackend: class WebCodecsBackend {},
}));
vi.mock("../../services/native-ffmpeg-backend", () => ({
  NativeFFmpegBackend: class NativeFFmpegBackend {},
}));
vi.mock("@kove-advanced/ui", () => ({
  ToolcraftButton: ({ label, onClick }: { label: string; onClick?: () => void }) => <button onClick={onClick}>{label}</button>,
}));
vi.mock("@/icons/Icon", () => ({ Icon: () => null }));
vi.mock("../../services/export-source-match", () => ({ deriveSourceExportMatch: () => null }));
vi.mock("../../stores/project-store", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) => selector({ project: {
    name: "Project", settings: { width: 320, height: 180, frameRate: 4 }, timeline: { duration: 1 },
  } }),
}));
vi.mock("../../services/export-runner", () => ({
  extForFormat: () => "mp4",
  exportFilename: () => "Project.mp4",
  useExportRunner: () => ({
    state: mocks.state,
    showSavePicker: mocks.showSavePicker,
    runExport: mocks.runExport,
    beginExport: mocks.beginExport,
    finishExportSoon: mocks.finishExportSoon,
    failExport: mocks.failExport,
    cancel: mocks.cancel, resetError: vi.fn(),
  }),
}));
vi.mock("../../components/editor/ExportDialog", () => ({
  ExportDialog: ({ isOpen, onExport }: { isOpen: boolean; onExport: (settings: unknown) => void }) =>
    isOpen ? <button onClick={() => onExport({ format: "mp4", codec: "h264", width: 320, height: 180, frameRate: 4, encodeMode: "balanced" })}>Start video export</button> : null,
}));

import { DesktopExportButton } from "./DesktopExportButton";
import { NativeFFmpegBackend } from "../../services/native-ffmpeg-backend";
import { WebCodecsBackend } from "@kove-advanced/core";

describe("desktop video export fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.state, { isExporting: false, progress: 0, error: null, complete: false });
    vi.stubGlobal("VideoEncoder", class {});
    mocks.showSavePicker.mockResolvedValue({ abort: mocks.abort });
    mocks.runExport.mockResolvedValue(undefined);
    mocks.abort.mockResolvedValue(undefined);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const start = () => {
    const rendered = render(<DesktopExportButton />);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("button", { name: "Start video export" }));
    return rendered;
  };
  const expectNoGlobalFactoryMutation = () => {
    expect(mocks.setFactory).not.toHaveBeenCalled();
  };

  it("uses a per-run WebCodecs factory without changing the global backend", async () => {
    start();
    await waitFor(() => expect(mocks.finishExportSoon).toHaveBeenCalled());
    expect(mocks.runExport).toHaveBeenCalledTimes(1);
    expect(mocks.showSavePicker).toHaveBeenCalledWith("Project.mp4", "mp4", { streamToFile: true });
    expect(mocks.runExport.mock.calls[0][3]({})).toBeInstanceOf(WebCodecsBackend);
    expectNoGlobalFactoryMutation();
  });

  it("never starts native fallback after the user cancels", async () => {
    mocks.runExport.mockRejectedValueOnce(new DOMException("Cancelled", "AbortError"));
    start();
    await waitFor(() => expect(mocks.failExport).toHaveBeenCalled());
    expect(mocks.runExport).toHaveBeenCalledTimes(1);
    expect(mocks.finishExportSoon).not.toHaveBeenCalled();
    expectNoGlobalFactoryMutation();
  });

  it("does not start native fallback if cancellation happens while discarding the failed file", async () => {
    let releaseAbort!: () => void;
    mocks.abort.mockReturnValueOnce(new Promise<void>((resolve) => { releaseAbort = resolve; }));
    mocks.runExport.mockRejectedValueOnce(new Error("codec unavailable"));
    const rendered = start();
    await waitFor(() => expect(mocks.abort).toHaveBeenCalled());
    mocks.state.isExporting = true;
    rendered.rerender(<DesktopExportButton />);
    fireEvent.click(screen.getByRole("button", { name: "0%" }));
    await waitFor(() => expect(mocks.failExport).toHaveBeenCalled());
    expect(mocks.cancel).toHaveBeenCalled();
    expect(mocks.failExport.mock.calls[0][0]).toMatchObject({ name: "AbortError" });
    expect(mocks.runExport).toHaveBeenCalledTimes(1);
    expect(mocks.finishExportSoon).not.toHaveBeenCalled();
    expectNoGlobalFactoryMutation();
    releaseAbort();
  });

  it("falls back to a per-run native backend on a real WebCodecs failure", async () => {
    mocks.runExport.mockRejectedValueOnce(new Error("codec unavailable")).mockResolvedValueOnce(undefined);
    start();
    await waitFor(() => expect(mocks.finishExportSoon).toHaveBeenCalled());
    expect(mocks.runExport).toHaveBeenCalledTimes(2);
    expect(mocks.abort).toHaveBeenCalled();
    expect(mocks.runExport.mock.calls[1][3]()).toBeInstanceOf(NativeFFmpegBackend);
    expectNoGlobalFactoryMutation();
  });
});
