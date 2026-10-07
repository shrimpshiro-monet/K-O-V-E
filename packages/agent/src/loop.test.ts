import { describe, it, expect, vi } from "vitest";
import { HeadlessHost } from "./headless-host";
import { runTurn } from "./loop";
import { executeTool } from "./executor";
import { MockLLMClient } from "./llm";
import type { LLMClient, LLMResponse, LoopMessage, LoopToolResultBlock } from "./llm";
import { toAnthropicTools } from "./registry";
import { makeEmptyProject, makeProjectWithClip } from "./test-fixtures";
import type { EditingHost } from "./host";
import type { AgentEvent, ToolCall } from "./types";

const tools = toAnthropicTools();
const userMsg = (content: string): LoopMessage[] => [{ role: "user", content }];

describe("runTurn", () => {
  it("runs the director checkup and blocks edits before direct planning", async () => {
    const host = new HeadlessHost(makeProjectWithClip());
    const events: AgentEvent[] = [];
    const result = await runTurn({
      host,
      llm: new MockLLMClient([
        {
          text: "I should plan this first.",
          stopReason: "tool_use",
          toolUses: [{ id: "t1", name: "add_track", input: { trackType: "text" } }],
        },
        { text: "Planning is required.", stopReason: "end_turn", toolUses: [] },
      ]),
      tools,
      messages: userMsg("edit this video into a short reel"),
      enforceDirectorWorkflow: true,
      onEvent: (event) => events.push(event),
    });

    const calls = events
      .filter((event): event is Extract<AgentEvent, { type: "tool_call" }> => event.type === "tool_call")
      .map((event) => event.call.name);
    expect(calls).toEqual(["get_capabilities", "get_editor_state", "list_media", "add_track"]);
    expect(events.some((event) => event.type === "tool_result" && event.result.error?.code === "PLAN_REQUIRED")).toBe(true);
    expect(host.getProject().timeline.tracks).toHaveLength(1);
    expect(result.committed).toBe(true);
  });

  it("allows footage discovery before direct planning", async () => {
    const host = new HeadlessHost(makeProjectWithClip());
    const events: AgentEvent[] = [];
    const result = await runTurn({
      host,
      llm: new MockLLMClient([
        {
          text: "I will inspect the footage first.",
          stopReason: "tool_use",
          toolUses: [{ id: "t1", name: "extract_segments", input: { videoMediaIds: ["media-1"] } }],
        },
        { text: "Now I can plan the edit.", stopReason: "end_turn", toolUses: [] },
      ]),
      tools,
      messages: userMsg("edit this video into a short reel"),
      enforceDirectorWorkflow: true,
      onEvent: (event) => events.push(event),
    });

    const extractionResult = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
        event.type === "tool_result" && event.call.name === "extract_segments",
    );
    expect(extractionResult?.result.error?.code).not.toBe("PLAN_REQUIRED");
    expect(result.committed).toBe(true);
  });

  it("executes a multi-tool turn and commits", async () => {
    const host = new HeadlessHost(makeProjectWithClip());
    const script: LLMResponse[] = [
      {
        text: "Adding a track and slowing the clip.",
        stopReason: "tool_use",
        toolUses: [
          { id: "t1", name: "add_track", input: { trackType: "text" } },
          { id: "t2", name: "set_clip_speed", input: { clipId: "c1", speed: 0.5 } },
        ],
      },
      { text: "Done.", stopReason: "end_turn", toolUses: [] },
    ];
    const events: AgentEvent[] = [];
    const result = await runTurn({
      host,
      llm: new MockLLMClient(script),
      tools,
      messages: userMsg("slow the clip and add a text track"),
      onEvent: (e) => events.push(e),
    });

    expect(result.stoppedReason).toBe("end_turn");
    expect(result.committed).toBe(true);
    expect(result.toolCalls).toBe(2);
    expect(host.getProject().timeline.tracks).toHaveLength(2);
    expect(host.getProject().timeline.tracks[0].clips[0].speed).toBe(0.5);
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
    expect(events.at(-1)?.type).toBe("turn_complete");
  });

  it("dry-run does not mutate the project", async () => {
    const host = new HeadlessHost(makeProjectWithClip());
    const script: LLMResponse[] = [
      {
        text: "",
        stopReason: "tool_use",
        toolUses: [{ id: "t1", name: "set_clip_speed", input: { clipId: "c1", speed: 4 } }],
      },
      { text: "Planned.", stopReason: "end_turn", toolUses: [] },
    ];
    await runTurn({
      host,
      llm: new MockLLMClient(script),
      tools,
      messages: userMsg("4x speed"),
      dryRun: true,
    });
    expect(host.getProject().timeline.tracks[0].clips[0].speed ?? 1).toBe(1);
  });

  it("surfaces a provider output-limit stop as a budget stop", async () => {
    const host = new HeadlessHost(makeProjectWithClip());
    const result = await runTurn({
      host,
      llm: new MockLLMClient([
        { text: "A partial response", stopReason: "max_tokens", toolUses: [] },
      ]),
      tools,
      messages: userMsg("describe the project"),
    });

    expect(result.text).toBe("A partial response");
    expect(result.stoppedReason).toBe("budget");
    expect(result.committed).toBe(true);
  });

  it("gates destructive tools and honors rejection", async () => {
    const host = new HeadlessHost(makeProjectWithClip());
    const script: LLMResponse[] = [
      {
        text: "",
        stopReason: "tool_use",
        toolUses: [{ id: "t1", name: "remove_clip", input: { clipId: "c1" } }],
      },
      { text: "Cancelled.", stopReason: "end_turn", toolUses: [] },
    ];
    const confirmGate = vi.fn(() => "reject" as const);
    const result = await runTurn({
      host,
      llm: new MockLLMClient(script),
      tools,
      messages: userMsg("delete the clip"),
      confirmGate,
    });
    expect(confirmGate).toHaveBeenCalledOnce();
    expect(host.getProject().timeline.tracks[0].clips).toHaveLength(1);
    expect(result.committed).toBe(true);
  });

  it("confirms the tool behind run_tool, not the wrapper", async () => {
    const host = new HeadlessHost(makeProjectWithClip());
    const script: LLMResponse[] = [
      {
        text: "",
        stopReason: "tool_use",
        // A destructive tool called through the discovery invoker.
        toolUses: [
          {
            id: "t1",
            name: "run_tool",
            input: { name: "remove_clip", args: { clipId: "c1" } },
          },
        ],
      },
      { text: "Cancelled.", stopReason: "end_turn", toolUses: [] },
    ];
    const confirmGate = vi.fn((_call: ToolCall) => "reject" as const);
    await runTurn({
      host,
      llm: new MockLLMClient(script),
      tools,
      messages: userMsg("delete the clip through discovery"),
      confirmGate,
    });

    // The user must be asked about the real tool, and rejecting it must protect
    // the timeline.
    expect(confirmGate).toHaveBeenCalledOnce();
    expect(confirmGate.mock.calls[0][0].name).toBe("remove_clip");
    expect(host.getProject().timeline.tracks[0].clips).toHaveLength(1);
  });

  it("does not ask for confirmation on a read-only run_tool call", async () => {
    const host = new HeadlessHost(makeProjectWithClip());
    const script: LLMResponse[] = [
      {
        text: "",
        stopReason: "tool_use",
        toolUses: [
          {
            id: "t1",
            name: "run_tool",
            input: { name: "get_clip", args: { clipId: "c1" } },
          },
        ],
      },
      { text: "Here is the clip.", stopReason: "end_turn", toolUses: [] },
    ];
    const confirmGate = vi.fn((_call: ToolCall) => "reject" as const);
    await runTurn({
      host,
      llm: new MockLLMClient(script),
      tools,
      messages: userMsg("what is in this clip?"),
      confirmGate,
    });
    expect(confirmGate).not.toHaveBeenCalled();
  });

  it("performs >=5 cross-domain edits in one turn and reverts them atomically on error", async () => {
    const host = new HeadlessHost(makeProjectWithClip());
    let call = 0;
    const llm: LLMClient = {
      complete: async () => {
        call++;
        if (call === 1) {
          return {
            text: "Applying a batch of edits.",
            stopReason: "tool_use",
            toolUses: [
              { id: "t1", name: "add_track", input: { trackType: "text" } },
              { id: "t2", name: "set_clip_speed", input: { clipId: "c1", speed: 2 } },
              { id: "t3", name: "set_clip_reverse", input: { clipId: "c1", reversed: true } },
              { id: "t4", name: "set_clip_stabilization", input: { clipId: "c1", stabilization: { enabled: true } } },
              { id: "t5", name: "set_clip_chroma_key", input: { clipId: "c1", chromaKey: { enabled: true } } },
              { id: "t6", name: "add_marker", input: { time: 1, label: "M", color: "#fff" } },
            ],
          };
        }
        throw new Error("provider exploded after edits applied");
      },
    };

    const result = await runTurn({ host, llm, tools, messages: userMsg("do a lot") });

    expect(result.toolCalls).toBe(6);
    expect(result.committed).toBe(false);
    // every edit reverted atomically
    const p = host.getProject();
    expect(p.timeline.tracks).toHaveLength(1);
    expect(p.timeline.tracks[0].clips[0].speed ?? 1).toBe(1);
    expect(p.timeline.tracks[0].clips[0].reversed ?? false).toBe(false);
    expect(p.timeline.tracks[0].clips[0].stabilization ?? undefined).toBeUndefined();
    expect(p.timeline.tracks[0].clips[0].chromaKey ?? undefined).toBeUndefined();
    expect(p.timeline.markers ?? []).toHaveLength(0);
  });

  it("emits an image content block when a tool result carries an image", async () => {
    const host = new HeadlessHost(makeEmptyProject(), {
      jobRunner: async () => ({
        ok: true,
        data: {
          dataUrl: "data:image/png;base64,SGVsbG8=",
          width: 1920,
          height: 1080,
        },
      }),
    });
    const created = await executeTool("create_motion_composition", {}, host);
    const compositionId = (created.data as { compositionId: string }).compositionId;

    const script: LLMResponse[] = [
      {
        text: "Rendering the frame to check it.",
        stopReason: "tool_use",
        toolUses: [
          { id: "t1", name: "render_motion_frame", input: { compositionId } },
        ],
      },
      { text: "Looks good.", stopReason: "end_turn", toolUses: [] },
    ];

    const result = await runTurn({
      host,
      llm: new MockLLMClient(script),
      tools,
      messages: userMsg("render the motion frame"),
    });

    const toolMessage = result.messages.find(
      (message): message is Extract<LoopMessage, { role: "tool" }> =>
        message.role === "tool",
    );
    expect(toolMessage).toBeDefined();
    const content = toolMessage?.results[0].content;
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as LoopToolResultBlock[];
    expect(blocks[0].type).toBe("text");
    const imageBlock = blocks.find((block) => block.type === "image");
    expect(imageBlock).toBeDefined();
    if (imageBlock?.type === "image") {
      expect(imageBlock.source.type).toBe("base64");
      expect(imageBlock.source.media_type).toBe("image/png");
      expect(imageBlock.source.data).toBe("SGVsbG8=");
      expect(imageBlock.source.data.startsWith("data:")).toBe(false);
    }
  });

  it("rolls back the whole turn on a fatal LLM error", async () => {
    const host = new HeadlessHost(makeProjectWithClip());
    // First completion applies an edit (tool), second throws.
    let call = 0;
    const llm: LLMClient = {
      complete: async () => {
        call++;
        if (call === 1) {
          return {
            text: "",
            stopReason: "tool_use",
            toolUses: [{ id: "t1", name: "set_clip_speed", input: { clipId: "c1", speed: 2 } }],
          };
        }
        throw new Error("provider exploded");
      },
    };
    const result = await runTurn({
      host,
      llm,
      tools,
      messages: userMsg("do stuff"),
    });
    expect(result.stoppedReason).toBe("error");
    expect(result.committed).toBe(false);
    // the tool edit applied mid-turn is rolled back
    expect(host.getProject().timeline.tracks[0].clips[0].speed ?? 1).toBe(1);
  });

  it("allows a second plan_edit when the first attempt failed validation", async () => {
    const projectId = "retry-after-failure";

    const project = {
      ...makeEmptyProject(),
      id: projectId,
      mediaLibrary: {
        items: [{ id: "video-1", name: "test.mp4", type: "video", metadata: { duration: 8 } }],
      },
    } as ReturnType<typeof makeEmptyProject>;
    const host = new HeadlessHost(project) as HeadlessHost & { llm: NonNullable<EditingHost["llm"]> };

    const invalidPlan = {
      segments: [{
        sourceVideoId: "video-1",
        sourceStartTime: 0,
        sourceEndTime: 4,
        trackIndex: 0,
        targetPosition: 0,
        effects: [],
        effectSpecs: [{ type: "speed-ramp", params: {}, rationale: "energy" }],
        rationale: "invalid",
      }],
      textElements: [],
      effects: [],
      transitions: [],
      audioDecisions: [],
      metadata: { targetDuration: 4, targetPlatform: "social", genre: "highlight-reel", pacing: "fast", rationale: "test" },
    };

    const validPlan = {
      ...invalidPlan,
      segments: [{
        ...invalidPlan.segments[0],
        effectSpecs: [],
        speedRamp: { keyframes: [{ time: 0, speed: 1 }, { time: 1.5, speed: 3 }] },
        rationale: "fixed",
      }],
    };

    // Outer loop responses (returned by llm.complete in the runTurn loop)
    const outerResponses: LLMResponse[] = [
      {
        text: "",
        stopReason: "tool_use",
        toolUses: [{ id: "outer-1", name: "plan_edit", input: { prompt: "match the reference energy" } }],
      },
      {
        text: "",
        stopReason: "tool_use",
        toolUses: [{ id: "outer-2", name: "plan_edit", input: { prompt: "match the reference energy" } }],
      },
      { text: "Done.", stopReason: "end_turn", toolUses: [] },
    ];

    // Inner plan_edit responses (returned by host.llm.client.complete inside the plan_edit tool)
    const innerResponses: LLMResponse[] = [
      {
        text: "",
        stopReason: "tool_use",
        toolUses: [{ id: "plan-1", name: "submit_edit_plan", input: structuredClone(invalidPlan) }],
      },
      // The bounded repair prompt gets one shot at fixing plan-1. Feed it another
      // invalid plan so the first plan_edit genuinely fails — otherwise repair
      // would swallow the failure this test exists to observe.
      {
        text: "",
        stopReason: "tool_use",
        toolUses: [{ id: "plan-1b", name: "submit_edit_plan", input: structuredClone(invalidPlan) }],
      },
      {
        text: "",
        stopReason: "tool_use",
        toolUses: [{ id: "plan-2", name: "submit_edit_plan", input: structuredClone(validPlan) }],
      },
    ];

    let outerIndex = 0;
    let innerIndex = 0;

    // Custom LLM that separates outer loop calls from inner plan_edit calls
    const llm: LLMClient = {
      complete: async () => {
        return outerResponses[outerIndex++] ?? { text: "", stopReason: "end_turn", toolUses: [] };
      },
    };

    // Set host.llm so the plan_edit tool can make its own inner LLM calls
    host.llm = {
      provider: "openai",
      client: {
        complete: async () => {
          return innerResponses[innerIndex++] ?? { text: "", stopReason: "end_turn", toolUses: [] };
        },
      },
    };

    const events: AgentEvent[] = [];
    const result = await runTurn({
      host,
      llm,
      tools,
      messages: userMsg("match the reference energy"),
      onEvent: (event) => events.push(event),
    });

    // First plan_edit should have failed validation
    const planEditResults = events.filter(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> =>
        e.type === "tool_result" && e.call.name === "plan_edit",
    );
    expect(planEditResults.length).toBeGreaterThanOrEqual(1);
    expect(planEditResults[0]!.result.ok).toBe(false);
    expect(planEditResults[0]!.result.error?.code).toBe("INVALID_EDIT_PLAN");

    // Second plan_edit should have succeeded (not blocked by guard)
    expect(planEditResults.length).toBe(2);
    expect(planEditResults[1]!.result.ok).toBe(true);

    // Timeline should have clips from the valid plan
    expect(host.getProject().timeline.tracks[0].clips).toHaveLength(1);

    expect(result.committed).toBe(true);
  });

  it("does not stack a second successful plan_edit in the same turn", async () => {
    const projectId = "no-stack-after-success";

    const project = {
      ...makeEmptyProject(),
      id: projectId,
      mediaLibrary: {
        items: [{ id: "video-1", name: "test.mp4", type: "video", metadata: { duration: 8 } }],
      },
    } as ReturnType<typeof makeEmptyProject>;
    const host = new HeadlessHost(project) as HeadlessHost & { llm: NonNullable<EditingHost["llm"]> };

    const validPlan = {
      segments: [{
        sourceVideoId: "video-1",
        sourceStartTime: 0,
        sourceEndTime: 4,
        trackIndex: 0,
        targetPosition: 0,
        effects: [],
        effectSpecs: [],
        rationale: "plan A",
      }],
      textElements: [],
      effects: [],
      transitions: [],
      audioDecisions: [],
      metadata: { targetDuration: 4, targetPlatform: "social", genre: "highlight-reel", pacing: "fast", rationale: "test" },
    };

    // Outer loop: two plan_edit calls
    const outerResponses: LLMResponse[] = [
      {
        text: "",
        stopReason: "tool_use",
        toolUses: [{ id: "outer-1", name: "plan_edit", input: { prompt: "make a highlight" } }],
      },
      {
        text: "",
        stopReason: "tool_use",
        toolUses: [{ id: "outer-2", name: "plan_edit", input: { prompt: "make a highlight" } }],
      },
      { text: "Done.", stopReason: "end_turn", toolUses: [] },
    ];

    // Inner: both calls return the same valid plan
    const innerResponses: LLMResponse[] = [
      {
        text: "",
        stopReason: "tool_use",
        toolUses: [{ id: "plan-1", name: "submit_edit_plan", input: structuredClone(validPlan) }],
      },
      {
        text: "",
        stopReason: "tool_use",
        toolUses: [{ id: "plan-2", name: "submit_edit_plan", input: structuredClone(validPlan) }],
      },
    ];

    let outerIndex = 0;
    let innerIndex = 0;

    const llm: LLMClient = {
      complete: async () => {
        return outerResponses[outerIndex++] ?? { text: "", stopReason: "end_turn", toolUses: [] };
      },
    };

    host.llm = {
      provider: "openai",
      client: {
        complete: async () => {
          return innerResponses[innerIndex++] ?? { text: "", stopReason: "end_turn", toolUses: [] };
        },
      },
    };

    const events: AgentEvent[] = [];
    const result = await runTurn({
      host,
      llm,
      tools,
      messages: userMsg("make a highlight"),
      onEvent: (event) => events.push(event),
    });

    const planEditResults = events.filter(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> =>
        e.type === "tool_result" && e.call.name === "plan_edit",
    );

    // First plan_edit should have succeeded
    expect(planEditResults.length).toBeGreaterThanOrEqual(1);
    expect(planEditResults[0]!.result.ok).toBe(true);

    // Second plan_edit should NOT have applied — either guard-blocked or
    // fingerprint-no-op'd. Assert the behavior, not the mechanism.
    expect(planEditResults.length).toBe(2);
    const second = planEditResults[1]!;
    const blockedByGuard = !second.result.ok && second.result.error?.code === "PLAN_EDIT_ALREADY_USED";
    const noOpedByFingerprint = second.result.ok && (second.result.data as Record<string, unknown>).applied === false;
    expect(blockedByGuard || noOpedByFingerprint).toBe(true);

    // Timeline has exactly one set of clips (no double-applied artifacts)
    expect(host.getProject().timeline.tracks[0].clips).toHaveLength(1);

    expect(result.committed).toBe(true);
  });
});
