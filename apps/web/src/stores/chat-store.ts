import { create } from "zustand";
import {
  runTurn,
  toAnthropicTools,
  toOpenAITools,
  buildSystemPrompt,
  selectToolsForPrompt,
  setAnalysisMode as setAgentAnalysisMode,
  parseReferenceIntent,
  referenceIntentDirective,
} from "@kove-advanced/agent";
import type {
  AgentEvent,
  ConfirmDecision,
  ToolCall,
  ToolResult,
  LoopMessage,
  ReferenceIntent,
  ReferenceApplication,
} from "@kove-advanced/agent";
import type { ReferenceProfile } from "@kove-advanced/core/mirror/reference-profile";
import { isSessionUnlocked, getSecret } from "../services/secure-storage";
import { getLiveEditorHost, runExclusive } from "../services/agent/host-singleton";
import { makeBYOKClient } from "../services/agent/llm-transport";
import { normalizeCompatibleBaseUrl } from "../services/api-proxy";
import {
  measureReferenceVideo,
  enrichReferenceVideo,
  applyReferenceStructure,
  attachReferenceProfile,
} from "../services/mirror/reference-flow";
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
  /** Set on user messages that carried a reference video. */
  readonly reference?: ChatReferenceTag;
}

/** The reference a user message carried, shown as a tag under the message. */
export interface ChatReferenceTag {
  readonly name: string;
  readonly intent: ReferenceIntent;
}

/** A reference video the user attached to the chat. */
export interface ReferenceAttachment {
  /** The media-library id of the reference; it is tagged analysisRole=reference. */
  readonly mediaId: string;
  readonly name: string;
  /** Kept so the reference can be measured without a second import. */
  readonly file: File | null;
}

interface PendingConfirm {
  readonly call: ToolCall;
  readonly resolve: (decision: ConfirmDecision) => void;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
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
  projectId: string | null;
  currentConversationId: string | null;
  conversationStartedAt: number | null;
  /** The reference video attached to the next turn, if any. */
  reference: ReferenceAttachment | null;
  /** What the director should do with the reference when the message is silent. */
  referenceIntent: ReferenceIntent;

  send: (text: string) => Promise<void>;
  attachReference: (file: File) => Promise<void>;
  clearReference: () => void;
  setReferenceIntent: (intent: ReferenceIntent) => void;
  setAnalysisMode: (mode: "eco" | "ai") => void;
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

/**
 * The reference for this turn: the one attached in the chat, or the one the
 * user marked as a reference in the Assets panel.
 */
function resolveReferenceAttachment(explicit: ReferenceAttachment | null): ReferenceAttachment | null {
  if (explicit) return explicit;
  const items = useProjectStore.getState().project.mediaLibrary.items;
  const marked = items.find((item) => item.type === "video" && item.analysisRole === "reference");
  if (!marked) return null;
  return { mediaId: marked.id, name: marked.name, file: null };
}

/** Reads the bytes of a reference that may live in the media library only. */
async function referenceBytes(attachment: ReferenceAttachment): Promise<Blob | null> {
  if (attachment.file) return attachment.file;
  const item = useProjectStore.getState().project.mediaLibrary.items.find(
    (media) => media.id === attachment.mediaId,
  );
  if (!item) return null;
  if (item.blob) return item.blob;
  try {
    return (await item.fileHandle?.getFile()) ?? null;
  } catch {
    return null;
  }
}

/** The footage the reference structure may be applied to. */
function referenceSourceMedia(): Array<{ id: string; name: string; duration: number; blob: Blob | null }> {
  return useProjectStore
    .getState()
    .project.mediaLibrary.items.filter(
      (item) => item.type === "video" && item.analysisRole !== "reference",
    )
    .map((item) => ({
      id: item.id,
      name: item.name,
      duration: item.metadata.duration,
      blob: item.blob,
    }));
}

interface PrepareReferenceTurnInput {
  readonly intent: ReferenceIntent;
  readonly attachment: ReferenceAttachment | null;
  readonly parsedPrompt: string;
  readonly notice: (message: string) => void;
}

/**
 * Prepares a reference turn before the model sees it: the reference is
 * measured on this device, and for a 1:1 intent the structure is applied to
 * the user's footage so the model adds craft on top of a real cut instead of
 * planning a fresh timeline. Returns the message the model receives.
 */
async function prepareReferenceTurn(
  input: PrepareReferenceTurnInput,
): Promise<{ text: string; applied: ReferenceApplication }> {
  const { intent, attachment, parsedPrompt, notice } = input;
  if (!attachment) {
    const directive = referenceIntentDirective({
      intent,
      referenceName: "",
      attached: false,
      applied: "none",
    });
    return { text: `${parsedPrompt}\n\n${directive}`, applied: "none" };
  }

  const warnings: string[] = [];
  let profile: ReferenceProfile | null = null;
  let applied: ReferenceApplication = "none";

  const bytes = await referenceBytes(attachment);
  if (!bytes) {
    warnings.push("The reference video is not available locally, so it could not be measured.");
  } else {
    try {
      notice("Measuring the reference…");
      const measured = await measureReferenceVideo(bytes, (done, total) =>
        notice(`Measuring the reference… ${done}/${total} frames`),
      );
      notice("Detecting beats and captions in the reference…");
      profile = await enrichReferenceVideo(bytes, measured.profile, notice);
      if (intent === "reference") {
        // Style guidance only: the EditDNA is attached so the plan can follow
        // the reference's rhythm, but the timeline is not rebuilt.
        await attachReferenceProfile(profile);
      } else {
        const sources = referenceSourceMedia();
        if (!sources.length) {
          warnings.push("No source footage is in the library, so the reference structure was not applied.");
        } else {
          notice("Rebuilding your footage to the reference structure…");
          const result = await applyReferenceStructure(profile, sources);
          warnings.push(...result.warnings);
          applied = "structure";
        }
      }
    } catch (error) {
      warnings.push(
        `The reference could not be measured: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  const directive = referenceIntentDirective({
    intent,
    referenceName: attachment.name,
    referenceMediaId: attachment.mediaId,
    attached: true,
    applied,
    ...(profile
      ? {
          fps: `${profile.fps.num}/${profile.fps.den}`,
          durationSeconds: (profile.durationFrames * profile.fps.den) / profile.fps.num,
          shotCount: profile.shots.length,
          aspectRatio: `${profile.aspectRatio.width}x${profile.aspectRatio.height}`,
          dominantMoves: profile.shots.map((shot) => shot.cameraMotion?.dominantMove ?? "unknown"),
          beatCount: profile.beatGridMs.length,
          captionWindowCount: profile.shots.reduce(
            (sum, shot) => sum + shot.captionWindows.length,
            0,
          ),
        }
      : {}),
    warnings: [...warnings, ...(profile?.warnings ?? [])],
  });
  return { text: `${parsedPrompt}\n\n${directive}`, applied };
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
  projectId: null,
  currentConversationId: null,
  conversationStartedAt: null,
  reference: null,
  referenceIntent: "replicate" as const,

  setAnalysisMode: (mode) => {
    set({ analysisMode: mode });
    setAgentAnalysisMode(mode);
  },

  attachReference: async (file: File) => {
    const projectStore = useProjectStore.getState();
    const before = new Set(projectStore.project.mediaLibrary.items.map((item) => item.id));
    const imported = await projectStore.importMedia(file);
    if (!imported.success) {
      set({ error: imported.error?.message ?? "The reference video could not be imported." });
      return;
    }
    const items = useProjectStore.getState().project.mediaLibrary.items;
    // The import reports the id of the item it created. Identifying the new
    // item by diffing the library instead would tag the wrong item when
    // another import finishes at the same time — and tagging the user's
    // source footage as the reference would leave the mirror nothing to cut.
    const added = imported.actionId
      ? items.find((item) => item.id === imported.actionId)
      : items.find((item) => !before.has(item.id));
    if (!added) {
      set({ error: "The reference video was imported but could not be identified." });
      return;
    }
    // The reference is tagged so the model treats it as style, never as footage.
    const tagged = await useProjectStore.getState().setMediaAnalysisRole(added.id, "reference");
    if (!tagged.success) {
      set({ error: tagged.error?.message ?? "The reference video could not be tagged." });
      return;
    }
    getLiveEditorHost().setMirrorReference(file);
    set({ reference: { mediaId: added.id, name: added.name, file }, error: null });
  },

  clearReference: () => {
    set({ reference: null });
  },

  setReferenceIntent: (intent: ReferenceIntent) => {
    set({ referenceIntent: intent });
  },

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

    if (provider === "cloudflare") {
      // Cloudflare: zero-config from .dev.vars via Vite plugin — no BYOK needed
      apiKey = import.meta.env.VITE_CLOUDFLARE_API_TOKEN ?? "";
      baseUrl = import.meta.env.VITE_CLOUDFLARE_ACCOUNT_ID ?? "";
      model = settings.llmModel.trim() || import.meta.env.VITE_CLOUDFLARE_AI_MODEL || "@cf/google/gemma-4-26b-a4b-it";
      if (!apiKey || !baseUrl) {
        set({ error: "Cloudflare credentials not found in .dev.vars." });
        return;
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
    // The reference intent travels with the message: an explicit slash command
    // wins, then keyword phrasing, then whatever the user picked in the chat.
    const parsedIntent = parseReferenceIntent(trimmed);
    const attachment = resolveReferenceAttachment(get().reference);
    const referenceIntent = parsedIntent.intent ?? (attachment ? get().referenceIntent : null);
    const userMessage: ChatMessage = {
      id: genId(),
      role: "user",
      text: trimmed,
      toolCalls: [],
      ...(attachment && referenceIntent
        ? { reference: { name: attachment.name, intent: referenceIntent } }
        : {}),
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

    // The reference is handled before the model sees the turn: it is measured on
    // this device and, for a 1:1 intent, applied to the source footage, so the
    // model adds craft on top of a real cut instead of planning a new one.
    let turnText = trimmed;
    let directorPlanApplied = false;
    if (referenceIntent) {
      const prepared = await prepareReferenceTurn({
        intent: referenceIntent,
        attachment,
        parsedPrompt: parsedIntent.prompt,
        notice: (message) => updateAssistant((m) => ({ ...m, notice: message })),
      });
      turnText = prepared.text;
      // The structure is already on the timeline: the model adds craft to it
      // instead of replacing it with a fresh plan.
      directorPlanApplied = prepared.applied === "structure";
      if (controller.signal.aborted) {
        set({ status: "idle", abortController: null });
        return;
      }
      set((state) => ({
        conversation: [
          ...state.conversation.slice(0, -1),
          { role: "user", content: turnText },
        ],
      }));
    }

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
    const llm = makeBYOKClient({
      provider,
      model,
      apiKey,
      baseUrl,
      signal: controller.signal,
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
          confirmGate: autoConfirm
            ? () => "approve_for_turn"
            : (call) =>
                new Promise<ConfirmDecision>((resolve) => {
                  set({ status: "awaiting_confirm", pendingConfirm: { call, resolve } });
                }),
                  enforceDirectorWorkflow: true,
          directorPlanApplied,
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
        return {
          ...message,
          text: finalText,
          notice: stopNotice ?? emptyNotice,
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
      reference: null,
      referenceIntent: "replicate",
    });
  },
}));
