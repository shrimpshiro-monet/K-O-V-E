import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useProjectStore } from "../stores/project-store";
import { useEnsureOpenProject } from "./useEnsureOpenProject";

const hasOpenProject = () => useProjectStore.getState().hasOpenProject;

describe("useEnsureOpenProject", () => {
  beforeEach(() => {
    // A fresh session: no project file has been opened yet.
    useProjectStore.setState({ hasOpenProject: false });
  });

  it("opens a project for an editing surface that has none", () => {
    expect(hasOpenProject()).toBe(false);
    renderHook(() => useEnsureOpenProject({ enabled: true, recoveryPending: false }));
    expect(hasOpenProject()).toBe(true);
  });

  it("leaves the project alone while the recovery prompt is pending", () => {
    const { rerender } = renderHook(
      ({ recoveryPending }: { recoveryPending: boolean }) =>
        useEnsureOpenProject({ enabled: true, recoveryPending }),
      { initialProps: { recoveryPending: true } },
    );

    expect(hasOpenProject()).toBe(false);

    // Dismissing the prompt lets the surface open a project.
    rerender({ recoveryPending: false });
    expect(hasOpenProject()).toBe(true);
  });

  it("does not open a project for surfaces that bring their own", () => {
    renderHook(() => useEnsureOpenProject({ enabled: false, recoveryPending: false }));
    expect(hasOpenProject()).toBe(false);
  });

  it("keeps the project already open", () => {
    useProjectStore.getState().createNewProject("Existing Project");
    const projectId = useProjectStore.getState().project.id;

    renderHook(() => useEnsureOpenProject({ enabled: true, recoveryPending: false }));

    expect(useProjectStore.getState().project.id).toBe(projectId);
    expect(useProjectStore.getState().project.name).toBe("Existing Project");
  });
});
