import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { projectManager } from "./project-manager";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  (window as any)["kove-advanced"] = {
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
  delete (window as any)["kove-advanced"];
});

const project: any = {
  id: "p1",
  name: "Demo",
  timeline: { duration: 1, tracks: [] },
};

describe("ProjectManager desktop fs", () => {
  it("saveProjectAs writes via the kove-advanced desktop fs and round-trips", async () => {
    const ok = await projectManager.saveProjectAs(project);
    expect(ok).toBe(true);
    expect((window as any)["kove-advanced"].fs.writeFile).toHaveBeenCalled();
    const loaded = await projectManager.openProject();
    expect(loaded?.name).toBe("Demo");
  });

  it("requests write permission before saving through a browser file handle", async () => {
    delete (window as any)["kove-advanced"];

    const write = vi.fn();
    const close = vi.fn();
    const createWritable = vi.fn(async () => ({
      write,
      close,
    }) as unknown as FileSystemWritableFileStream);
    const queryPermission = vi.fn(async () => "prompt" as PermissionState);
    const requestPermission = vi.fn(async () => "granted" as PermissionState);
    const handle = {
      createWritable,
      queryPermission,
      requestPermission,
    } as unknown as FileSystemFileHandle;
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: vi.fn(async () => handle),
    });

    try {
      const ok = await projectManager.saveProjectAs(project);

      expect(ok).toBe(true);
      expect(queryPermission).toHaveBeenCalledWith({ mode: "readwrite" });
      expect(requestPermission).toHaveBeenCalledWith({ mode: "readwrite" });
      expect(createWritable).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      delete (window as any).showSaveFilePicker;
    }
  });
});
