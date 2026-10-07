import { describe, expect, it } from "vitest";
import { HeadlessHost } from "./headless-host";
import { FnLLMClient, type LLMResponse, type LLMTurnInput } from "./llm";
import { getTool, toAnthropicTools } from "./registry";
import {
  SUBAGENT_SPECS,
  SUBAGENT_TOOLS,
} from "./tools-subagents";
import { formatSubagentDigest, runSubagents } from "./subagents";
import { makeEmptyProject } from "./test-fixtures";

const endTurn = (text: string): LLMResponse => ({
  text,
  toolUses: [],
  stopReason: "end_turn",
  usage: { inputTokens: 10, outputTokens: 5 },
});

const useTool = (name: string, input: Record<string, unknown> = {}): LLMResponse => ({
  text: "",
  toolUses: [{ id: "t1", name, input }],
  stopReason: "tool_use",
  usage: { inputTokens: 10, outputTokens: 5 },
});

const host = () => new HeadlessHost(makeEmptyProject());
const formatter = (names: readonly string[]) => toAnthropicTools(names);

describe("subagent registration", () => {
  it("registers delegate_tasks", () => {
    expect(getTool("delegate_tasks")).toBeTruthy();
    expect(SUBAGENT_TOOLS.map((t) => t.name)).toContain("delegate_tasks");
  });

  it("only allowlists tools that actually exist", () => {
    // The allowlist is the whole safety story: a typo silently widens or
    // narrows a subagent's reach, so a rename must not pass unnoticed.
    const missing = SUBAGENT_SPECS.flatMap((spec) =>
      spec.tools.filter((name) => !getTool(name)).map((name) => `${spec.name} → ${name}`),
    );
    expect(missing).toEqual([]);
  });

  it("gives every subagent its own system prompt and a non-empty toolbox", () => {
    for (const spec of SUBAGENT_SPECS) {
      expect(spec.system.length).toBeGreaterThan(80);
      expect(spec.tools.length).toBeGreaterThan(0);
      expect(spec.description.length).toBeGreaterThan(20);
    }
  });
});

describe("runSubagents", () => {
  it("gives a subagent only its own goal — never the parent's history", async () => {
    // Snapshot the history at call time: the array is live and grows as the
    // turn runs, so inspecting it afterwards would miss the point.
    const seen: number[] = [];
    const llm = new FnLLMClient((input) => {
      seen.push(input.messages.length);
      return endTurn("report");
    });
    await runSubagents({
      host: host(),
      llm,
      formatTools: formatter,
      specs: SUBAGENT_SPECS,
      tasks: [{ agent: "scout", goal: "list the clips" }],
    });

    expect(llm.calls).toHaveLength(1);
    // One user message, containing the goal and nothing else.
    expect(seen[0]).toBe(1);
    expect(JSON.stringify(llm.calls[0].messages[0])).toContain("list the clips");
    // The role prompt is the subagent's, not the director's.
    expect(llm.calls[0].system).toContain("inventory scout");
  });

  it("hands the subagent only the tools its role allows", async () => {
    const llm = new FnLLMClient(() => endTurn("report"));
    await runSubagents({
      host: host(),
      llm,
      formatTools: formatter,
      specs: SUBAGENT_SPECS,
      tasks: [{ agent: "scout", goal: "go" }],
    });

    const names = (llm.calls[0].tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_clips"]));
    // A read-only scout must not be able to reach an editing tool.
    expect(names).not.toContain("trim_clip");
    expect(names).not.toContain("set_color_grading");
  });

  it("runs read-only subagents concurrently", async () => {
    // Each completion blocks, so a serial runner would take ~3x as long.
    const llm = new FnLLMClient(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return endTurn("report");
    });

    const started = Date.now();
    const outcomes = await runSubagents({
      host: host(),
      llm,
      formatTools: formatter,
      specs: SUBAGENT_SPECS,
      tasks: [
        { agent: "scout", goal: "a" },
        { agent: "footage", goal: "b" },
        { agent: "reviewer", goal: "c" },
      ],
    });
    const elapsed = Date.now() - started;

    expect(outcomes).toHaveLength(3);
    // Serial would be >=120ms; concurrent should land near one round-trip.
    expect(elapsed).toBeLessThan(110);
  });

  it("serializes subagents that can edit, so two writers cannot race", async () => {
    const active: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    const llm = new FnLLMClient(async (input: LLMTurnInput) => {
      const label = String(input.system).slice(0, 12);
      active.push(label);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 30));
      concurrent -= 1;
      return endTurn("done");
    });

    const outcomes = await runSubagents({
      host: host(),
      llm,
      formatTools: formatter,
      specs: SUBAGENT_SPECS,
      tasks: [
        { agent: "cutter", goal: "a" },
        { agent: "stylist", goal: "b" },
      ],
    });

    expect(outcomes.map((o) => o.agent)).toEqual(["cutter", "stylist"]);
    expect(maxConcurrent).toBe(1);
  });

  it("honours an explicit parallel override for writers", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const llm = new FnLLMClient(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 30));
      concurrent -= 1;
      return endTurn("done");
    });

    await runSubagents({
      host: host(),
      llm,
      formatTools: formatter,
      specs: SUBAGENT_SPECS,
      tasks: [
        { agent: "cutter", goal: "a" },
        { agent: "stylist", goal: "b" },
      ],
      mode: "parallel",
    });

    expect(maxConcurrent).toBe(2);
  });

  it("fails one bad delegation without sinking the rest", async () => {
    const llm = new FnLLMClient(() => endTurn("report"));
    const outcomes = await runSubagents({
      host: host(),
      llm,
      formatTools: formatter,
      specs: SUBAGENT_SPECS,
      tasks: [
        { agent: "scout", goal: "a" },
        { agent: "does-not-exist", goal: "b" },
        { agent: "reviewer", goal: "c" },
      ],
    });

    expect(outcomes.map((o) => o.ok)).toEqual([true, false, true]);
    expect(outcomes[1].stoppedReason).toBe("unknown_agent");
    expect(outcomes[1].error).toContain("does-not-exist");
    // The survivors still did their work.
    expect(llm.calls).toHaveLength(2);
  });

  it("shares the token budget across the fan-out", async () => {
    const llm = new FnLLMClient(() => endTurn("x".repeat(50)));
    const outcomes = await runSubagents({
      host: host(),
      llm,
      formatTools: formatter,
      specs: SUBAGENT_SPECS,
      tasks: [
        { agent: "scout", goal: "a" },
        { agent: "scout", goal: "b" },
      ],
      budget: { maxTokens: 100 },
    });

    expect(outcomes).toHaveLength(2);
    // A chatty subagent is stopped by its share, not by the total.
    for (const outcome of outcomes) {
      expect(outcome.usage.inputTokens + outcome.usage.outputTokens).toBeLessThanOrEqual(100);
    }
  });

  it("reflects a subagent's real tool calls and stop reason", async () => {
    let call = 0;
    const llm = new FnLLMClient(() => {
      call += 1;
      return call === 1 ? useTool("list_clips") : endTurn("two clips");
    });

    const [outcome] = await runSubagents({
      host: host(),
      llm,
      formatTools: formatter,
      specs: SUBAGENT_SPECS,
      tasks: [{ agent: "scout", goal: "list clips" }],
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.toolCalls).toBe(1);
    expect(outcome.stoppedReason).toBe("end_turn");
    expect(outcome.text).toBe("two clips");
  });
});

describe("formatSubagentDigest", () => {
  it("stays small no matter how much the subagents read", () => {
    const digest = formatSubagentDigest([
      {
        agent: "scout",
        goal: "g",
        ok: true,
        text: "word ".repeat(5000),
        toolCalls: 42,
        stoppedReason: "end_turn",
        usage: { inputTokens: 90_000, outputTokens: 2_000 },
      },
    ]);

    // The parent's history grows by this string, not by the 90k tokens read.
    expect(digest.length).toBeLessThan(1400);
    expect(digest).toContain("42 tool call(s)");
    expect(digest).toContain("92000 tokens");
  });

  it("surfaces failures with their reason", () => {
    const digest = formatSubagentDigest([
      {
        agent: "cutter",
        goal: "g",
        ok: false,
        text: "",
        toolCalls: 0,
        stoppedReason: "unknown_agent",
        usage: { inputTokens: 0, outputTokens: 0 },
        error: 'No subagent named "cutter".',
      },
    ]);

    expect(digest).toContain("FAILED (unknown_agent)");
    expect(digest).toContain("No subagent named");
  });
});
