import { describe, expect, it } from "vitest";
import { generateExpansionQuestions, scorePromptCompleteness } from "./prompt-expansion";

describe("prompt expansion", () => {
  it("scores a prompt that names a signature effect as covering style", () => {
    const { gaps } = scorePromptCompleteness(
      "make a 30 second tiktok edit that looks like a VHS tape",
    );
    expect(gaps).not.toContain("style");
  });

  it("recognizes signature-effect aliases, not just canonical names", () => {
    for (const prompt of [
      "give it a comic-book look for instagram, 20 seconds",
      "make it thermal for the reveal, 15s, tiktok",
      "tron-style neon outline on the hook, 12 seconds, youtube",
    ]) {
      expect(scorePromptCompleteness(prompt).gaps, prompt).not.toContain("style");
    }
  });

  it("still flags style when the prompt says nothing about the look", () => {
    const { gaps } = scorePromptCompleteness("cut this down please");
    expect(gaps).toContain("style");
  });

  it("asks the style question with concrete examples when style is the gap", () => {
    const questions = generateExpansionQuestions(["style"]);
    expect(questions).toHaveLength(1);
    expect(questions[0]!.toLowerCase()).toContain("effects");
  });
});
