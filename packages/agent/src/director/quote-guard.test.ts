import { describe, expect, it } from "vitest";
import type { Project } from "@kove-advanced/core/types/project";
import type { SegmentMap } from "@kove-advanced/creation-schema";
import type { EditingHost, TextOverlayOptions, OverlayRef } from "../host";
import { HeadlessHost } from "../headless-host";
import { executeTool } from "../executor";
import { MockLLMClient, type LLMResponse } from "../llm";
import { buildDirectorPrompt } from "./director-prompt";
import {
  QUOTE_MARKS_STRIPPED_CODE,
  isWrappedInQuoteMarks,
  segmentMapHasTranscript,
  stripUnverifiedQuoteMarks,
  stripWrappedQuoteMarks,
} from "./quote-guard";
import type { EditPlan } from "@kove-advanced/creation-schema";

describe("quote detection", () => {
  it("recognizes matching straight and curly wrapped pairs", () => {
    expect(isWrappedInQuoteMarks('"hello world"')).toBe(true);
    expect(isWrappedInQuoteMarks("\u201chello world\u201d")).toBe(true);
    expect(isWrappedInQuoteMarks("'hello world'")).toBe(true);
    expect(isWrappedInQuoteMarks("\u2018hello world\u2019")).toBe(true);
  });

  it("ignores apostrophes, unclosed marks, and mismatched pairs", () => {
    expect(isWrappedInQuoteMarks("don't stop")).toBe(false);
    expect(isWrappedInQuoteMarks("'tis the season")).toBe(false);
    expect(isWrappedInQuoteMarks('"unclosed')).toBe(false);
    expect(isWrappedInQuoteMarks("unclosed\"")).toBe(false);
    expect(isWrappedInQuoteMarks("\u201cmixed'")).toBe(false);
    expect(isWrappedInQuoteMarks("plain declarative caption")).toBe(false);
    expect(isWrappedInQuoteMarks("\"")).toBe(false);
    expect(isWrappedInQuoteMarks("")).toBe(false);
  });

  it("strips the outer marks and keeps the words", () => {
    expect(stripWrappedQuoteMarks('"hello world"')).toBe("hello world");
    expect(stripWrappedQuoteMarks("\u201chello world\u201d")).toBe("hello world");
    expect(stripWrappedQuoteMarks('  "  spaced  "  ')).toBe("spaced");
    expect(stripWrappedQuoteMarks("don't stop")).toBe("don't stop");
  });
});

describe("segmentMapHasTranscript", () => {
  it("is false for empty maps and maps without transcript words", () => {
    expect(segmentMapHasTranscript(null)).toBe(false);
    expect(segmentMapHasTranscript({ videos: [] })).toBe(false);
    expect(
      segmentMapHasTranscript({
        videos: [{ videoId: "v", duration: 10, segments: [{ id: "s", transcript: "   " } as never] }],
      }),
    ).toBe(false);
  });

  it("is true when any segment carries transcript words", () => {
    expect(
      segmentMapHasTranscript({
        videos: [
          {
            videoId: "v",
            duration: 10,
            segments: [
              { id: "s", transcript: undefined } as never,
              { id: "t", transcript: "we went for it" } as never,
            ],
          },
        ],
      }),
    ).toBe(true);
  });
});

function planWithText(content: string): EditPlan {
  return {
    segments: [],
    textElements: [
      {
        content,
        style: "caption",
        startTime: 0,
        duration: 2,
        rationale: "test",
      },
    ],
    effects: [],
    transitions: [],
    audioDecisions: [],
    metadata: { targetDuration: 2, targetPlatform: "social", genre: "test", pacing: "fast", rationale: "t" },
  } as unknown as EditPlan;
}

describe("stripUnverifiedQuoteMarks", () => {
  it("strips marks and warns when no transcript backs the project", () => {
    const { plan, warnings } = stripUnverifiedQuoteMarks(planWithText('"WE ARE BACK"'), {
      transcriptAvailable: false,
    });
    expect(plan.textElements[0]!.content).toBe("WE ARE BACK");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: QUOTE_MARKS_STRIPPED_CODE,
      severity: "warning",
      path: "textElements[0].content",
    });
  });

  it("leaves declarative text and transcribed projects untouched", () => {
    const plain = stripUnverifiedQuoteMarks(planWithText("WE ARE BACK"), { transcriptAvailable: false });
    expect(plain.warnings).toHaveLength(0);
    expect(plain.plan.textElements[0]!.content).toBe("WE ARE BACK");

    const transcribed = stripUnverifiedQuoteMarks(planWithText('"WE ARE BACK"'), {
      transcriptAvailable: true,
    });
    expect(transcribed.plan.textElements[0]!.content).toBe('"WE ARE BACK"');
    expect(transcribed.warnings).toHaveLength(0);
  });

  it("returns the same plan reference when nothing changed", () => {
    const plan = planWithText("clean");
    const { plan: out } = stripUnverifiedQuoteMarks(plan, { transcriptAvailable: false });
    expect(out).toBe(plan);
  });
});

// ---------------------------------------------------------------------------
// Integration through the real plan_edit funnel — initial and repair paths.
// ---------------------------------------------------------------------------

const END: LLMResponse = { text: "Done.", stopReason: "end_turn", toolUses: [] };

function planResponse(input: Record<string, unknown>): LLMResponse {
  return {
    text: "",
    stopReason: "tool_use",
    toolUses: [{ id: `plan-${Math.random().toString(36).slice(2)}`, name: "submit_edit_plan", input }],
  };
}

function makeProject(): Project {
  return {
    id: "quote-guard-project",
    name: "QuoteGuard",
    createdAt: 0,
    modifiedAt: 0,
    settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48000, channels: 2 },
    timeline: { duration: 0, tracks: [], subtitles: [], markers: [] },
    mediaLibrary: {
      items: [{ id: "video-1", name: "footage.mp4", type: "video", metadata: { duration: 10 } }],
    },
  } as unknown as Project;
}

function harness(script: LLMResponse[]): {
  host: EditingHost;
  createdTextOverlays: TextOverlayOptions[];
} {
  const project = makeProject();
  const host = new HeadlessHost(project) as unknown as EditingHost & { llm: NonNullable<EditingHost["llm"]> };
  const createdTextOverlays: TextOverlayOptions[] = [];
  let seq = 0;
  host.createTextOverlay = async (options: TextOverlayOptions): Promise<OverlayRef> => {
    createdTextOverlays.push(options);
    seq += 1;
    return { id: `text-${seq}`, trackId: "text-track" };
  };
  host.llm = { client: new MockLLMClient(script), provider: "openai" };
  return { host, createdTextOverlays };
}

function planFixture(textElements: Record<string, unknown>[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    segments: [
      {
        sourceVideoId: "video_0",
        sourceStartTime: 0,
        sourceEndTime: 4,
        trackIndex: 0,
        targetPosition: 0,
        effects: [],
        cameraMoves: [{ move: "slow-push", intensity: 0.5 }],
        rationale: "hook",
      },
    ],
    textElements,
    effects: [{ type: "brightness", params: { value: 5 }, targetSegmentIndex: 0, rationale: "lift" }],
    transitions: [],
    audioDecisions: [{ type: "silence", startTime: 0, duration: 4, rationale: "no source" }],
    metadata: { targetDuration: 4, targetPlatform: "social", genre: "test", pacing: "fast", rationale: "quote fixture" },
    ...overrides,
  };
}

describe("quote-guard through plan_edit", () => {
  it("strips marks from an accepted plan and reports the warning", async () => {
    const { host, createdTextOverlays } = harness([
      planResponse(
        planFixture([
          { content: '"I can\'t believe it"', style: "caption", startTime: 0.5, duration: 2, rationale: "hook" },
          { content: "declarative caption", style: "caption", startTime: 2.5, duration: 1.5, rationale: "frame" },
        ]),
      ),
      END,
    ]);
    const result = await executeTool("plan_edit", { prompt: "make a highlight" }, host);
    expect(result.ok).toBe(true);

    const data = result.data as { validationWarnings: { code: string }[] };
    expect(data.validationWarnings.map((w) => w.code)).toContain(QUOTE_MARKS_STRIPPED_CODE);
    // Timeline got the words, not the quote marks.
    expect(createdTextOverlays[0]!.text).toBe("I can't believe it");
    expect(createdTextOverlays[1]!.text).toBe("declarative caption");
  });

  it("covers the repair path: stripped marks survive a validation repair", async () => {
    // First response is BLOCKING-invalid (empty segments) AND carries quotes;
    // the repair response is valid and still carries quotes.
    const { host, createdTextOverlays } = harness([
      planResponse(planFixture([{ content: '"invented words"', style: "caption", startTime: 0, duration: 2, rationale: "x" }], { segments: [] })),
      planResponse(
        planFixture([{ content: '"repaired invented words"', style: "caption", startTime: 0, duration: 2, rationale: "x" }]),
      ),
      END,
    ]);
    const result = await executeTool("plan_edit", { prompt: "make a highlight" }, host);
    expect(result.ok).toBe(true);

    const data = result.data as { validationWarnings: { code: string }[] };
    expect(data.validationWarnings.map((w) => w.code)).toContain(QUOTE_MARKS_STRIPPED_CODE);
    expect(createdTextOverlays[0]!.text).toBe("repaired invented words");
  });
});

describe("quote-guard prompt directive", () => {
  const bareMap: SegmentMap = {
    videos: [{ videoId: "v1", duration: 10, segments: [] }],
  };

  it("forbids quoted captions when no transcript exists", () => {
    const prompt = buildDirectorPrompt(bareMap, "make a highlight");
    expect(prompt).toContain("Quotes and spoken words");
    expect(prompt).toContain("No transcript exists");
    expect(prompt).toContain("strips them and warns");
  });

  it("flips to a verbatim-only rule once transcripts exist", () => {
    const withWords: SegmentMap = {
      videos: [
        {
          videoId: "v1",
          duration: 10,
          segments: [{ id: "s1", startTime: 0, endTime: 5, description: "d", sceneType: "b-roll", motionLevel: "medium", hasDialogue: true, visualContent: "c", confidence: 0.9, transcript: "we went for it" } as never],
        },
      ],
    };
    const prompt = buildDirectorPrompt(withWords, "make a highlight");
    expect(prompt).toContain("word-for-word from transcript text");
    expect(prompt).not.toContain("No transcript exists");
  });
});
