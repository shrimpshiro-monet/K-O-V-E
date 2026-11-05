import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AIInputTraceUpdate } from "@kove-advanced/agent";
import { AIInputInspector } from "./AIInputInspector";

const trace: AIInputTraceUpdate = {
  vision: {
    worker: "vision-worker",
    frameCount: 1,
    videos: [{
      videoId: "video-1",
      name: "skate.mp4",
      duration: 12,
      frameCount: 1,
      batches: [{
        batchIndex: 0,
        sourceTimestamps: [2.5],
        imageCount: 1,
        images: [{
          timestamp: 2.5,
          width: 320,
          height: 180,
          imageDataBase64: "ZmFrZQ==",
        }],
      }],
    }],
    segmentMap: {
      videos: [{
        videoId: "video-1",
        duration: 12,
        segments: [{
          id: "segment-1",
          startTime: 2,
          endTime: 3,
          description: "Skater lands a trick.",
          sceneType: "action",
          motionLevel: "high",
          hasDialogue: false,
          visualContent: "Skater",
          confidence: 0.9,
        }],
      }],
    },
  },
  director: {
    provider: "openai",
    segmentMap: {
      videos: [{
        videoId: "video-1",
        duration: 12,
        segments: [{
          id: "segment-1",
          startTime: 2,
          endTime: 3,
          description: "Skater lands a trick.",
          sceneType: "action",
          motionLevel: "high",
          hasDialogue: false,
          visualContent: "Skater",
          confidence: 0.9,
        }],
      }],
    },
    requests: [{
      system: "Director system prompt",
      messages: [{ role: "user", content: "Build a 12-second skate edit." }],
      tools: [{ function: { name: "submit_edit_plan" } }],
      maxTokens: 4096,
    }],
  },
};

describe("AIInputInspector", () => {
  it("shows actual vision frames and clarifies that the planner receives text", () => {
    render(<AIInputInspector trace={trace} onClose={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "What Monet sees" })).toBeInTheDocument();
    expect(screen.getByText(/planner itself receives the text segment map/i)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Vision input frame at 2.50 seconds" })).toHaveAttribute(
      "src",
      "data:image/jpeg;base64,ZmFrZQ==",
    );
  });

  it("shows the captured planner prompt, messages, and analysis map", () => {
    render(<AIInputInspector trace={trace} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Planner request" }));
    expect(screen.getByText("Director system prompt")).toBeInTheDocument();
    expect(screen.getByText(/Build a 12-second skate edit/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Analysis map" }));
    expect(screen.getByText(/Skater lands a trick/)).toBeInTheDocument();
  });
});
