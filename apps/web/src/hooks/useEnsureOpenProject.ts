import { useEffect } from "react";
import { useProjectStore } from "../stores/project-store";

export interface EnsureOpenProjectOptions {
  /**
   * Whether the current surface is an editing surface that needs a project.
   * Share pages and the Motion surface (which opens its own project) pass false.
   */
  enabled: boolean;
  /**
   * True while the autosave recovery check is running or its dialog is up.
   * The recovery flow replaces the project wholesale, so nothing is opened
   * underneath it — a user who dismisses the prompt gets a project right after.
   */
  recoveryPending: boolean;
}

/**
 * Opens a scratch project when an editing surface has none.
 *
 * The editor shell renders before any project exists (fresh install, private
 * window, or a visitor who dismissed the recovery prompt). Importing media and
 * editing the timeline appear to work in that state, but every write that goes
 * through the store's action executor — the AI panels, the agent host, undo —
 * is refused, and the user only finds out after an expensive analysis has run.
 * Opening a project up front keeps the surface consistent and lets autosave
 * protect new work from the first edit.
 *
 * Mirrors what the Motion surface already does in `MotionCreatorApp`.
 */
export function useEnsureOpenProject({
  enabled,
  recoveryPending,
}: EnsureOpenProjectOptions): void {
  const hasOpenProject = useProjectStore((state) => state.hasOpenProject);
  const createNewProject = useProjectStore((state) => state.createNewProject);

  useEffect(() => {
    if (!enabled || recoveryPending || hasOpenProject) return;
    createNewProject();
  }, [createNewProject, enabled, hasOpenProject, recoveryPending]);
}
