import { create } from "zustand";
import { persist } from "zustand/middleware";

export type AmbientBackdropMode = "vivid" | "subtle" | "off";

interface AmbientBackdropState {
  mode: AmbientBackdropMode;
  setMode: (mode: AmbientBackdropMode) => void;
}

/**
 * User preference for the floral ambient layer (Settings → Appearance →
 * Ambient Backdrop). "off" renders flat theme colors with zero image cost.
 * Mirrored onto <html data-backdrop> so glass/ambient CSS can react.
 */
const applyMode = (mode: AmbientBackdropMode): void => {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.backdrop = mode;
};

export const useAmbientBackdropStore = create<AmbientBackdropState>()(
  persist(
    (set) => ({
      mode: "subtle",
      setMode: (mode) => {
        set({ mode });
        applyMode(mode);
      },
    }),
    {
      name: "monet-ambient-backdrop",
      onRehydrateStorage: () => (state) => {
        if (state) applyMode(state.mode);
      },
    },
  ),
);
