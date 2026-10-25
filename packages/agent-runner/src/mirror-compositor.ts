import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import type { Project } from "@kove-advanced/core/types/project";
import type { VideoExportSettings } from "@kove-advanced/core/export/types";
import type { GrayImage } from "@kove-advanced/agent/director/mirror/ssim";
import { serializeProjectSnapshot } from "./project-io";

export interface MirrorSnapshot {
  readonly json: string;
  readonly hash: string;
  readonly mediaIds: readonly string[];
}

// Never expose mutable Buffer/Map instances from an immutable snapshot.
const snapshotMedia = new WeakMap<MirrorSnapshot, ReadonlyMap<string, Buffer>>();

/** Snapshot the *current* project and all referenced media. No live Blob
 * or mutable project objects cross into the browser. Hash includes media bytes. */
export async function createMirrorSnapshot(project: Project, mediaPaths: Readonly<Record<string, string>> = {}): Promise<MirrorSnapshot> {
  const json = serializeProjectSnapshot(project);
  const used = new Set(project.timeline.tracks.flatMap((track) => track.clips.map((clip) => clip.mediaId)));
  const media = new Map<string, Buffer>();
  const hash = createHash("sha256").update(json);
  for (const item of [...project.mediaLibrary.items].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!used.has(item.id)) continue;
    const path = mediaPaths[item.id];
    const bytes = path ? await readFile(path) : item.blob ? Buffer.from(await item.blob.arrayBuffer()) : null;
    if (!bytes?.length) throw new Error(`Missing renderable media for ${item.id}; provide mediaPaths[id] or a Blob`);
    const frozen = Buffer.from(bytes);
    media.set(item.id, frozen);
    hash.update(item.id).update(createHash("sha256").update(frozen).digest());
  }
  for (const id of used) {
    if (id.startsWith("compound:")) continue;
    if (!project.mediaLibrary.items.some((item) => item.id === id)) throw new Error(`Missing timeline media item ${id}`);
  }
  const snapshot: MirrorSnapshot = Object.freeze({
    json, hash: hash.digest("hex"), mediaIds: Object.freeze([...media.keys()]),
  });
  snapshotMedia.set(snapshot, media);
  return snapshot;
}

/** One Chromium page with the core compositor and ExportEngine.
 * close() is mandatory. */
export class MirrorCompositor {
  private browser?: Browser;
  private page?: Page;
  private server?: ViteDevServer;
  private active?: MirrorSnapshot;
  private exportHandle?: Awaited<ReturnType<typeof open>>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly executablePath?: string) {}

  private async start(): Promise<Page> {
    if (this.page) return this.page;
    // tsup's standalone CLI is CJS; its unbundled browser sources remain in
    // ../src. During Vitest/source execution the ESM module URL is authoritative.
    const root = typeof __dirname !== "undefined"
      ? resolve(__dirname, "../src")
      : fileURLToPath(new URL(".", import.meta.url));
    this.server = await createServer({ root, configFile: false, server: { host: "127.0.0.1", port: 0, strictPort: false }, logLevel: "error" });
    try {
      await this.server.listen();
      const address = this.server.httpServer?.address();
      if (!address || typeof address === "string") throw new Error("Vite did not open the mirror harness");
      this.browser = await chromium.launch({ headless: true, ...(this.executablePath ? { executablePath: this.executablePath } : {}) });
      this.page = await this.browser.newPage();
      this.page.on("pageerror", (error) => console.error("Mirror browser page error:", error));
      this.page.on("console", (message) => { if (message.type() === "error") console.error("Mirror browser console:", message.text()); });
      await this.page.exposeFunction("__koveWriteExportChunk", async (position: number, base64: string) => {
        const handle = this.exportHandle;
        if (!handle || !Number.isSafeInteger(position) || position < 0 || typeof base64 !== "string") {
          throw new Error("Timeline export writer is not ready");
        }
        const bytes = Buffer.from(base64, "base64");
        let written = 0;
        while (written < bytes.length) {
          const result = await handle.write(bytes, written, bytes.length - written, position + written);
          if (result.bytesWritten <= 0) throw new Error("Timeline export writer made no progress");
          written += result.bytesWritten;
        }
      });
      await this.page.exposeFunction("__koveTruncateExport", async (size: number) => {
        if (!this.exportHandle || !Number.isSafeInteger(size) || size < 0) {
          throw new Error("Timeline export writer is not ready");
        }
        await this.exportHandle.truncate(size);
      });
      await this.page.exposeFunction("__koveCloseExport", async () => {
        const handle = this.exportHandle;
        if (!handle) throw new Error("Timeline export writer is not ready");
        this.exportHandle = undefined;
        await handle.close();
      });
      await this.page.exposeFunction("__koveAbortExport", async () => {
        const handle = this.exportHandle;
        this.exportHandle = undefined;
        await handle?.close();
      });
      await this.page.exposeFunction("__koveExportProgress", (message: string) => {
        process.stdout.write(`[wow-eval] ${message}\n`);
      });
      await this.page.route("**/__mirror_media/**", async (route) => {
        const parts = new URL(route.request().url()).pathname.split("/");
        const id = decodeURIComponent(parts[parts.length - 1] ?? "");
        const bytes = this.active?.hash === parts[parts.length - 2] ? snapshotMedia.get(this.active)?.get(id) : undefined;
        if (!bytes) return route.fulfill({ status: 404, body: "Missing snapshot media" });
        return route.fulfill({ status: 200, body: bytes, contentType: "application/octet-stream" });
      });
      const response = await this.page.goto(`http://127.0.0.1:${address.port}/mirror-browser.html`);
      if (!response?.ok()) throw new Error(`Mirror harness HTTP ${response?.status()}`);
      await this.page.waitForFunction(() => typeof (window as Window & { koveMirrorRender?: unknown }).koveMirrorRender === "function", undefined, { timeout: 15_000 });
      return this.page;
    } catch (error) {
      await this.browser?.close();
      await this.server?.close();
      this.browser = undefined;
      this.server = undefined;
      this.page = undefined;
      throw error;
    }
  }

  sample(snapshot: MirrorSnapshot, timeSeconds: number): Promise<GrayImage> {
    const task = this.queue.then(async () => {
      const page = await this.start();
      this.active = snapshot;
      const data = await page.evaluate(async ({ json, hash, mediaIds, timeSeconds }) => {
        const render = (window as Window & { koveMirrorRender?: (s: { json: string; hash: string; mediaIds: readonly string[] }, t: number) => Promise<number[]> }).koveMirrorRender;
        if (!render) throw new Error("Mirror browser compositor was not loaded");
        return render({ json, hash, mediaIds }, timeSeconds);
      }, { json: snapshot.json, hash: snapshot.hash, mediaIds: snapshot.mediaIds, timeSeconds });
      if (!Array.isArray(data) || data.length !== 4096 || data.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
        throw new Error("Compositor did not return a checked 64x64 luma buffer");
      }
      return { width: 64, height: 64, data: Uint8Array.from(data) };
    });
    this.queue = task.catch(() => {});
    return task;
  }

  exportVideo(
    snapshot: MirrorSnapshot,
    outputPath: string,
    settings: Partial<VideoExportSettings>,
  ): Promise<{ readonly duration: number; readonly framesRendered: number; readonly fileSize: number }> {
    const task = this.queue.then(async () => {
      const page = await this.start();
      this.active = snapshot;
      await mkdir(dirname(outputPath), { recursive: true });
      const handle = await open(outputPath, "wx");
      this.exportHandle = handle;
      try {
        const result = await page.evaluate(async ({ json, hash, mediaIds, settings }) => {
          const render = (window as Window & {
            koveMirrorExport?: (
              snapshot: { json: string; hash: string; mediaIds: readonly string[] },
              settings: Partial<VideoExportSettings>,
            ) => Promise<{ duration: number; framesRendered: number; fileSize: number }>;
          }).koveMirrorExport;
          if (!render) throw new Error("Mirror browser export was not loaded");
          return render({ json, hash, mediaIds }, settings);
        }, { json: snapshot.json, hash: snapshot.hash, mediaIds: snapshot.mediaIds, settings });
        if (this.exportHandle) {
          this.exportHandle = undefined;
          await handle.close();
        }
        return result;
      } catch (error) {
        if (this.exportHandle) {
          this.exportHandle = undefined;
          await handle.close();
        }
        await rm(outputPath, { force: true });
        throw error;
      }
    });
    this.queue = task.catch(() => {});
    return task;
  }

  async close(): Promise<void> {
    await this.queue;
    this.active = undefined;
    if (this.exportHandle) {
      await this.exportHandle.close();
      this.exportHandle = undefined;
    }
    await this.browser?.close();
    await this.server?.close();
    this.browser = undefined;
    this.server = undefined;
    this.page = undefined;
  }
}
