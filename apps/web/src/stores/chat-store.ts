import { create } from "zustand";
import {
  runTurn,
  toAnthropicTools,
  toOpenAITools,
  buildSystemPrompt,
  selectToolsForPrompt,
  setAnalysisMode as setAgentAnalysisMode,
} from "@kove-advanced/agent";
import type {
  AgentEvent,
  ConfirmDecision,
  ToolCall,
  ToolResult,
  LoopMessage,
} from "@kove-advanced/agent";
import { isSessionUnlocked, getSecret } from "../services/secure-storage";
import { getLiveEditorHost, runExclusive } from "../services/agent/host-singleton";
import { makeBYOKClient } from "../services/agent/llm-transport";
import { normalizeCompatibleBaseUrl } from "../services/api-proxy";
import {
  conversationTitle,
  useChatHistoryStore,
} from "./chat-history-store";
import { useSettingsStore } from "./settings-store";
import { useProjectStore } from "./project-store";

export type ChatStatus = "idle" | "running" | "awaiting_confirm" | "error";

export type ToolCallStatus = "running" | "done" | "error" | "rejected";

export interface ToolCallView {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly status: ToolCallStatus;
  readonly result?: ToolResult;
}

export interface PromptExpansionData {
  readonly expandedPrompt: string;
  readonly completenessScore: number;
  readonly questions: string[] | null;
  readonly rationale: string;
  readonly detectedGaps: string[];
}

export interface ChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly toolCalls: ToolCallView[];
  readonly notice?: string;
  readonly expansion?: PromptExpansionData;
  readonly pendingQuestions?: string[];
}

interface PendingConfirm {
  readonly call: ToolCall;
  readonly resolve: (decision: ConfirmDecision) => void;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AnalysisProgress {
  readonly stage: string;
  readonly message: string;
  readonly current?: number;
  readonly total?: number;
}

interface ChatState {
  messages: ChatMessage[];
  status: ChatStatus;
  conversation: LoopMessage[];
  pendingConfirm: PendingConfirm | null;
  error: string | null;
  abortController: AbortController | null;
  lastTurnCommitted: boolean;
  lastTurnUndoSize: number | null;
  usage: TokenUsage;
  analysisMode: "eco" | "ai";
  analysisProgress: AnalysisProgress | null;
  projectId: string | null;
  currentConversationId: string | null;
  conversationStartedAt: number | null;

  send: (text: string) => Promise<void>;
  setAnalysisMode: (mode: "eco" | "ai") => void;
  setAnalysisProgress: (progress: AnalysisProgress | null) => void;
  resolveConfirm: (decision: ConfirmDecision) => void;
  stop: () => void;
  undoLastTurn: () => Promise<void>;
  clearError: () => void;
  setProjectContext: (projectId: string | null) => void;
  newChat: () => void;
  openConversation: (conversationId: string) => void;
  deleteConversation: (conversationId: string) => void;
  reset: () => void;
}

const genId = (): string =>
  (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto
    ?.randomUUID?.() ?? `m-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const isDesktop = (): boolean =>
  typeof window !== "undefined" && window["kove-advanced"]?.platform === "desktop";

// Monotonic turn id: a completion whose seq is stale (reset/superseded) must not
// write back into the store.
let activeSeq = 0;

function undoStackSize(): number | null {
  try {
    return useProjectStore.getState().actionExecutor.getHistory().getUndoStackSize();
  } catch {
    return null;
  }
}

function conversationFromMessages(messages: ChatMessage[]): LoopMessage[] {
  return messages.flatMap((message): LoopMessage[] => {
    if (!message.text.trim() && message.toolCalls.length === 0) return [];
    return message.role === "user"
      ? [{ role: "user", content: message.text }]
      : [
          {
            role: "assistant",
            content: message.text,
            toolUses: message.toolCalls.map((tc) => ({
              id: tc.id,
              name: tc.name,
              input: tc.args,
            })),
          },
        ];
  });
}

function saveConversationSnapshot(state: ChatState): void {
  if (
    !state.currentConversationId ||
    !state.projectId ||
    !state.messages.some((message) => message.role === "user")
  ) {
    return;
  }
  const now = Date.now();
  useChatHistoryStore.getState().saveConversation({
    id: state.currentConversationId,
    projectId: state.projectId,
    title: conversationTitle(state.messages),
    createdAt: state.conversationStartedAt ?? now,
    updatedAt: now,
    messages: state.messages,
    usage: state.usage,
    error: state.error ?? undefined,
  });
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  status: "idle",
  conversation: [],
  pendingConfirm: null,
  error: null,
  abortController: null,
  lastTurnCommitted: false,
  lastTurnUndoSize: null,
  usage: { inputTokens: 0, outputTokens: 0 },
  analysisMode: "eco" as const,
  analysisProgress: null,
  projectId: null,
  currentConversationId: null,
  conversationStartedAt: null,

  setAnalysisMode: (mode) => {
    set({ analysisMode: mode });
    setAgentAnalysisMode(mode);
  },

  setAnalysisProgress: (progress) => set({ analysisProgress: progress }),

  send: async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const current = get();
    if (current.status === "running" || current.status === "awaiting_confirm") {
      return;
    }

    const projectState = useProjectStore.getState();
    if (!projectState.hasOpenProject) {
      set({ error: "Open a project before running AI edits." });
      return;
    }
    const currentProjectId = projectState.project?.id ?? null;
    if (current.projectId && currentProjectId && current.projectId !== currentProjectId) {
      get().setProjectContext(currentProjectId);
    }

    const settings = useSettingsStore.getState();
    const provider = settings.defaultLlmProvider;
    if (!provider) {
      set({ error: "Choose an API format in AI settings." });
      return;
    }

    let model: string;
    let baseUrl: string;
    let apiKey: string;
    let cloudflareFallback: { accountId: string; apiToken: string } | undefined;

    if (provider === "cloudflare") {
      // Cloudflare: zero-config from .dev.vars via Vite plugin — no BYOK needed
      apiKey = import.meta.env.VITE_CLOUDFLARE_API_TOKEN ?? "";
      baseUrl = import.meta.env.VITE_CLOUDFLARE_ACCOUNT_ID ?? "";
      model = settings.llmModel.trim() || import.meta.env.VITE_CLOUDFLARE_AI_MODEL || "@cf/google/gemma-4-26b-a4b-it";
      if (!apiKey || !baseUrl) {
        set({ error: "Cloudflare credentials not found in .dev.vars." });
        return;
      }
      // Optional second token/account pair: used automatically once the
      // primary's daily neuron allocation is spent (code 4006).
      const fallbackToken = import.meta.env.VITE_CLOUDFLARE_API_TOKEN_2 ?? "";
      const fallbackAccountId = import.meta.env.VITE_CLOUDFLARE_ACCOUNT_ID_2 ?? "";
      if (fallbackToken && fallbackAccountId) {
        cloudflareFallback = { accountId: fallbackAccountId, apiToken: fallbackToken };
      }
    } else {
      // BYOK providers: require settings configuration
      model = settings.llmModel.trim();
      if (!model) {
        set({ error: "Enter or choose a model ID in AI settings." });
        return;
      }
      try {
        baseUrl = normalizeCompatibleBaseUrl(settings.llmBaseUrl);
      } catch (error) {
        set({ error: error instanceof Error ? error.message : "Enter a valid compatible endpoint URL." });
        return;
      }
      const keyRequired = settings.configuredServices.includes(provider);
      if (!isDesktop() && keyRequired && !isSessionUnlocked()) {
        set({ error: "Unlock secure storage to use your API key." });
        return;
      }
      apiKey = "";
      if (!isDesktop() && keyRequired) {
        try {
          apiKey = (await getSecret(provider)) ?? "";
        } catch {
          set({ error: "Unlock secure storage to use your API key." });
          return;
        }
        if (!apiKey) {
          set({ error: "The configured endpoint API key could not be loaded." });
          return;
        }
      }
    }
    const active = get();
    const conversationId = active.currentConversationId ?? genId();
    const conversationStartedAt = active.conversationStartedAt ?? Date.now();
    const userMessage: ChatMessage = {
      id: genId(),
      role: "user",
      text: trimmed,
      toolCalls: [],
    };
    const assistantMessage: ChatMessage = {
      id: genId(),
      role: "assistant",
      text: "",
      toolCalls: [],
    };
    const assistantId = assistantMessage.id;
    const controller = new AbortController();
    const seq = ++activeSeq;

    set((state) => ({
      messages: [...state.messages, userMessage, assistantMessage],
      conversation: [...state.conversation, { role: "user", content: trimmed }],
      status: "running",
      error: null,
      abortController: controller,
      pendingConfirm: null,
      projectId: currentProjectId,
      currentConversationId: conversationId,
      conversationStartedAt,
    }));

    const updateAssistant = (fn: (m: ChatMessage) => ChatMessage): void => {
      if (activeSeq !== seq) return;
      set((state) => ({
        messages: state.messages.map((m) => (m.id === assistantId ? fn(m) : m)),
      }));
    };

    const onEvent = (event: AgentEvent): void => {
      switch (event.type) {
        case "text_delta":
        case "turn_complete":
          updateAssistant((m) => ({ ...m, text: event.text || m.text }));
          break;
        case "tool_call":
          updateAssistant((m) => ({
            ...m,
            toolCalls: [
              ...m.toolCalls,
              {
                id: event.call.id,
                name: event.call.name,
                args: event.call.args,
                status: "running",
              },
            ],
          }));
          break;
        case "tool_result":
          // Return-type annotation keeps `status` a literal union — without it
          // the intermediate `map` widens to `string` and fails ChatMessage.
          updateAssistant((m): ChatMessage => {
            const updatedToolCalls: ToolCallView[] = m.toolCalls.map((tc) =>
              tc.id === event.call.id
                ? {
                    ...tc,
                    result: event.result,
                    status: event.result.ok
                      ? "done"
                      : event.result.error?.code === "REJECTED"
                        ? "rejected"
                        : "error",
                  }
                : tc,
            );

            let expansion = m.expansion;
            let pendingQuestions = m.pendingQuestions;

            if (event.call.name === "expand_prompt" && event.result.ok && event.result.data) {
              const data = event.result.data as {
                expandedPrompt?: string;
                completenessScore?: number;
                questions?: string[] | null;
                rationale?: string;
                detectedGaps?: string[];
              };
              expansion = {
                expandedPrompt: data.expandedPrompt ?? "",
                completenessScore: data.completenessScore ?? 0,
                questions: data.questions ?? null,
                rationale: data.rationale ?? "",
                detectedGaps: data.detectedGaps ?? [],
              };
              pendingQuestions = data.questions ?? undefined;
            }

            return { ...m, toolCalls: updatedToolCalls, expansion, pendingQuestions };
          });
          break;
        case "error":
          if (activeSeq === seq) set({ error: event.error.message });
          break;
        case "awaiting_confirmation":
          break;
      }
    };

    const host = getLiveEditorHost();
    let cloudflareSwitched = false;
    const llm = makeBYOKClient({
      provider,
      model,
      apiKey,
      baseUrl,
      signal: controller.signal,
      cloudflareFallback,
      onCloudflareSlotChange: (slot) => {
        if (slot === 2) cloudflareSwitched = true;
      },
    });
    // Wire LLM client into host for nested director calls (plan_edit)
    // Map settings provider to agent provider name for tool selection
    const agentProvider = provider === "anthropic-compatible" ? "anthropic" : "openai";
    host.llm = { client: llm, provider: agentProvider };
    const priorToolNames = get().conversation.flatMap((message) =>
      message.role === "assistant" ? message.toolUses.map((tool) => tool.name) : [],
    );
    const routingContext = get()
      .conversation.filter(
        (message): message is Extract<LoopMessage, { role: "user" }> =>
          message.role === "user",
      )
      .slice(-5)
      .map((message) => message.content)
      .join("\n");
    const selectedToolNames = selectToolsForPrompt(routingContext, {
      maxTools: provider === "cloudflare" ? 25 : 120,
      priorToolNames,
    });
    const tools =
      provider === "anthropic-compatible"
        ? toAnthropicTools(selectedToolNames)
        : toOpenAITools(selectedToolNames); // openai-compatible and cloudflare both use OpenAI format
    const autoConfirm = useSettingsStore.getState().agentAutoConfirm;
    const dryRun = useSettingsStore.getState().agentDryRun;

    let result;
    try {
      result = await runExclusive(() =>
        runTurn({
          host,
          llm,
          tools,
          system: buildSystemPrompt(host, selectedToolNames),
          messages: get().conversation,
          dryRun,
          // Workers AI free tier is 10k neurons/day (~1.1M tokens) and every
          // step re-sends the system prompt + tools (~6.8k tokens, no cache
          // discount). Cap the step budget there; other providers keep 12.
          limits: provider === "cloudflare" ? { maxSteps: 6 } : undefined,
          confirmGate: autoConfirm
            ? () => "approve_for_turn"
            : (call) =>
                new Promise<ConfirmDecision>((resolve) => {
                  set({ status: "awaiting_confirm", pendingConfirm: { call, resolve } });
                }),
                  enforceDirectorWorkflow: true,
          onEvent,
          turnLabel: "AI edit",
        }),
      );
    } catch (error) {
      if (activeSeq !== seq) return;
      set({
        status: controller.signal.aborted ? "idle" : "error",
        error: controller.signal.aborted
          ? null
          : error instanceof Error
            ? error.message
            : "The AI turn failed.",
        abortController: null,
        pendingConfirm: null,
      });
      saveConversationSnapshot(get());
      return;
    }

    // A reset() (or a newer turn) during the run supersedes this completion.
    if (activeSeq !== seq) return;
    const wasAborted = controller.signal.aborted;
    const stopNotice =
      result.stoppedReason === "max_steps"
        ? "I stopped after reaching this turn's step limit. Ask me to continue if more work is needed."
        : result.stoppedReason === "max_tool_calls"
          ? "I stopped after reaching this turn's tool-call limit. Ask me to continue if more work is needed."
          : result.stoppedReason === "budget"
            ? "The model stopped at its response or token limit. Ask me to continue, or increase the model's output limit."
            : undefined;
    set((state) => ({
      messages: state.messages.map((message) => {
        if (message.id !== assistantId) return message;
        const finalText = result.text || message.text;
        const emptyNotice =
          !finalText && result.stoppedReason === "end_turn"
            ? message.toolCalls.length > 0
              ? "The edits finished, but the model did not provide a written summary."
              : "The model returned an empty response. Try again or choose another model."
            : undefined;
        const quotaNotice = cloudflareSwitched
          ? "Switched to the secondary Cloudflare account — the primary account's daily AI allocation is spent."
          : undefined;
        return {
          ...message,
          text: finalText,
          notice: quotaNotice ?? stopNotice ?? emptyNotice,
        };
      }),
      conversation: result.messages,
      status: wasAborted
        ? "idle"
        : result.stoppedReason === "error"
          ? "error"
          : "idle",
      lastTurnCommitted: result.committed,
      lastTurnUndoSize: result.committed ? undoStackSize() : null,
      abortController: null,
      pendingConfirm: null,
      usage: {
        inputTokens: state.usage.inputTokens + result.usage.inputTokens,
        outputTokens: state.usage.outputTokens + result.usage.outputTokens,
      },
      error: wasAborted
        ? null
        : result.stoppedReason === "error"
          ? (state.error ?? "The AI turn failed.")
          : state.error,
    }));
    saveConversationSnapshot(get());
  },

  resolveConfirm: (decision: ConfirmDecision) => {
    const pending = get().pendingConfirm;
    if (!pending) return;
    set({ pendingConfirm: null, status: "running" });
    pending.resolve(decision);
  },

  stop: () => {
    const { abortController, pendingConfirm } = get();
    pendingConfirm?.resolve("reject");
    abortController?.abort();
    set({ pendingConfirm: null });
  },

  undoLastTurn: async () => {
    if (!get().lastTurnCommitted) return;
    // If the project's undo stack moved since the turn committed, a later edit
    // is on top — undoing it would hit the wrong action, so just drop the
    // affordance rather than clobber the user's edit.
    const checkpoint = get().lastTurnUndoSize;
    if (checkpoint !== null && undoStackSize() !== checkpoint) {
      set({ lastTurnCommitted: false, lastTurnUndoSize: null });
      return;
    }
    await useProjectStore.getState().undo();
    set({ lastTurnCommitted: false, lastTurnUndoSize: null });
  },

  clearError: () => set({ error: null }),

  setProjectContext: (projectId: string | null) => {
    const state = get();
    if (state.projectId === projectId) return;
    if (state.projectId !== null && (state.messages.length > 0 || state.conversation.length > 0)) {
      saveConversationSnapshot(state);
    }
    state.pendingConfirm?.resolve("reject");
    state.abortController?.abort();
    activeSeq++;
    set({
      messages: [],
      conversation: [],
      status: "idle",
      pendingConfirm: null,
      error: null,
      abortController: null,
      lastTurnCommitted: false,
      lastTurnUndoSize: null,
      usage: { inputTokens: 0, outputTokens: 0 },
      projectId,
      currentConversationId: null,
      conversationStartedAt: null,
    });
  },

  newChat: () => {
    const state = get();
    if (state.status === "running" || state.status === "awaiting_confirm") return;
    saveConversationSnapshot(state);
    activeSeq++;
    set({
      messages: [],
      conversation: [],
      status: "idle",
      pendingConfirm: null,
      error: null,
      abortController: null,
      lastTurnCommitted: false,
      lastTurnUndoSize: null,
      usage: { inputTokens: 0, outputTokens: 0 },
      currentConversationId: null,
      conversationStartedAt: null,
    });
  },

  openConversation: (conversationId: string) => {
    const state = get();
    if (state.status === "running" || state.status === "awaiting_confirm") return;
    const saved = useChatHistoryStore
      .getState()
      .conversations.find((item) => item.id === conversationId);
    if (!saved || (state.projectId && saved.projectId !== state.projectId)) return;
    if (state.currentConversationId !== conversationId) {
      saveConversationSnapshot(state);
    }
    activeSeq++;
    set({
      messages: saved.messages,
      conversation: conversationFromMessages(saved.messages),
      status: "idle",
      pendingConfirm: null,
      error: saved.error ?? null,
      abortController: null,
      lastTurnCommitted: false,
      lastTurnUndoSize: null,
      usage: saved.usage,
      projectId: saved.projectId,
      currentConversationId: saved.id,
      conversationStartedAt: saved.createdAt,
    });
  },

  deleteConversation: (conversationId: string) => {
    useChatHistoryStore.getState().deleteConversation(conversationId);
    if (get().currentConversationId !== conversationId) return;
    activeSeq++;
    set({
      messages: [],
      conversation: [],
      status: "idle",
      pendingConfirm: null,
      error: null,
      abortController: null,
      lastTurnCommitted: false,
      lastTurnUndoSize: null,
      usage: { inputTokens: 0, outputTokens: 0 },
      currentConversationId: null,
      conversationStartedAt: null,
    });
  },

  reset: () => {
    get().pendingConfirm?.resolve("reject");
    get().abortController?.abort();
    // Supersede any in-flight turn so its completion can't write back.
    activeSeq++;
    set({
      messages: [],
      conversation: [],
      status: "idle",
      pendingConfirm: null,
      error: null,
      abortController: null,
      lastTurnCommitted: false,
      lastTurnUndoSize: null,
      usage: { inputTokens: 0, outputTokens: 0 },
      projectId: null,
      currentConversationId: null,
      conversationStartedAt: null,
    });
  },
}));
