import type { JSX } from "react";
import { useState } from "react";
import { ToolcraftButton as Button } from "@kove-advanced/ui";
import { Sparkles, ChevronDown, ChevronUp, MessageCircle } from "@/icons/lucide-compat";
import type { PromptExpansionData } from "../../../stores/chat-store";

function scoreColor(score: number): string {
  if (score >= 0.8) return "text-status-success";
  if (score >= 0.5) return "text-status-warning";
  return "text-status-error";
}

function scoreLabel(score: number): string {
  if (score >= 0.8) return "Detailed";
  if (score >= 0.5) return "Partial";
  return "Vague";
}

export function PromptExpansionCard({
  expansion,
  onUseExpanded,
  onAnswerQuestions,
}: {
  expansion: PromptExpansionData;
  onUseExpanded: (prompt: string) => void;
  onAnswerQuestions: (answers: string) => void;
}): JSX.Element {
  const [showRationale, setShowRationale] = useState(false);
  const [answers, setAnswers] = useState("");
  const hasQuestions = expansion.questions && expansion.questions.length > 0;

  return (
    <div className="rounded-lg border border-border-subtle bg-surface-secondary p-3 space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium text-fg-1">
        <Sparkles size={14} className="text-accent" />
        Director's Brief
      </div>

      <p className="text-sm text-fg-2 leading-relaxed">{expansion.expandedPrompt}</p>

      <div className="flex items-center gap-3 text-xs text-fg-muted">
        <span>
          Completeness:{" "}
          <span className={scoreColor(expansion.completenessScore)}>
            {scoreLabel(expansion.completenessScore)} ({Math.round(expansion.completenessScore * 100)}%)
          </span>
        </span>
        {expansion.detectedGaps.length > 0 && (
          <span>Missing: {expansion.detectedGaps.join(", ")}</span>
        )}
      </div>

      {hasQuestions && (
        <div className="mt-2 space-y-2">
          <div className="flex items-center gap-2 text-xs font-medium text-fg-1">
            <MessageCircle size={12} />
            Clarifying Questions
          </div>
          <ul className="space-y-1">
            {expansion.questions!.map((q, i) => (
              <li key={i} className="text-xs text-fg-2 pl-3 border-l-2 border-accent">
                {q}
              </li>
            ))}
          </ul>
          <div className="flex gap-2 mt-2">
            <input
              type="text"
              value={answers}
              onChange={(e) => setAnswers(e.target.value)}
              placeholder="Type your answers..."
              className="flex-1 text-xs bg-surface-primary border border-border-subtle rounded px-2 py-1 text-fg-1 placeholder:text-fg-muted"
              onKeyDown={(e) => {
                if (e.key === "Enter" && answers.trim()) {
                  onAnswerQuestions(answers.trim());
                  setAnswers("");
                }
              }}
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                if (answers.trim()) {
                  onAnswerQuestions(answers.trim());
                  setAnswers("");
                }
              }}
            >
              Send
            </Button>
          </div>
        </div>
      )}

      {!hasQuestions && expansion.completenessScore < 0.8 && (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => onUseExpanded(expansion.expandedPrompt)}
          className="mt-1"
        >
          Use Expanded Prompt
        </Button>
      )}

      <button
        onClick={() => setShowRationale(!showRationale)}
        className="flex items-center gap-1 text-xs text-fg-muted hover:text-fg-2 transition-colors"
      >
        {showRationale ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
        Rationale
      </button>
      {showRationale && (
        <p className="text-xs text-fg-muted italic">{expansion.rationale}</p>
      )}
    </div>
  );
}
