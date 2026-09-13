# K.O.V.E. AI Director — End-to-End Flow

This document traces the complete flow from the user opening the chat panel to exporting the final video. Every file and its actual code is included.

---

## Architecture Overview

```
User types prompt
       │
       ▼
┌──────────────┐    ┌──────────────────┐    ┌────────────────┐
│  ChatPanel   │───▶│  chat-store.ts   │───▶│  llm-transport │
│  (UI layer)  │    │  (Zustand state)  │    │  (HTTP client) │
└──────────────┘    └──────────────────┘    └────────────────┘
                           │                        │
                           ▼                        ▼
                    ┌──────────────┐    ┌────────────────────┐
                    │  loop.ts     │    │  Cloudflare / BYOK  │
                    │  (agent loop)│    │  (LLM provider)    │
                    └──────────────┘    └────────────────────┘
                           │
                           ▼
                    ┌──────────────┐    ┌────────────────────┐
                    │  executor.ts │───▶│  registry.ts       │
                    │  (dispatch)  │    │  (tool definitions) │
                    └──────────────┘    └────────────────────┘
                                               │
                              ┌─────────────────┼─────────────────┐
                              ▼                 ▼                 ▼
                        extract_segments   plan_edit         editing tools
                        (frame analysis)   (nested LLM)     (split, move, etc.)
```

---

## Step 1: User Opens Chat — ChatPanel.tsx

**File:** `apps/web/src/components/editor/chat/ChatPanel.tsx`

The ChatPanel is the entry point. It renders the message list, composer, and controls. On mount, it sets the project context:

```tsx
// ChatPanel.tsx:177-179
useEffect(() => {
  setProjectContext(projectId);
}, [projectId, setProjectContext]);
```

The empty state shows suggestions and checks if the LLM is configured:

```tsx
// ChatPanel.tsx:45-78 — Setup check
useEffect(() => {
  let active = true;
  void (async () => {
    try {
      // Cloudflare: zero-config, skip all BYOK checks
      if (provider === "cloudflare") {
        if (active) setSetup("ready");
        return;
      }
      if (!provider || !baseUrl.trim() || !model.trim()) {
        if (active) setSetup("endpoint");
        return;
      }
      // ... more checks for BYOK providers
    } catch {
      if (active) setSetup("missing");
    }
  })();
  // ...
}, [baseUrl, configuredServices, model, provider, settingsOpen]);
```

The header shows token usage, dry-run toggle, auto-approve toggle, model picker, undo, history, and new chat:

```tsx
// ChatPanel.tsx:183-268 — Header
<header className="flex items-center gap-2 border-b border-border px-3 py-2">
  <Bot size={15} className="shrink-0 text-accent" />
  <span className="shrink-0 text-[13px] font-medium text-fg">AI Editor</span>
  {/* ... token counter, dry-run toggle, auto-approve, model picker, undo, history, new chat, close */}
</header>
```

---

## Step 2: User Types a Message — ChatComposer.tsx

**File:** `apps/web/src/components/editor/chat/ChatComposer.tsx`

The composer is a textarea with Enter-to-send:

```tsx
// ChatComposer.tsx:15-20
const submit = useCallback(() => {
  const value = text.trim();
  if (!value || busy) return;
  setText("");
  void send(value);
}, [text, busy, send]);
```

When the user hits Enter, `send(value)` is called on the chat store.

---

## Step 3: Chat Store Processes the Message — chat-store.ts

**File:** `apps/web/src/stores/chat-store.ts`

This is the orchestrator. The `send` method:

1. Validates state (not already running, project is open)
2. Resolves LLM provider, model, API key, base URL
3. Creates user and assistant message objects
4. Builds the conversation history
5. Selects tools for the prompt
6. Calls `runTurn()` from the agent loop

```tsx
// chat-store.ts:156-428 — send method (key sections)

// 1. Validate
const settings = useSettingsStore.getState();
const provider = settings.defaultLlmProvider ?? "cloudflare";

// 2. Resolve credentials
if (provider === "cloudflare") {
  apiKey = import.meta.env.VITE_CLOUDFLARE_API_TOKEN ?? "";
  baseUrl = import.meta.env.VITE_CLOUDFLARE_ACCOUNT_ID ?? "";
  model = settings.llmModel.trim() || import.meta.env.VITE_CLOUDFLARE_AI_MODEL || "@cf/google/gemma-4-26b-a4b-it";
} else {
  // BYOK: read from secure storage
  apiKey = (await getSecret(provider)) ?? "";
}

// 3. Create messages
const userMessage: ChatMessage = { id: genId(), role: "user", text: trimmed, toolCalls: [] };
const assistantMessage: ChatMessage = { id: genId(), role: "assistant", text: "", toolCalls: [] };

// 4. Build LLM client
const llm = makeBYOKClient({ provider, model, apiKey, baseUrl, signal: controller.signal });

// 5. Wire LLM into host for nested director calls (plan_edit)
host.llm = { client: llm, provider: agentProvider };

// 6. Select tools (max 25 for Cloudflare, 120 for others)
const selectedToolNames = selectToolsForPrompt(routingContext, {
  maxTools: provider === "cloudflare" ? 25 : 120,
  priorToolNames,
});
const tools = provider === "anthropic-compatible"
  ? toAnthropicTools(selectedToolNames)
  : toOpenAITools(selectedToolNames);

// 7. Run the agent turn
result = await runExclusive(() =>
  runTurn({
    host,
    llm,
    tools,
    system: buildSystemPrompt(host, selectedToolNames),
    messages: get().conversation,
    dryRun,
    confirmGate: autoConfirm
      ? () => "approve_for_turn"
      : (call) => new Promise<ConfirmDecision>((resolve) => {
          set({ status: "awaiting_confirm", pendingConfirm: { call, resolve } });
        }),
    onEvent,
    turnLabel: "AI edit",
  }),
);
```

The `onEvent` callback updates the UI in real-time:

```tsx
// chat-store.ts:264-308 — Event handler
const onEvent = (event: AgentEvent): void => {
  switch (event.type) {
    case "text_delta":
    case "turn_complete":
      updateAssistant((m) => ({ ...m, text: event.text || m.text }));
      break;
    case "tool_call":
      updateAssistant((m) => ({
        ...m,
        toolCalls: [...m.toolCalls, { id: event.call.id, name: event.call.name, args: event.call.args, status: "running" }],
      }));
      break;
    case "tool_result":
      updateAssistant((m) => ({
        ...m,
        toolCalls: m.toolCalls.map((tc) =>
          tc.id === event.call.id
            ? { ...tc, result: event.result, status: event.result.ok ? "done" : "error" }
            : tc
        ),
      }));
      break;
  }
};
```

---

## Step 4: LLM Transport — llm-transport.ts

**File:** `apps/web/src/services/agent/llm-transport.ts`

Routes requests to the correct provider. For Cloudflare, it goes through a Vite dev proxy:

```tsx
// llm-transport.ts:44-82 — Cloudflare transport
function makeCloudflareSend(accountId, apiToken, signal) {
  return async (body) => {
    const normalized = normalizeCloudflareBody(body);  // arrays/null → strings
    const isDev = import.meta.env.DEV;
    const url = isDev
      ? `/api/cf-ai/client/v4/accounts/${accountId}/ai/v1/chat/completions`
      : `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
    const headers = { "Content-Type": "application/json" };
    if (!isDev) headers.Authorization = `Bearer ${apiToken}`;
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(normalized), signal });
    if (!res.ok) throw llmHttpError("cloudflare-ai", res.status, await res.text());
    return res.json();
  };
}

// llm-transport.ts:169-192 — Client factory
export function makeBYOKClient(opts: BYOKClientOptions): LLMClient {
  if (opts.provider === "cloudflare") {
    return makeCloudflareAIClient({
      accountId: opts.baseUrl ?? "",
      apiToken: opts.apiKey,
      model: opts.model,
      maxTokens: opts.maxTokens,
      signal: opts.signal,
    });
  }
  // BYOK providers...
}
```

---

## Step 5: System Prompt — system-prompt.ts

**File:** `packages/agent/src/system-prompt.ts`

The system prompt includes the serialized editor state and Monet's workflow:

```tsx
// system-prompt.ts:9-81
export function buildSystemPrompt(host, selectedToolNames) {
  let state = "(no project open)";
  try {
    state = JSON.stringify(serializeEditorState(host.getProject()));
  } catch {}

  return [
    "You are Kove Advanced's video-editing agent. You edit the user's open project by calling tools.",
    "",
    "Guidelines:",
    "- All times are in seconds (float).",
    "- NEVER ask the user for media IDs, clip IDs, track IDs...",
    "- Read before you write: use get_editor_state, list_clips, get_clip...",
    // ... more guidelines
    "",
    "Monet — AI Director Workflow:",
    "- When the user wants to create an edit from uploaded footage, follow this sequence IN FULL:",
    "  0. Call `get_editor_state` to discover all media IDs...",
    "  1. Call `plan_edit` with the user prompt + optional genre...",
    "  2. **IMMEDIATELY EXECUTE the EditPlan** — do NOT just return the plan...",
    "  3. After executing ALL items, summarize what was done.",
    "",
    `Current editor state: ${state}`,
    "",
    toCapabilityDoc(selectedToolNames),
  ].join("\n");
}
```

---

## Step 6: Agent Loop — loop.ts

**File:** `packages/agent/src/loop.ts`

The core loop that drives the entire agent. It:
1. Opens a transaction on the host
2. Sends the conversation to the LLM
3. Parses tool calls from the response
4. Executes each tool
5. Feeds results back to the LLM
6. Repeats until the LLM stops or limits are hit
7. Commits the transaction

```tsx
// loop.ts:91-279 — runTurn (key sections)
export async function runTurn(input: RunTurnInput): Promise<RunTurnResult> {
  const { host, llm, tools, system, confirmGate, onEvent, dryRun, turnLabel } = input;
  const maxSteps = input.limits?.maxSteps ?? 12;
  const maxToolCalls = input.limits?.maxToolCalls ?? 64;

  const txn = host.beginTransaction(turnLabel);

  try {
    for (let step = 0; step < maxSteps; step++) {
      // 1. Call LLM
      const response = await llm.complete({ system, messages, tools });

      // 2. If no tool calls, we're done
      if (response.toolUses.length === 0) {
        host.commitTransaction(txn, turnLabel);
        return { text: response.text, messages, toolCalls, stoppedReason: "end_turn", committed: true, usage };
      }

      // 3. Execute each tool call
      for (const toolUse of response.toolUses) {
        const call = { id: toolUse.id, name: toolUse.name, args: toolUse.input };
        emit({ type: "tool_call", call });

        // 4. Confirm gate for destructive/expensive tools
        const needsConfirm = !dryRun && !approveAll && (isDestructive(call.name) || isExpensive(call.name));
        if (needsConfirm && confirmGate) {
          const decision = await confirmGate(call);
          if (decision === "reject") { /* skip */ continue; }
        }

        // 5. Execute the tool
        const result = await executeTool(call.name, call.args, host);
        emit({ type: "tool_result", call, result });
        results.push({ toolUseId: call.id, content: buildToolResultContent(result), isError: !result.ok });
      }

      // 6. Feed results back to LLM
      messages.push({ role: "tool", results });
    }
  } catch (error) {
    await host.rollbackTransaction(txn);
    // ...
  }
}
```

---

## Step 7: Tool Execution — executor.ts

**File:** `packages/agent/src/executor.ts`

Resolves clip references and dispatches to the tool handler:

```tsx
// executor.ts:32-52
export async function executeTool(name, args, host): Promise<ToolResult> {
  const tool = getTool(name);
  if (!tool) return { ok: false, summary: `Unknown tool: ${name}`, error: { code: "UNKNOWN_TOOL", message: `No tool named '${name}'` } };

  // Resolve clipIndex/atSec to clipId
  const resolved = resolveRefs(args ?? {}, host);

  try {
    return await tool.handler(resolved, host);
  } catch (error) {
    return { ok: false, summary: message, error: { code: "TOOL_ERROR", message } };
  }
}
```

---

## Step 8: The Monet Flow — extract_segments → plan_edit → execute

### 8a. extract_segments (registry.ts:32089-32185)

Analyzes uploaded footage. Auto-discovers video IDs if none provided:

```tsx
// registry.ts:32098-32185
handler: async (args, host) => {
  host.requireOpenProject();
  const project = host.getProject();
  const allMedia = project.mediaLibrary?.items ?? [];
  const videoMediaItems = allMedia.filter((m) => m.type === "video");

  // Auto-discover: if no IDs provided, use ALL video media
  let videoMediaIds = args.videoMediaIds as string[] | undefined;
  if (!videoMediaIds || videoMediaIds.length === 0) {
    videoMediaIds = videoMediaItems.map((m) => m.id);
  }

  if (!VISION_WORKER_URL) {
    // Fallback: build basic SegmentMap from metadata only
    const videos = videoMediaIds.map((id) => {
      const media = mediaMap.get(id);
      return {
        videoId: id,
        sourceFile: media.name ?? id,
        duration: media.metadata.duration,
        segments: [{ id: `${id}-seg-0`, startTime: 0, endTime: duration, sceneType: "b-roll", description: `Full video: ${media.name}` }],
      };
    });
    return ok(`extract_segments: generated basic SegmentMap (vision worker not available)`, { segmentMap: { videos } });
  }

  // Real analysis: capture frames, send to vision worker
  for (const id of videoMediaIds) {
    const frames = await captureBaselineFrames(host, id, duration);
    videoInputs.push({ videoId: id, duration, frames });
  }
  const result = await runFrameWorkerPipeline({ videos: videoInputs, workerUrl: VISION_WORKER_URL });
  return ok(`extract_segments: analyzed ${videoMediaIds.length} video(s), ${result.frameCount} frame(s), ${result.segmentCount} segment(s)`, { segmentMap: result.segmentMap });
},
```

### 8b. plan_edit (registry.ts:32252-32377)

Makes a nested LLM call with the director prompt to produce an EditPlan:

```tsx
// registry.ts:32264-32377
handler: async (args, host) => {
  host.requireOpenProject();
  const prompt = (args.prompt as string | undefined)?.trim();
  const genreId = args.genreId as string | undefined;

  if (!host.llm) return fail("No LLM on host — plan_edit needs host.llm set", "NOT_CONFIGURED");

  // Build SegmentMap from project's media library
  const project = host.getProject();
  const videoMedia = (project.mediaLibrary?.items ?? []).filter((m) => m.type === "video");

  const resolvedMap: SegmentMap = {
    videos: videoMedia.map((m) => ({
      videoId: m.id,
      sourceFile: m.name ?? m.id,
      duration: m.metadata.duration,
      segments: [{ id: `${m.id}-seg-0`, startTime: 0, endTime: m.metadata.duration, sceneType: "b-roll", motionLevel: "medium", description: `${m.name}`, hasDialogue: false, visualContent: m.name, confidence: 0.5 }],
    })),
  };

  // Build director prompt with footage summary
  const genre = genreId ? PRE_BAKED_GENRES.find((g) => g.id === genreId) : undefined;
  const directorPrompt = buildDirectorPrompt(resolvedMap, prompt, genre);

  // Nested LLM call — only gives it the submit_edit_plan tool
  const planTools = host.llm.provider === "anthropic"
    ? toAnthropicTools(["submit_edit_plan"])
    : toOpenAITools(["submit_edit_plan"]);

  const response = await host.llm.client.complete({
    system: directorPrompt,
    messages: [{ role: "user", content: "Analyze the footage and call submit_edit_plan with your complete EditPlan." }],
    tools: planTools,
  });

  // Extract the plan from the tool call
  const planCall = response.toolUses.find((t) => t.name === "submit_edit_plan");
  const plan = planCall.input as unknown as EditPlan;

  // Auto-resolve video references by name/fuzzy match
  const resolvedPlan = { ...plan, segments: plan.segments.map((seg) => ({
    ...seg,
    sourceVideoId: resolveVideoId(seg.sourceVideoId),
  }))};

  // Validate
  const planIssues = validateEditPlan(resolvedPlan, resolvedMap);
  const blocking = planIssues.filter((i) => i.severity === "error");
  if (blocking.length > 0) return fail(`Invalid EditPlan: ${blocking.map((i) => i.message).join("; ")}`, "INVALID_EDIT_PLAN");

  return ok(`plan_edit: ${resolvedPlan.segments.length} segment(s), ${resolvedPlan.textElements.length} text element(s)...`, { editPlan: resolvedPlan });
},
```

### 8c. submit_edit_plan (registry.ts:32189-32249)

Internal-only structured output tool. The LLM never calls this directly — it's used as the return mechanism for the nested director call:

```tsx
// registry.ts:32189-32249
{
  name: "submit_edit_plan",
  domain: "internal",
  internal: true,
  title: "Submit edit plan",
  description: "Internal-only: used by the director sub-call to return a structured EditPlan.",
  inputSchema: obj({
    segments: { type: "array", items: obj({ sourceVideoId: str, sourceStartTime: num, sourceEndTime: num, trackIndex: { type: "integer" }, targetPosition: num, speed: num, effects: { type: "array", items: str }, rationale: str }) },
    textElements: { type: "array", items: obj({ content: str, style: { enum: ["title", "subtitle", "lower-third", "caption", "callout"] }, startTime: num, duration: num, fontFamily: str, fontSize: num, color: str, animation: str, rationale: str }) },
    effects: { type: "array", items: obj({ targetSegmentIndex: { type: "integer" }, type: str, params: { type: "object" }, rationale: str }) },
    transitions: { type: "array", items: obj({ afterSegmentIndex: { type: "integer" }, type: str, duration: num, rationale: str }) },
    audioDecisions: { type: "array", items: obj({ type: { enum: ["music", "sfx", "silence"] }, sourceVideoId: str, sourceStartTime: num, sourceEndTime: num, startTime: num, duration: num, volume: num, rationale: str }) },
    metadata: obj({ targetDuration: num, targetPlatform: str, genre: str, pacing: { enum: ["fast", "medium", "slow"] }, rationale: str }),
  }),
  readOnly: true,
  handler: async () => fail("submit_edit_plan is structured-output-only", "NOT_EXECUTABLE"),
},
```

### 8d. Director Prompt — director-prompt.ts

**File:** `packages/agent/src/director/director-prompt.ts`

The prompt that tells the nested LLM how to be a film director:

```tsx
// director-prompt.ts:4-40
export const DIRECTOR_SYSTEM_PROMPT = `You are Monet, an AI film director for Kove Advanced. You analyze footage and create professional edits.

## Your Role
You transform raw footage into polished edits by:
1. Understanding what's in each video (via SegmentMap)
2. Making directorial decisions (via EditPlan)
3. **Executing the plan** by calling editing tools — the user expects edits on their timeline, not a plan in chat

## Critical Rules
- **NEVER ask for media IDs, clip IDs, or any internal identifiers.**
- **Execute every item in the plan.** The user expects edits on their timeline, not a plan in chat.

## Workflow
1. Review the SegmentMap — understand what's in each video
2. Create an EditPlan that fulfills the user's request
3. **IMMEDIATELY EXECUTE the plan** by calling editing tools
4. Summarize what was done

## Directorial Principles
- **Pacing matters**: Match cut rhythm to the content.
- **Story arc**: Even short edits have a beginning, middle, and end.
- **Audio drives emotion**: Music sets the tone.
- **Less is more**: Don't over-edit.`;
```

### 8e. System prompt tells Monet to execute

**File:** `packages/agent/src/system-prompt.ts:49-62`

The main system prompt explicitly instructs the agent to execute the plan, not just return it:

```tsx
// system-prompt.ts:49-62
"Monet — AI Director Workflow:",
"- When the user wants to create an edit from uploaded footage, follow this sequence IN FULL:",
"  0. Call `get_editor_state` to discover all media IDs, clip IDs, and track IDs.",
"  1. Call `plan_edit` with the user prompt + optional genre.",
"  2. **IMMEDIATELY EXECUTE the EditPlan** — do NOT just return the plan to the user.",
"     a. For each PlannedSegment: use split_clip, move_clip, set_clip_speed, add_video_effect.",
"     b. For each PlannedText: use create_text_clip with the specified style, position, timing.",
"     c. For each PlannedTransition: use add_transition between segments.",
"     d. For each PlannedAudio: adjust audio levels as specified.",
"  3. After executing ALL items, summarize what was done.",
"- **The plan is an INTERNAL instruction set — execute it, don't just show it.**",
```

---

## Step 9: Confirmation Flow — InlineConfirmCard.tsx

**File:** `apps/web/src/components/editor/chat/InlineConfirmCard.tsx`

When a destructive/expensive tool is called, the UI shows a confirmation card:

```tsx
// InlineConfirmCard.tsx:8-53
export function InlineConfirmCard({ call }: { call: ToolCall }): JSX.Element {
  const resolveConfirm = useChatStore((s) => s.resolveConfirm);

  return (
    <div className="rounded-lg border border-status-warning/40 bg-status-warning/10 p-2.5">
      <div className="mb-1 flex items-center gap-1.5 font-medium text-fg">
        <AlertTriangle size={13} className="text-status-warning" />
        Confirm action
      </div>
      <Text>The assistant wants to run <span className="font-mono">{call.name}</span></Text>
      <pre className="mb-2 max-h-32 overflow-auto rounded bg-bg-2 p-1.5 font-mono text-[10px]">
        {JSON.stringify(call.args, null, 2)}
      </pre>
      <div className="flex gap-1.5">
        <Button label="Approve" onClick={() => resolveConfirm("approve")} />
        <Button label="Approve all this turn" onClick={() => resolveConfirm("approve_for_turn")} />
        <Button label="Reject" onClick={() => resolveConfirm("reject")} />
      </div>
    </div>
  );
}
```

The chat store resolves the promise that the loop is waiting on:

```tsx
// chat-store.ts:430-435
resolveConfirm: (decision) => {
  const pending = get().pendingConfirm;
  if (!pending) return;
  set({ pendingConfirm: null, status: "running" });
  pending.resolve(decision);
},
```

---

## Step 10: LLM Response Parsing — llm.ts

**File:** `packages/agent/src/llm.ts`

Parses responses from both Anthropic and OpenAI-compatible providers. The OpenAI parser is resilient to malformed tool calls:

```tsx
// llm.ts:345-419 — parseOpenAIResponse (key section)
export function parseOpenAIResponse(raw: unknown): LLMResponse {
  const choice = r.choices?.[0];
  const msg = choice?.message;

  const toolUses: LLMToolUse[] = [];
  for (let index = 0; index < rawToolCalls.length; index++) {
    const rawToolCall = rawToolCalls[index];
    const fn = isRecord(rawToolCall.function) ? rawToolCall.function : rawToolCall;
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!name) continue; // skip malformed tool calls instead of crashing
    toolUses.push({
      id: typeof rawToolCall.id === "string" ? rawToolCall.id : `compatible-tool-call-${index}`,
      name,
      input: parseToolInput(fn.arguments, name),
    });
  }
  // ...
}
```

---

## Step 11: Export — ExportDialog.tsx

**File:** `apps/web/src/components/editor/ExportDialog.tsx`

After edits are applied, the user can export. The export dialog calls `onExport(settings)` which triggers the render pipeline:

```tsx
// ExportDialog.tsx:78-86 — Props
interface ExportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onExport: (settings: VideoExportSettings) => void;
  duration?: number;
  projectWidth?: number;
  projectHeight?: number;
  frameRate?: number;
  sourceMatch?: SourceExportMatch | null;
}
```

The `export_video` agent tool also exists for AI-initiated exports:

```tsx
// registry.ts:32380-32387
jobTool(
  "export_video",
  "export",
  "Export video",
  "Render the whole project to a local video file (format: mp4|webm|mov, default mp4).",
  "exportVideo",
  obj({ format: str }),
),
```

---

## Step 12: Editor State Serialization — serialize.ts

**File:** `packages/agent/src/serialize.ts`

The system prompt includes a blob-free view of the project so the LLM knows what's on the timeline:

```tsx
// serialize.ts:8-30
export interface EditorStateView {
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly settings: { readonly width: number; readonly height: number; readonly fps: number };
  };
  readonly durationSec: number;
  readonly trackCount: number;
  readonly clipCount: number;
  readonly mediaCount: number;
  readonly overlayCount: number;
  readonly creation?: {
    readonly version: string;
    readonly assetCount: number;
    readonly sceneCount: number;
    readonly activeSceneId?: string;
    readonly operationCount: number;
  };
}
```

---

## Complete File List

| Step | File | Role |
|------|------|------|
| 1 | `apps/web/src/components/editor/chat/ChatPanel.tsx` | Chat UI, empty state, header controls |
| 2 | `apps/web/src/components/editor/chat/ChatComposer.tsx` | Text input, Enter-to-send |
| 3 | `apps/web/src/stores/chat-store.ts` | Zustand store, orchestrates send/confirm/undo |
| 4 | `apps/web/src/services/agent/llm-transport.ts` | HTTP transport for Cloudflare/BYOK providers |
| 5 | `packages/agent/src/system-prompt.ts` | System prompt with Monet workflow + editor state |
| 6 | `packages/agent/src/loop.ts` | Agent loop: LLM → tool calls → execute → repeat |
| 7 | `packages/agent/src/executor.ts` | Tool dispatch, clip reference resolution |
| 8a | `packages/agent/src/registry.ts:32089-32185` | `extract_segments` — frame analysis → SegmentMap |
| 8b | `packages/agent/src/registry.ts:32252-32377` | `plan_edit` — nested LLM call → EditPlan |
| 8c | `packages/agent/src/registry.ts:32189-32249` | `submit_edit_plan` — internal structured output tool |
| 8d | `packages/agent/src/director/director-prompt.ts` | Director system prompt for nested LLM |
| 8e | `packages/agent/src/system-prompt.ts:49-62` | "Execute the plan, don't just show it" instruction |
| 9 | `apps/web/src/components/editor/chat/InlineConfirmCard.tsx` | Confirmation UI for destructive actions |
| 10 | `packages/agent/src/llm.ts` | LLM client, response parsing, retry logic |
| 11 | `apps/web/src/components/editor/ExportDialog.tsx` | Export settings dialog |
| 12 | `packages/agent/src/serialize.ts` | Editor state → token-efficient JSON for system prompt |

---

## Data Flow Diagram

```
User: "Make a 30s highlight reel"
       │
       ▼
ChatPanel ──send()──▶ chat-store.ts
       │
       ▼
chat-store builds:
  ├─ LLM client (llm-transport.ts → Cloudflare/BYOK)
  ├─ System prompt (system-prompt.ts → serializeEditorState + Monet workflow)
  ├─ Tool definitions (registry.ts → toOpenAITools/selectToolsForPrompt)
  └─ Conversation history
       │
       ▼
runTurn() (loop.ts)
       │
       ├─ LLM responds: "I'll analyze your footage" + tool_call: extract_segments
       │  ├─ executor.ts → registry handler
       │  ├─ captureBaselineFrames() → frame-worker
       │  └─ Returns SegmentMap
       │
       ├─ LLM responds: tool_call: plan_edit(prompt="30s highlight reel")
       │  ├─ plan_edit handler reads project media → builds SegmentMap
       │  ├─ buildDirectorPrompt() → director-prompt.ts
       │  ├─ Nested LLM call with submit_edit_plan tool
       │  ├─ LLM returns EditPlan via submit_edit_plan
       │  ├─ validateEditPlan() checks for errors
       │  └─ Returns EditPlan
       │
       ├─ LLM responds: "I'll now execute the plan"
       │  ├─ tool_call: split_clip(...)
       │  ├─ tool_call: move_clip(...)
       │  ├─ tool_call: create_text_clip(...)
       │  ├─ tool_call: add_transition(...)
       │  ├─ tool_call: add_video_effect(...)
       │  └─ (repeats for all items in EditPlan)
       │
       └─ LLM responds: "Done! I created a 30s highlight reel with..."
            │
            ▼
       User clicks Export → ExportDialog → export_video → render pipeline
```
