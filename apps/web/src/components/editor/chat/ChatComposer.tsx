import type { JSX } from "react";
import { useState, useCallback, type KeyboardEvent } from "react";
import { ToolcraftIconButton as IconButton } from "@kove-advanced/ui";
import { ToolcraftTextAreaControl } from "@kove-advanced/ui";
import { Send, Square } from "@/icons/lucide-compat";
import { useChatStore } from "../../../stores/chat-store";

export function ChatComposer(): JSX.Element {
  const status = useChatStore((s) => s.status);
  const send = useChatStore((s) => s.send);
  const stop = useChatStore((s) => s.stop);
  const analysisMode = useChatStore((s) => s.analysisMode);
  const setAnalysisMode = useChatStore((s) => s.setAnalysisMode);
  const [text, setText] = useState("");
  const busy = status === "running" || status === "awaiting_confirm";

  const submit = useCallback(() => {
    const value = text.trim();
    if (!value || busy) return;
    setText("");
    void send(value);
  }, [text, busy, send]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    },
    [submit],
  );

  return (
    <div className="border-t border-border p-2">
      <div className="relative rounded-lg border border-border bg-bg-2 transition-colors focus-within:border-accent">
        <ToolcraftTextAreaControl
          label="AI edit request"
          isLabelHidden
          value={text}
          onChange={setText}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder="Ask the AI to edit your video…"
          inputClassName="block w-full resize-none bg-transparent px-3 py-2 pr-11 text-[13px] text-fg outline-none placeholder:text-fg-muted"
        />
        <div className="absolute bottom-1.5 right-1.5">
          {busy ? (
            <IconButton
              label="Stop"
              icon={<Square size={12} className="fill-current" aria-hidden />}
              size="sm"
              variant="destructive"
              onClick={stop}
              className="grid h-7 w-7 place-items-center rounded-md bg-status-error/15 text-status-error transition-colors hover:bg-status-error/25"
            />
          ) : (
            <IconButton
              label="Send"
              icon={<Send size={12} aria-hidden />}
              size="sm"
              variant="primary"
              onClick={submit}
              isDisabled={!text.trim()}
              className="grid h-7 w-7 place-items-center rounded-md bg-accent text-accent-fg transition-colors hover:bg-accent/90 disabled:opacity-40"
            />
          )}
        </div>
      </div>
      <div className="mt-1 flex items-center gap-2 px-1">
        <span className="text-[10px] text-fg-muted">
          Enter to send · Shift+Enter for a new line
        </span>
        <div className="ml-auto">
          <button
            type="button"
            onClick={() => setAnalysisMode(analysisMode === "eco" ? "ai" : "eco")}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
              analysisMode === "eco"
                ? "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25"
                : "bg-violet-500/15 text-violet-400 hover:bg-violet-500/25"
            }`}
            title={analysisMode === "eco" ? "Local analysis (free)" : "AI vision analysis (uses credits)"}
          >
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                analysisMode === "eco" ? "bg-emerald-400" : "bg-violet-400"
              }`}
            />
            {analysisMode === "eco" ? "Eco" : "AI"}
          </button>
        </div>
      </div>
    </div>
  );
}
