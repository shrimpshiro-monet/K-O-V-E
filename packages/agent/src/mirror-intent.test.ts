import { describe, expect, it } from "vitest";
import {
  mentionsReferenceWorkflow,
  parseReferenceIntent,
  referenceIntentDirective,
} from "./mirror-intent";

describe("parseReferenceIntent", () => {
  it("reads an explicit slash command and strips it from the prompt", () => {
    const parsed = parseReferenceIntent("/mirror make the cuts punchier");
    expect(parsed.intent).toBe("replicate");
    expect(parsed.source).toBe("command");
    expect(parsed.command).toBe("/mirror");
    expect(parsed.prompt).toBe("make the cuts punchier");
  });

  it("maps every slash command to its intent", () => {
    expect(parseReferenceIntent("/recreate it").intent).toBe("recreate");
    expect(parseReferenceIntent("/reference only").intent).toBe("reference");
  });

  it("lets an explicit command win over keyword phrasing", () => {
    const parsed = parseReferenceIntent("recreate this but /mirror it");
    expect(parsed.intent).toBe("replicate");
    expect(parsed.source).toBe("command");
  });

  it("falls back to keyword phrasing", () => {
    expect(parseReferenceIntent("please replicate the reference cut").intent).toBe("replicate");
    expect(parseReferenceIntent("make something similar to the reference").intent).toBe("recreate");
    expect(parseReferenceIntent("use this only as a reference").intent).toBe("reference");
  });

  it("stays silent when the message says nothing about a reference", () => {
    const parsed = parseReferenceIntent("add a title card at 2s");
    expect(parsed.intent).toBeNull();
    expect(parsed.source).toBe("none");
    expect(parsed.prompt).toBe("add a title card at 2s");
  });
});

describe("mentionsReferenceWorkflow", () => {
  it("detects a bare slash command", () => {
    expect(mentionsReferenceWorkflow("/mirror")).toBe(true);
  });

  it("detects a reference request phrased with a mirror verb", () => {
    expect(mentionsReferenceWorkflow("match the reference pacing")).toBe(true);
  });

  it("ignores an ordinary mention of a reference", () => {
    expect(mentionsReferenceWorkflow("reference the previous plan")).toBe(false);
  });
});

describe("referenceIntentDirective", () => {
  it("tells the model the structure is already applied and forbids re-planning", () => {
    const directive = referenceIntentDirective({
      intent: "replicate",
      referenceName: "clip.webm",
      referenceMediaId: "media-1",
      attached: true,
      applied: "structure",
      shotCount: 12,
      fps: "30/1",
      aspectRatio: "576x640",
      dominantMoves: ["pan-left", "static"],
      beatCount: 24,
      captionWindowCount: 5,
    });
    expect(directive).toContain("[REFERENCE]");
    expect(directive).toContain("12 shots");
    expect(directive).toContain("30/1 fps");
    expect(directive).toContain("pan-left, static");
    expect(directive).toContain("Already done for you");
    expect(directive).toContain("Do NOT call plan_edit");
    expect(directive).toContain("analysisRole=reference");
  });

  it("asks the model to re-author the creative layer for recreate", () => {
    const directive = referenceIntentDirective({
      intent: "recreate",
      referenceName: "clip.webm",
      attached: true,
      applied: "structure",
    });
    expect(directive).toContain("re-author the creative layer");
    expect(directive).toContain("Do NOT call plan_edit");
  });

  it("asks for a reference when none is attached", () => {
    const directive = referenceIntentDirective({
      intent: "replicate",
      referenceName: "",
      attached: false,
      applied: "none",
    });
    expect(directive).toContain("No reference video is attached");
    expect(directive).not.toContain("plan_edit");
  });

  it("falls back to planning when the structure was not applied", () => {
    const directive = referenceIntentDirective({
      intent: "replicate",
      referenceName: "clip.webm",
      attached: true,
      applied: "none",
      warnings: ["The reference could not be measured: decode failed"],
    });
    expect(directive).toContain("was NOT applied");
    expect(directive).toContain("plan_edit");
    expect(directive).toContain("The reference could not be measured");
  });

  it("keeps the reference out of the cuttable media for the reference intent", () => {
    const directive = referenceIntentDirective({
      intent: "reference",
      referenceName: "clip.webm",
      attached: true,
      applied: "none",
    });
    expect(directive).toContain("Only media tagged analysisRole=source may be cut");
    expect(directive).toContain("plan_edit");
  });
});
