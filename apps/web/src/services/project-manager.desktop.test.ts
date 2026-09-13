import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { projectManager } from "./project-manager";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  (window as any).kove-advanced = {
    platform: "desktop",
    fs: {
      showSaveDialog: vi.fn(async () => "/tmp/proj.oreel"),
      showOpenDialog: vi.fn(async () => "/tmp/proj.oreel"),
      writeFile: vi.fn(async (p: string, d: string) => {
        store.set(p, d);
      }),
      readFile: vi.fn(async (p: string) => store.get(p) ?? ""),
    },
  };
});

afterEach(() => {
  delete (window as any).kove-advanced;
});

const project: any = {
  id: "p1",
  name: "Demo",
  timeline: { duration: 1, tracks: [] },
};

describe("ProjectManager desktop fs", () => {
  it("saveProjectAs writes via window["kove-advanced"].fs and round-trips", async () => {
    const ok = await projectManager.saveProjectAs(project);
    expect(ok).toBe(true);
    expect((window as any).kove-advanced.fs.writeFile).toHaveBeenCalled();
    const loaded = await projectManager.openProject();
    expect(loaded?.name).toBe("Demo");
  });
});
