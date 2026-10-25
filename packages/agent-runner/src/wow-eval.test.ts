import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scoreVisualCandidate } from "./wow-eval";

const config = {
  baseUrl: "http://127.0.0.1:20128/v1",
  apiKey: "test-secret",
  model: "test-vision-model",
};

const passingScore = {
  visualScore: 8.8,
  dimensions: {
    intentAndStory: 9,
    momentSelection: 9,
    pacingAndRhythm: 8,
    composition: 9,
    visualCoherence: 8,
    editingCraft: 9,
    typography: 8,
    impact: 9,
  },
  strengths: ["Clear visual progression"],
  issues: ["A title is slightly small"],
  referenceComparison: "Comparable pacing with cleaner framing.",
};

async function withFrames<T>(run: (candidate: string, reference: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), "kove-wow-score-"));
  try {
    const candidate = path.join(directory, "candidate.jpg");
    const reference = path.join(directory, "reference.jpg");
    await Promise.all([
      writeFile(candidate, Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
      writeFile(reference, Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
    ]);
    return await run(candidate, reference);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("rendered watchability vision screen", () => {
  it("compares candidate frames with reference frames and applies the strict screening floor", async () => {
    await withFrames(async (candidate, reference) => {
      let requestBody: Record<string, unknown> | undefined;
      const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(passingScore) } }],
        }), { status: 200 });
      });
      const result = await scoreVisualCandidate({
        config,
        prompt: "Create a clean, tense highlight.",
        category: "game",
        candidateFrames: [{ filePath: candidate, timestamp: 1.5 }],
        referenceFrames: [{ filePath: reference, timestamp: 2.5 }],
        fetchFn,
      });

      expect(result.visualScore).toBe(8.8);
      expect(result.minimumVisualBarMet).toBe(true);
      expect(result.dimensions.pacingAndRhythm).toBe(8);
      const messages = requestBody?.messages as { content: { type: string }[] }[] | undefined;
      expect(messages?.[0]?.content.filter((part) => part.type === "image_url")).toHaveLength(2);
      expect(fetchFn).toHaveBeenCalledWith(
        `${config.baseUrl}/chat/completions`,
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("does not let a high average hide a weak dimension", async () => {
    await withFrames(async (candidate, reference) => {
      const fetchFn = vi.fn(async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          ...passingScore,
          dimensions: { ...passingScore.dimensions, momentSelection: 6.9 },
        }) } }],
      }), { status: 200 }));
      const result = await scoreVisualCandidate({
        config,
        prompt: "Make the moment land.",
        category: "sport",
        candidateFrames: [{ filePath: candidate, timestamp: 0 }],
        referenceFrames: [{ filePath: reference, timestamp: 0 }],
        fetchFn,
      });
      expect(result.minimumVisualBarMet).toBe(false);
    });
  });

  it("fails explicitly when the model response is malformed", async () => {
    await withFrames(async (candidate, reference) => {
      const fetchFn = vi.fn(async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ ...passingScore, visualScore: 11 }) } }],
      }), { status: 200 }));
      await expect(scoreVisualCandidate({
        config,
        prompt: "Make the best edit.",
        category: "game",
        candidateFrames: [{ filePath: candidate, timestamp: 0 }],
        referenceFrames: [{ filePath: reference, timestamp: 0 }],
        fetchFn,
      })).rejects.toThrow("invalid visualScore score");
    });
  });

  it("does not expose credentials when the provider rejects a request", async () => {
    await withFrames(async (candidate, reference) => {
      const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-secret");
        return new Response("unsupported image input", { status: 400 });
      });
      await expect(scoreVisualCandidate({
        config,
        prompt: "Make the best edit.",
        category: "game",
        candidateFrames: [{ filePath: candidate, timestamp: 0 }],
        referenceFrames: [{ filePath: reference, timestamp: 0 }],
        fetchFn,
      })).rejects.toThrow("Vision model request failed (400): unsupported image input");
    });
  });
});
