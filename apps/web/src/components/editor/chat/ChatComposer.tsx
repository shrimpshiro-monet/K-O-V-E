import type { JSX } from "react";
import { useState, useCallback, useRef, type KeyboardEvent } from "react";
import { ToolcraftIconButton as IconButton } from "@kove-advanced/ui";
import { ToolcraftTextAreaControl } from "@kove-advanced/ui";
import { Paperclip, Send, Square } from "@/icons/lucide-compat";
import { useChatStore } from "../../../stores/chat-store";
import type { ReferenceIntent } from "@kove-advanced/agent";

const INTENT_OPTIONS: ReadonlyArray<{
  id: ReferenceIntent;
  label: string;
  hint: string;
}> = [
  {
    id: "replicate",
    label: "Replicate",
    hint: "Rebuild my footage to the reference, 1:1, then add craft on top",
  },
  {
    id: "recreate",
    label: "Recreate",
    hint: "Same shot structure as the reference, but a new creative layer",
  },
  {
    id: "reference",
    label: "Reference",
    hint: "Style guidance only — the reference is never cut as footage",
  },
];

export function ChatComposer(): JSX.Element {
  const status = useChatStore((s) => s.status);
  const send = useChatStore((s) => s.send);
  const stop = useChatStore((s) => s.stop);
  const analysisMode = useChatStore((s) => s.analysisMode);
  const setAnalysisMode = useChatStore((s) => s.setAnalysisMode);
  const reference = useChatStore((s) => s.reference);
  const referenceIntent = useChatStore((s) => s.referenceIntent);
  const setReferenceIntent = useChatStore((s) => s.setReferenceIntent);
  const attachReference = useChatStore((s) => s.attachReference);
  const clearReference = useChatStore((s) => s.clearReference);
  const [text, setText] = useState("");
  const [attaching, setAttaching] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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

  const onPickReference = useCallback(
    async (file?: File) => {
      if (!file) return;
      setAttaching(true);
      try {
        await attachReference(file);
      } finally {
        setAttaching(false);
      }
    },
    [attachReference],
  );

  return (
    <div className="border-t border-border p-2">
      <div className="relative rounded-lg border border-border bg-bg-2 transition-colors focus-within:border-accent">
        <div className="absolute left-1.5 top-1.5">
          <IconButton
            label={attaching ? "Attaching reference…" : "Attach reference video"}
            icon={<Paperclip size={12} aria-hidden />}
            size="sm"
            variant="ghost"
            isDisabled={busy || attaching}
            onClick={() => fileInputRef.current?.click()}
            className="grid h-7 w-7 place-items-center rounded-md text-fg-muted transition-colors hover:bg-bg-3 hover:text-fg disabled:opacity-40"
          />
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          className="hidden"
          aria-label="Attach reference video"
          onChange={(e) => {
            void onPickReference(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <ToolcraftTextAreaControl
          label="AI edit request"
          isLabelHidden
          value={text}
          onChange={setText}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder="Ask the AI to edit your video…"
          inputClassName="block w-full resize-none bg-transparent py-2 pl-9 pr-11 text-[13px] text-fg outline-none placeholder:text-fg-muted"
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
      {reference && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 px-1">
          <span
            className="inline-flex max-w-[9rem] items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] text-accent"
            title="Tagged as a reference — the director never cuts it as footage"
          >
            <Paperclip size={10} aria-hidden />
            <span className="truncate">{reference.name}</span>
          </span>
          <div
            role="group"
            aria-label="Reference intent"
            className="inline-flex overflow-hidden rounded-full border border-border"
          >
            {INTENT_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                title={option.hint}
                aria-pressed={referenceIntent === option.id}
                onClick={() => setReferenceIntent(option.id)}
                className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                  referenceIntent === option.id
                    ? "bg-accent text-accent-fg"
                    : "text-fg-muted hover:bg-bg-3 hover:text-fg"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={clearReference}
            className="rounded-full px-1.5 py-0.5 text-[10px] text-fg-muted transition-colors hover:bg-bg-3 hover:text-fg"
          >
            Remove
          </button>
        </div>
      )}
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
