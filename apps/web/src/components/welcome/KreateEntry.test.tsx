import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { KreateEntry } from "./KreateEntry";

const mockNavigate = vi.fn();
const mockImportMedia = vi.fn();
const mockCreateNewProject = vi.fn();
const mockSend = vi.fn();

let mockHasOpenProject = true;
let mockSkipWelcomeScreen = false;

vi.mock("../../hooks/use-router", () => ({
  useRouter: () => ({ navigate: mockNavigate, route: "welcome" }),
}));

vi.mock("../../stores/ui-store", () => ({
  useUIStore: (selector: (state: { skipWelcomeScreen: boolean }) => unknown) =>
    selector({ skipWelcomeScreen: mockSkipWelcomeScreen }),
}));

vi.mock("../../stores/project-store", () => ({
  useProjectStore: {
    getState: () => ({
      hasOpenProject: mockHasOpenProject,
      createNewProject: mockCreateNewProject,
      importMedia: mockImportMedia,
    }),
  },
}));

vi.mock("../../stores/chat-store", () => ({
  useChatStore: {
    getState: () => ({ send: mockSend }),
  },
}));

const VIDEO = () => new File(["clip"], "clip.mp4", { type: "video/mp4" });
const AUDIO = () => new File(["song"], "track.mp3", { type: "audio/mpeg" });

function addFiles(files: File[]): void {
  const input = document.querySelector('input[type="file"]');
  expect(input).toBeTruthy();
  fireEvent.change(input as HTMLInputElement, { target: { files } });
}

function typeBrief(text: string): void {
  fireEvent.change(screen.getByPlaceholderText(/hype reel/), { target: { value: text } });
}

describe("KreateEntry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasOpenProject = true;
    mockSkipWelcomeScreen = false;
    mockImportMedia.mockResolvedValue({ success: true, actionId: "m-1" });
  });

  it("keeps Kreate disabled until a video and a brief are present", () => {
    render(<KreateEntry />);
    expect(screen.getByRole("button", { name: "Kreate" })).toHaveAttribute("disabled");
    expect(screen.getByText("Add at least one video to continue.")).toBeInTheDocument();

    addFiles([AUDIO()]);
    typeBrief("make it punchy");
    expect(screen.getByRole("button", { name: "Kreate" })).toHaveAttribute("disabled");

    addFiles([VIDEO()]);
    expect(screen.getByRole("button", { name: "Kreate" })).not.toHaveAttribute("disabled");
  });

  it("requires a non-empty brief even with a video staged", () => {
    render(<KreateEntry />);
    addFiles([VIDEO()]);
    expect(screen.getByRole("button", { name: "Kreate" })).toHaveAttribute("disabled");
    expect(screen.getByText("Describe the edit you want.")).toBeInTheDocument();

    typeBrief("   ");
    expect(screen.getByRole("button", { name: "Kreate" })).toHaveAttribute("disabled");
  });

  it("imports every staged file, then hands the trimmed brief to send and enters the editor", async () => {
    render(<KreateEntry />);
    const video = VIDEO();
    const audio = AUDIO();
    addFiles([video, audio]);
    typeBrief("  cut the dead air and add captions  ");

    fireEvent.click(screen.getByRole("button", { name: "Kreate" }));

    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
    expect(mockSend).toHaveBeenCalledWith("cut the dead air and add captions");
    expect(mockImportMedia).toHaveBeenCalledTimes(2);
    expect(mockImportMedia).toHaveBeenNthCalledWith(1, video);
    expect(mockImportMedia).toHaveBeenNthCalledWith(2, audio);
    expect(mockNavigate).toHaveBeenCalledWith("editor");
    expect(mockCreateNewProject).not.toHaveBeenCalled();
    // Media must be in the project before the director turn starts.
    expect(mockImportMedia.mock.invocationCallOrder[0]).toBeLessThan(
      mockSend.mock.invocationCallOrder[0],
    );
  });

  it("creates a project first when none is open", async () => {
    mockHasOpenProject = false;
    render(<KreateEntry />);
    addFiles([VIDEO()]);
    typeBrief("hype reel");

    fireEvent.click(screen.getByRole("button", { name: "Kreate" }));

    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
    expect(mockCreateNewProject).toHaveBeenCalledTimes(1);
    expect(mockCreateNewProject.mock.invocationCallOrder[0]).toBeLessThan(
      mockImportMedia.mock.invocationCallOrder[0],
    );
  });

  it("stays on the entry surface and surfaces the error when an import fails", async () => {
    mockImportMedia.mockResolvedValue({
      success: false,
      error: { code: "DECODE_ERROR", message: "Failed to decode clip.mp4" },
    });
    render(<KreateEntry />);
    addFiles([VIDEO()]);
    typeBrief("hype reel");

    fireEvent.click(screen.getByRole("button", { name: "Kreate" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to decode clip.mp4");
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Kreate" })).not.toHaveAttribute("disabled");
  });

  it("re-gates Kreate when the only video is removed", () => {
    render(<KreateEntry />);
    addFiles([VIDEO()]);
    typeBrief("hype reel");
    expect(screen.getByRole("button", { name: "Kreate" })).not.toHaveAttribute("disabled");

    fireEvent.click(screen.getByRole("button", { name: "Remove clip.mp4" }));
    expect(screen.getByRole("button", { name: "Kreate" })).toHaveAttribute("disabled");
    expect(screen.getByText("Add at least one video to continue.")).toBeInTheDocument();
  });

  it("skips straight to the editor when the skip-on-startup preference is set", () => {
    mockSkipWelcomeScreen = true;
    render(<KreateEntry />);
    expect(mockNavigate).toHaveBeenCalledWith("editor");
  });
});
