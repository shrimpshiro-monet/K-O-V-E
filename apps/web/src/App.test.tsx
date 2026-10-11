import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import App from "./App";

vi.mock("./hooks/useKieAIPoller", () => ({ useKieAIPoller: () => {} }));

vi.mock("./hooks/useProjectRecovery", () => ({
  useProjectRecovery: () => ({
    isChecking: false,
    showDialog: false,
    availableSaves: [],
    recover: vi.fn(),
    dismiss: vi.fn(),
    clearAll: vi.fn(),
  }),
}));

vi.mock("./hooks/useEnsureOpenProject", () => ({ useEnsureOpenProject: () => {} }));

vi.mock("./stores/chat-store", () => ({
  useChatStore: { getState: () => ({ send: vi.fn() }) },
}));

describe("App routing", () => {
  beforeEach(() => {
    window.location.hash = "#/welcome";
  });

  it("renders the kreate entry on the welcome route instead of redirecting to the editor", async () => {
    render(<App />);

    expect(await screen.findByText("Ready to kreate?")).toBeInTheDocument();
    expect(window.location.hash).toBe("#/welcome");
  });
});
