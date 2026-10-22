import { describe, expect, it } from "vitest";
import type { EditingHost } from "./host";
import { buildSystemPrompt } from "./system-prompt";

const host = {
  getProject: () => {
    throw new Error("no project");
  },
} as unknown as EditingHost;

describe("buildSystemPrompt (Monet section is routing, not a second director prompt)", () => {
  const prompt = buildSystemPrompt(host);

  it("keeps the chat agent's job: call plan_edit once, summarize", () => {
    expect(prompt).toContain("## Monet — AI Director Workflow");
    expect(prompt).toContain("call `plan_edit` ONCE");
    expect(prompt).toContain("summarize what was done");
  });

  it("keeps the follow-up routing: targeted edits reuse the timeline, they do not restart planning", () => {
    expect(prompt).toContain("ONE-SHOT per turn");
    expect(prompt).toContain("edit the existing timeline with clip/effect/text tools");
    expect(prompt).toContain("Only call `plan_edit` again if the user explicitly asks to redo the edit");
  });

  it("keeps the reference-intent directive path", () => {
    expect(prompt).toContain("### Reference Intent (attached reference video)");
    expect(prompt).toContain("`REPLICATE` (/mirror)");
    expect(prompt).toContain("do NOT call `plan_edit`: it REPLACES the timeline");
    expect(prompt).toContain("Only media tagged `analysisRole=source` may be cut");
  });

  it("no longer restates the director's craft rules — one source owns each rule", () => {
    // Contradiction 1 (density: floor 6-15 hits vs 'Less is more 2-5') and
    // contradiction 7 (rules copy-pasted across surfaces) were produced by
    // these blocks. The director prompt + tool descriptions own them now.
    expect(prompt).not.toContain("Perception-Driven Editing");
    expect(prompt).not.toContain("Effect & Transition Placement");
    expect(prompt).not.toContain("Less is more");
    expect(prompt).not.toContain("Audio Decisions (MANDATORY");
    expect(prompt).not.toContain("Param shapes per type");
    expect(prompt).not.toContain("importanceScore");
    expect(prompt).not.toContain("beatTimestamps");
  });
});
