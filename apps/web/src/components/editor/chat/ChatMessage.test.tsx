import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage as ChatMessageData } from "../../../stores/chat-store";
import { ChatMessage } from "./ChatMessage";

const assistantMessage = (text: string): ChatMessageData => ({
  id: "assistant-1",
  role: "assistant",
  text,
  toolCalls: [],
});

describe("ChatMessage", () => {
  const writeText = vi.fn(async () => undefined);

  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  it("renders assistant responses as safe GitHub-flavored Markdown", () => {
    const { container } = render(
      <ChatMessage
        message={assistantMessage(
          [
            "## Changes",
            "- Added **title text**",
            "- Used `fade-in`",
            "",
            "| Clip | Result |",
            "| --- | --- |",
            "| Intro | Updated |",
            "",
            "[Open docs](https://example.com/docs)",
            "",
            "<script>window.bad = true</script>",
          ].join("\n"),
        )}
      />,
    );

    expect(screen.getByRole("heading", { name: "Changes" })).toBeInTheDocument();
    expect(screen.getByText("title text").tagName).toBe("STRONG");
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("Updated")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open docs" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "Open docs" })).toHaveAttribute(
      "rel",
      "noreferrer noopener",
    );
    expect(container.querySelector("script")).toBeNull();
  });

  it("copies fenced code blocks", async () => {
    render(<ChatMessage message={assistantMessage("```json\n{\"ok\":true}\n```")} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('{"ok":true}'));
  });

  it("shows a pending state while waiting for the first response content", () => {
    render(
      <ChatMessage
        message={{ ...assistantMessage(""), notice: "Extracting sampled frames" }}
        pending
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Extracting sampled frames");
  });

  it("shows the active tool and its detailed progress while it runs", () => {
    render(
      <ChatMessage
        message={{
          ...assistantMessage(""),
          notice: "Creating the opening montage",
          toolCalls: [{
            id: "tool-1",
            name: "plan_edit",
            args: {},
            status: "running",
          }],
        }}
        pending
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Using tool: plan_edit");
    expect(screen.getByRole("status")).toHaveTextContent("Creating the opening montage");
  });

  it("renders application notices separately from model Markdown", () => {
    render(
      <ChatMessage
        message={{
          ...assistantMessage("Done."),
          notice: "The model stopped at its response limit.",
        }}
      />,
    );
    expect(screen.getByText("The model stopped at its response limit.")).toBeInTheDocument();
  });

  it("tags a user message that carried a reference video", () => {
    render(
      <ChatMessage
        message={{
          id: "user-1",
          role: "user",
          text: "/mirror make it punchier",
          toolCalls: [],
          reference: { name: "ref.webm", intent: "replicate" },
        }}
      />,
    );
    expect(screen.getByText("ref.webm")).toBeInTheDocument();
    expect(screen.getByText("replicate")).toBeInTheDocument();
  });
});
