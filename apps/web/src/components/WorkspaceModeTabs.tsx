import type { JSX } from "react";

export type WorkspaceMode = "video" | "motion";

const MODES: Array<{
  id: WorkspaceMode;
  label: string;
}> = [
  { id: "video", label: "Video Editor" },
  { id: "motion", label: "Motion Design" },
];

export function WorkspaceModeTabs({
  activeMode,
  onSelectMode,
  ariaLabel = "Editor workspaces",
  className = "",
  accessibleLabels,
}: {
  activeMode: WorkspaceMode;
  onSelectMode: (mode: WorkspaceMode) => void;
  ariaLabel?: string;
  className?: string;
  accessibleLabels?: Partial<Record<WorkspaceMode, string>>;
}): JSX.Element {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`inline-flex items-center gap-0 rounded-full bg-[var(--surface-sunken)] p-[3px] border border-line ${className}`}
    >
      {MODES.map((mode) => {
        const isActive = activeMode === mode.id;
        return (
          <button
            key={mode.id}
            type="button"
            role="tab"
            aria-label={accessibleLabels?.[mode.id]}
            aria-selected={isActive}
            onClick={() => onSelectMode(mode.id)}
            className={`rounded-full px-4 py-[6px] text-[13px] transition-colors duration-fast ${
              isActive
                ? "glass-raised text-accent font-semibold border-[var(--border-glow)]"
                : "bg-transparent text-fg-3 font-medium hover:text-fg-2"
            }`}
          >
            {mode.label}
          </button>
        );
      })}
    </div>
  );
}
