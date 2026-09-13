import type { JSX } from "react";
import { ToolcraftText as Text } from "@kove-advanced/ui";
import { Loader2 } from "@/icons/lucide-compat";
import { useChatStore, type AnalysisProgress } from "../../../stores/chat-store";

export function AnalysisProgressCard(): JSX.Element | null {
  const progress = useChatStore((s) => s.analysisProgress);

  if (!progress) return null;

  const pct =
    progress.current != null && progress.total != null && progress.total > 0
      ? Math.round((progress.current / progress.total) * 100)
      : undefined;

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-2 p-2.5 text-[12px]">
      <div className="mb-1 flex items-center gap-1.5 font-medium text-fg">
        <Loader2 size={13} className="animate-spin text-fg-2" />
        Analyzing footage
      </div>
      <Text type="supporting" color="secondary" className="text-fg-2">
        {progress.message}
      </Text>
      {pct != null && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-bg-3">
          <div
            className="h-full rounded-full bg-accent transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}
