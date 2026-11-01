import { describe, expect, it, vi } from "vitest";
import { HeadlessHost } from "./headless-host";
import { runTurn } from "./loop";
import { toAnthropicTools } from "./registry";
import { makeEmptyProject, makeProjectWithClip } from "./test-fixtures";
import type { EditingHost } from "./host";
import type { LLMResponse, LLMTurnInput } from "./llm";
import type { AgentEvent } from "./types";

const tools = toAnthropicTools();
const prompt = [{ role: "user" as const, content: "Create a highlight reel from the source video" }];
const noTools = (text: string, stopReason: "end_turn" | "max_tokens" = "end_turn"): LLMResponse => ({ text, stopReason, toolUses: [] });

function sourceHost(id: string) {
  const project = {
    ...makeEmptyProject(),
    id,
    mediaLibrary: { items: [{ id: "video-1", name: "source.mp4", type: "video", metadata: { duration: 8 } }] },
  } as ReturnType<typeof makeEmptyProject>;
  return new HeadlessHost(project);
}

function scripted(...responses: LLMResponse[]) {
  const complete = vi.fn(async (_input: LLMTurnInput) => responses.shift() ?? noTools(""));
  return { complete };
}

async function turn(host: HeadlessHost, llm: ReturnType<typeof scripted>, options: Partial<Parameters<typeof runTurn>[0]> = {}) {
  const events: AgentEvent[] = [];
  const result = await runTurn({ host, llm, tools, messages: prompt.map((message) => ({ ...message })), enforceDirectorWorkflow: true, onEvent: (event) => events.push(event), ...options });
  return { result, events };
}

describe("director empty-timeline guard", () => {
  it("retries one text-only false success and reports a clear failure instead of committing", async () => {
    const host = sourceHost("empty-retry");
    const llm = scripted(noTools("Your edit is ready."), noTools("Done!"));
    const { result, events } = await turn(host, llm);
    expect(llm.complete).toHaveBeenCalledTimes(2);
    expect(llm.complete.mock.calls[1][0].system).toMatch(/timeline is still empty.*call plan_edit/i);
    expect(result).toMatchObject({ stoppedReason: "error", committed: false });
    expect(result.text).toMatch(/timeline is still empty/i);
    expect(result.messages.some((message) => message.role === "assistant" && /Your edit is ready|Done!/.test(message.content))).toBe(false);
    expect(events.some((event) => event.type === "error" && event.error.code === "EMPTY_DIRECTOR_TIMELINE")).toBe(true);
    expect(events.some((event) => event.type === "turn_complete" || event.type === "text_delta")).toBe(false);
    expect(host.getProject().timeline.tracks).toHaveLength(0);
  });

  it("can recover on the bounded retry by actually calling plan_edit", async () => {
    const host = sourceHost("empty-success") as HeadlessHost & { llm: NonNullable<EditingHost["llm"]> };
    const plan = {
      segments: [{ sourceVideoId: "video-1", sourceStartTime: 0, sourceEndTime: 4, trackIndex: 0, targetPosition: 0, effects: [], effectSpecs: [], rationale: "highlight" }],
      textElements: [], effects: [], transitions: [], audioDecisions: [],
      metadata: { targetDuration: 4, targetPlatform: "social", genre: "highlight-reel", pacing: "fast", rationale: "test" },
    };
    host.llm = { provider: "openai", client: scripted({ text: "", stopReason: "tool_use", toolUses: [{ id: "inner", name: "submit_edit_plan", input: plan }] }) };
    const llm = scripted(
      noTools("Your edit is ready."),
      { text: "Planning the edit.", stopReason: "tool_use", toolUses: [{ id: "plan", name: "plan_edit", input: { prompt: "make a highlight" } }] },
      noTools("Done."),
    );
    const { result, events } = await turn(host, llm);
    expect(result).toMatchObject({ stoppedReason: "end_turn", committed: true });
    expect(host.getProject().timeline.tracks.flatMap((track) => track.clips)).toHaveLength(1);
    expect(events.some((event) => event.type === "tool_result" && event.call.name === "plan_edit" && event.result.ok)).toBe(true);
    expect(llm.complete).toHaveBeenCalledTimes(3);

    // A cached plan is stale if its clips are later removed.
    const created = host.getProject().timeline.tracks.flatMap((track) => track.clips)[0];
    const removed = await host.applyAction({ type: "clip/remove", id: "remove-planned-clip", timestamp: 0, params: { clipId: created.id } });
    expect(removed.success).toBe(true);
    const stale = scripted(noTools("Already edited."), noTools("Still done."));
    const next = await turn(host, stale);
    expect(stale.complete).toHaveBeenCalledTimes(2);
    expect(next.result).toMatchObject({ stoppedReason: "error", committed: false });
  });

  it("does not retry a real clarification question", async () => {
    const llm = scripted(noTools("How long should the highlight be?"));
    const { result } = await turn(sourceHost("clarification"), llm);
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ stoppedReason: "end_turn", committed: true, text: "How long should the highlight be?" });
  });

  it("allows a clarification on the retry", async () => {
    const llm = scripted(noTools("Finished."), noTools("Which footage should I prioritize?"));
    const { result } = await turn(sourceHost("retry-question"), llm);
    expect(llm.complete).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ stoppedReason: "end_turn", committed: true, text: "Which footage should I prioritize?" });
  });

  it("does not retry when there is no source footage (including reference-only media)", async () => {
    for (const host of [new HeadlessHost(makeEmptyProject()), new HeadlessHost({ ...makeEmptyProject(), id: "reference-only", mediaLibrary: { items: [{ id: "r", name: "reference.mp4", type: "video", analysisRole: "reference", metadata: { duration: 4 } }] } } as ReturnType<typeof makeEmptyProject>)]) {
      const llm = scripted(noTools("Please import source footage."));
      const { result } = await turn(host, llm);
      expect(llm.complete).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ stoppedReason: "end_turn", committed: true });
    }
  });

  it("preserves dry runs and output-limit notices", async () => {
    const dry = scripted(noTools("I would make an edit."));
    expect((await turn(sourceHost("dry"), dry, { dryRun: true })).result.committed).toBe(true);
    expect(dry.complete).toHaveBeenCalledTimes(1);
    const limited = scripted(noTools("Partial output", "max_tokens"));
    expect((await turn(sourceHost("limited"), limited)).result.stoppedReason).toBe("budget");
    expect(limited.complete).toHaveBeenCalledTimes(1);
  });

  it("does not demand a new timeline for an existing edit", async () => {
    const host = new HeadlessHost({ ...makeProjectWithClip(), id: "existing", mediaLibrary: { items: [{ id: "video-1", name: "source.mp4", type: "video", metadata: { duration: 8 } }] } } as ReturnType<typeof makeEmptyProject>);
    const llm = scripted(noTools("Here is the current edit."));
    const { result } = await turn(host, llm);
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ stoppedReason: "end_turn", committed: true });
  });

  it("does not trust an applied-reference flag when the timeline has no clips", async () => {
    const llm = scripted(noTools("Reference applied."), noTools("All done."));
    const { result } = await turn(sourceHost("false-reference"), llm, { directorPlanApplied: true });
    expect(llm.complete).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ stoppedReason: "error", committed: false });
  });
});
