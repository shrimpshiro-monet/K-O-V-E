import { useCallback } from "react";
import { useThemeStore, type ThemeMode } from "../stores/theme-store";

/**
 * Thin selector API over the theme store (the store itself owns DOM class
 * toggling, persistence, and system-scheme listening). Kept as a hook so
 * presentational components — the top bar toggle, Settings → Appearance —
 * share one entry point.
 */
export interface UseThemeResult {
  mode: ThemeMode;
  isDark: boolean;
  setMode: (mode: ThemeMode) => void;
  /** Cycles Dark → Light → System, matching the top-bar toggle. */
  cycleMode: () => void;
  /** Label for the *next* mode in the cycle (for tooltips/aria-labels). */
  nextModeLabel: string;
}

const NEXT_LABELS: Record<ThemeMode, string> = {
  dark: "System",
  light: "Dark",
  auto: "Light",
};

export function useTheme(): UseThemeResult {
  const mode = useThemeStore((s) => s.mode);
  const isDark = useThemeStore((s) => s.isDark);
  const setMode = useThemeStore((s) => s.setMode);
  const cycle = useThemeStore((s) => s.toggleTheme);

  const cycleMode = useCallback(() => cycle(), [cycle]);

  return {
    mode,
    isDark,
    setMode,
    cycleMode,
    nextModeLabel: NEXT_LABELS[mode],
  };
}
