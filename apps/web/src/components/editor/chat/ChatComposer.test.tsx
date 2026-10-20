import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useChatStore } from "../../../stores/chat-store";
import { ChatComposer } from "./ChatComposer";

describe("ChatComposer", () => {
  beforeEach(() => {
    useChatStore.getState().reset();
  });

  it("offers a paperclip for attaching a reference video", () => {
    render(<ChatComposer />);
    expect(screen.getByRole("button", { name: "Attach reference video" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Reference intent" })).toBeNull();
  });

  it("shows the attached reference and the intent picker", () => {
    useChatStore.setState({
      reference: { mediaId: "media-ref", name: "ref.webm", file: null },
    });
    render(<ChatComposer />);
    expect(screen.getByText("ref.webm")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Reference intent" })).toBeTruthy();
  });

  it("switches the reference intent", () => {
    useChatStore.setState({
      reference: { mediaId: "media-ref", name: "ref.webm", file: null },
    });
    render(<ChatComposer />);
    fireEvent.click(screen.getByRole("button", { name: "Recreate" }));
    expect(useChatStore.getState().referenceIntent).toBe("recreate");
  });

  it("removes the attached reference", () => {
    useChatStore.setState({
      reference: { mediaId: "media-ref", name: "ref.webm", file: null },
    });
    render(<ChatComposer />);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(useChatStore.getState().reference).toBeNull();
  });
});
