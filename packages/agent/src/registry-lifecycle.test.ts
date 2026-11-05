import { describe, it, expect, vi } from "vitest";
import { HeadlessHost } from "./headless-host";
import { executeTool } from "./executor";
import { getTool } from "./registry";
import { makeEmptyProject } from "./test-fixtures";
import type {
  EditingHost,
  ProjectRef,
  ImportedMediaRef,
  CreateProjectOptions,
} from "./host";

describe("project/media lifecycle tools", () => {
  it("registers the new lifecycle + ingest tools", () => {
    for (const name of [
      "create_project",
      "open_project",
      "list_projects",
      "save_project",
      "import_media_from_url",
    ]) {
      expect(getTool(name), name).toBeDefined();
    }
  });

  it("create_project / import_media_from_url need no open project to dispatch", () => {
    expect(getTool("create_project")?.readOnly).toBe(false);
    expect(getTool("list_projects")?.readOnly).toBe(true);
  });

  it("gracefully reports UNSUPPORTED on a host without the optional methods", async () => {
    const host = new HeadlessHost(makeEmptyProject());
    const created = await executeTool("create_project", { name: "X" }, host);
    expect(created.ok).toBe(false);
    expect(created.error?.code).toBe("UNSUPPORTED");

    const imported = await executeTool(
      "import_media_from_url",
      { url: "https://example.com/a.jpg" },
      host,
    );
    expect(imported.ok).toBe(false);
    expect(imported.error?.code).toBe("UNSUPPORTED");
  });

  it("create_project calls host.createProject and returns the ref", async () => {
    let received: CreateProjectOptions | undefined;
    const base = new HeadlessHost(makeEmptyProject());
    const host: EditingHost = Object.assign(base, {
      async createProject(options: CreateProjectOptions): Promise<ProjectRef> {
        received = options;
        return { id: "p1", name: options.name ?? "Untitled", width: options.width, height: options.height };
      },
    });

    const res = await executeTool(
      "create_project",
      { name: "Promo", width: 1920, height: 1080, frameRate: 30 },
      host,
    );
    expect(res.ok).toBe(true);
    expect(received).toEqual({ name: "Promo", width: 1920, height: 1080, frameRate: 30 });
    expect((res.data as ProjectRef).id).toBe("p1");
  });

  it("create_text_clip routes through the engine-aware host method when available", async () => {
    let received: unknown;
    const base = new HeadlessHost(makeEmptyProject());
    const host: EditingHost = Object.assign(base, {
      async createTextOverlay(opts: unknown) {
        received = opts;
        return { id: "tx1", trackId: "tt" };
      },
    });

    const res = await executeTool(
      "create_text_clip",
      { clip: { text: "Hello", startTime: 1, duration: 2 } },
      host,
    );
    expect(res.ok).toBe(true);
    expect(received).toEqual({ text: "Hello", startSec: 1, durationSec: 2, trackId: undefined, style: undefined });
    expect((res.data as { id: string }).id).toBe("tx1");
  });

  it("creates multiple text overlays in one call and preserves timing and animation", async () => {
    const received: unknown[] = [];
    const base = new HeadlessHost(makeEmptyProject());
    const host: EditingHost = Object.assign(base, {
      async createTextOverlay(opts: unknown) {
        received.push(opts);
        return { id: `tx${received.length}`, trackId: "tt" };
      },
    });

    const res = await executeTool("create_text_clips", {
      clips: [
        { text: "Hook", startTime: 0, duration: 1.2, animation: "pop", position: { x: 0.5, y: 0.7 } },
        { text: "Payoff", startTime: 4, duration: 1.5, animation: "fade" },
      ],
    }, host);

    expect(res.ok).toBe(true);
    expect(received).toEqual([
      { text: "Hook", startSec: 0, durationSec: 1.2, trackId: undefined, style: undefined, position: { x: 0.5, y: 0.7 }, animation: "pop" },
      { text: "Payoff", startSec: 4, durationSec: 1.5, trackId: undefined, style: undefined, animation: "fade" },
    ]);
    expect((res.data as { created: { id: string }[] }).created.map((item) => item.id)).toEqual(["tx1", "tx2"]);
  });

  it("rejects an invalid text batch before creating any overlays", async () => {
    const createTextOverlay = vi.fn(async () => ({ id: "tx1", trackId: "tt" }));
    const base = new HeadlessHost(makeEmptyProject());
    const host: EditingHost = Object.assign(base, { createTextOverlay });

    const res = await executeTool("create_text_clips", {
      clips: [
        { text: "Valid", startTime: 0, duration: 1 },
        { text: "Invalid", startTime: 1, duration: 0 },
      ],
    }, host);

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INVALID_PARAMS");
    expect(createTextOverlay).not.toHaveBeenCalled();
  });

  it("reports partial text-batch failures and any rollback failures", async () => {
    let createCount = 0;
    const base = new HeadlessHost(makeEmptyProject());
    const host: EditingHost = Object.assign(base, {
      async createTextOverlay() {
        createCount += 1;
        if (createCount === 2) throw new Error("renderer unavailable");
        return { id: "tx1", trackId: "tt" };
      },
      async removeOverlay() {
        throw new Error("cleanup unavailable");
      },
    });

    const res = await executeTool("create_text_clips", {
      clips: [
        { text: "First", startTime: 0, duration: 1 },
        { text: "Second", startTime: 1, duration: 1 },
      ],
    }, host);

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("TEXT_BATCH_FAILED");
    expect(res.summary).toContain("renderer unavailable");
    expect(res.summary).toContain("cleanup unavailable");
    expect(res.data).toEqual({
      created: [{ id: "tx1", text: "First" }],
      cleanupFailures: [{ id: "tx1", message: "cleanup unavailable" }],
    });
  });

  it("create_text_clip falls back to the raw action on a host without the engine method", async () => {
    const host = new HeadlessHost(makeEmptyProject());
    const res = await executeTool(
      "create_text_clip",
      {
        clip: {
          id: "tx-fallback",
          trackId: "tt",
          startTime: 0,
          duration: 1,
          text: "Hi",
          style: {},
          transform: { position: { x: 0.5, y: 0.5 }, scale: { x: 1, y: 1 }, anchor: { x: 0.5, y: 0.5 }, rotation: 0, opacity: 1 },
          keyframes: [],
        },
      },
      host,
    );
    expect(res.ok).toBe(true);
  });

  it("registers the full overlay add/edit/remove tool set", () => {
    for (const name of [
      "create_text_clip", "update_text_clip", "remove_text_clip",
      "create_shape_clip", "update_shape_clip", "remove_shape_clip",
      "create_sticker_clip", "update_sticker_clip", "remove_sticker_clip",
      "create_svg_clip", "update_svg_clip", "remove_svg_clip",
      "update_subtitle",
    ]) {
      expect(getTool(name), name).toBeDefined();
    }
  });

  it("flags every overlay remove tool as destructive", () => {
    for (const name of ["remove_text_clip", "remove_shape_clip", "remove_sticker_clip", "remove_svg_clip"]) {
      expect(getTool(name)?.destructive, name).toBe(true);
    }
  });

  it("update_text_clip routes content/style/animation to the engine-aware host method", async () => {
    let received: { id: string; opts: Record<string, unknown> } | undefined;
    const base = new HeadlessHost(makeEmptyProject());
    const host: EditingHost = Object.assign(base, {
      async updateTextOverlay(id: string, opts: Record<string, unknown>) {
        received = { id, opts };
        return { id, trackId: "tt" };
      },
    });
    const res = await executeTool(
      "update_text_clip",
      {
        clipId: "tx1",
        updates: {
          text: "New",
          animation: { preset: "fade", inDuration: 0.8, outDuration: 0.4 },
        },
      },
      host,
    );
    expect(res.ok).toBe(true);
    expect(received?.id).toBe("tx1");
    expect(received?.opts.text).toBe("New");
    expect(received?.opts.animation).toBe("fade");
    expect(received?.opts.animationInSec).toBe(0.8);
    expect(received?.opts.animationOutSec).toBe(0.4);
  });

  it("overlay update tools reject non-object updates", async () => {
    const host = new HeadlessHost(makeEmptyProject());
    const res = await executeTool(
      "update_shape_clip",
      { clipId: "shape-1", updates: null },
      host,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INVALID_PARAMS");
  });

  it("remove_text_clip routes through host.removeOverlay with the right kind", async () => {
    let received: { kind: string; id: string } | undefined;
    const base = new HeadlessHost(makeEmptyProject());
    const host: EditingHost = Object.assign(base, {
      async removeOverlay(kind: string, id: string) {
        received = { kind, id };
        return true;
      },
    });
    const res = await executeTool("remove_text_clip", { clipId: "tx1" }, host);
    expect(res.ok).toBe(true);
    expect(received).toEqual({ kind: "text", id: "tx1" });
  });

  it("create_sticker_clip routes through host.createStickerOverlay", async () => {
    let received: Record<string, unknown> | undefined;
    const base = new HeadlessHost(makeEmptyProject());
    const host: EditingHost = Object.assign(base, {
      async createStickerOverlay(opts: unknown) {
        received = opts as Record<string, unknown>;
        return { id: "st1", trackId: "gt" };
      },
    });
    const res = await executeTool(
      "create_sticker_clip",
      { clip: { emoji: "🔥", startTime: 0, duration: 2 } },
      host,
    );
    expect(res.ok).toBe(true);
    expect(received?.emoji).toBe("🔥");
    expect((res.data as { id: string }).id).toBe("st1");
  });

  it("create_svg_clip requires svg markup and routes through the host method", async () => {
    const base = new HeadlessHost(makeEmptyProject());
    const missing = await executeTool("create_svg_clip", { clip: { startTime: 0 } }, base);
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe("INVALID_PARAMS");

    let received: Record<string, unknown> | undefined;
    const host: EditingHost = Object.assign(new HeadlessHost(makeEmptyProject()), {
      async createSvgOverlay(opts: unknown) {
        received = opts as Record<string, unknown>;
        return { id: "sv1", trackId: "gt" };
      },
    });
    const res = await executeTool(
      "create_svg_clip",
      { clip: { svg: "<svg/>", startTime: 1, duration: 3 } },
      host,
    );
    expect(res.ok).toBe(true);
    expect(received?.svg).toBe("<svg/>");
  });

  it("import_media_from_url requires an open project before fetching", async () => {
    let fetched = false;
    const base = new HeadlessHost(makeEmptyProject());
    const host: EditingHost = Object.assign(base, {
      requireOpenProject(): void {
        throw new Error("No project is open");
      },
      async importMediaFromUrl(): Promise<ImportedMediaRef> {
        fetched = true;
        return { mediaId: "m1", name: "x", type: "image", durationSec: 0 };
      },
    });

    const res = await executeTool(
      "import_media_from_url",
      { url: "https://example.com/a.jpg" },
      host,
    );
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("No project is open");
    expect(fetched).toBe(false);
  });
});
