import type { JSX } from "react";
import { useEffect, useState } from "react";
import { Bot, Loader2, Paperclip, User } from "@/icons/lucide-compat";
import type { ChatMessage as ChatMessageData } from "../../../stores/chat-store";
import { MarkdownMessage } from "./MarkdownMessage";
import { ToolCallCard } from "./ToolCallCard";
import { PromptExpansionCard } from "./PromptExpansionCard";
import { useChatStore } from "../../../stores/chat-store";

export function ChatMessage({
  message,
  pending = false,
}: {
  message: ChatMessageData;
  pending?: boolean;
}): JSX.Element {
  const isUser = message.role === "user";
  const send = useChatStore((s) => s.send);
  const [now, setNow] = useState(Date.now);
  const activeTool = message.toolCalls.find((call) => call.status === "running");

  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pending]);

  const elapsedSeconds = message.startedAt
    ? Math.max(0, Math.floor((now - message.startedAt) / 1000))
    : null;
  const elapsedLabel = elapsedSeconds === null
    ? null
    : `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`;
  const activityLabel = activeTool
    ? `Using tool: ${activeTool.name}`
    : message.notice ?? "Waiting for Monet's next response";

  return (
    <div className="flex gap-2">
      <div
        className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md ${
          isUser ? "bg-bg-2 text-fg-2" : "bg-accent-soft text-accent"
        }`}
      >
        {isUser ? <User size={13} /> : <Bot size={13} />}
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        {message.text && (isUser ? (
          <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg">
            {message.text}
          </div>
        ) : (
          <MarkdownMessage text={message.text} />
        ))}
        {isUser && message.reference && (
          <div className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] text-accent">
            <Paperclip size={10} aria-hidden />
            <span className="max-w-[10rem] truncate">{message.reference.name}</span>
            <span className="opacity-70">
              {message.reference.intent === "replicate"
                ? "replicate"
                : message.reference.intent === "recreate"
                  ? "recreate"
                  : "reference"}
            </span>
          </div>
        )}
        {!isUser && pending && (
          <div
            className="flex items-start gap-2 rounded-md border border-accent/30 bg-accent-soft/40 px-2.5 py-2 text-[12px] text-fg"
            role="status"
          >
            <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-accent" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{activityLabel}</div>
              {activeTool && message.notice && (
                <div className="mt-0.5 break-words text-[10px] text-fg-muted">
                  {message.notice}
                </div>
              )}
            </div>
            {elapsedLabel && (
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-fg-muted">
                {elapsedLabel}
              </span>
            )}
          </div>
        )}
        {!isUser && message.expansion && (
          <PromptExpansionCard
            expansion={message.expansion}
            onUseExpanded={(expanded) => send(expanded)}
            onAnswerQuestions={(answers) => send(answers)}
          />
        )}
        {message.toolCalls.length > 0 && (
          <div className="space-y-1">
            {message.toolCalls.map((call) => (
              <ToolCallCard key={call.id} call={call} />
            ))}
          </div>
        )}
        {!isUser && message.notice && !pending && (
          <div className="rounded-md border border-border bg-bg-2/70 px-2.5 py-2 text-[11px] leading-relaxed text-fg-2">
            {message.notice}
          </div>
        )}
      </div>
    </div>
  );
}
