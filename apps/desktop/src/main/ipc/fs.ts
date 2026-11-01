import { dialog, shell, BrowserWindow } from "electron";
import { promises as fs, renameSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";

interface PendingFileWrite {
  handle: FileHandle;
  targetPath: string;
  temporaryPath: string;
  canceled?: boolean;
  closePromise?: Promise<void>;
}

export class FileWriterRegistry {
  private handles = new Map<string, PendingFileWrite>();

  async open(targetPath: string): Promise<string> {
    const id = randomUUID();
    // Keep the partial file beside the destination so rename is atomic and
    // cancellation never truncates or deletes an existing user file.
    const temporaryPath = path.join(path.dirname(targetPath), `.kove-export-${id}.partial`);
    const handle = await fs.open(temporaryPath, "wx");
    this.handles.set(id, { handle, targetPath, temporaryPath });
    return id;
  }

  async writeChunk(id: string, data: ArrayBuffer | Uint8Array, position: number): Promise<void> {
    const entry = this.handles.get(id);
    if (!entry) throw new Error(`unknown write handle ${id}`);
    if (entry.canceled || entry.closePromise) throw new Error("Export file is closing or cancelled");
    if (!Number.isSafeInteger(position) || position < 0) throw new TypeError("Invalid file write position");
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await entry.handle.write(bytes, offset, bytes.byteLength - offset, position + offset);
      if (result.bytesWritten <= 0) throw new Error("Could not write the complete export file");
      offset += result.bytesWritten;
    }
  }

  async truncate(id: string, size: number): Promise<void> {
    const entry = this.handles.get(id);
    if (!entry) throw new Error(`unknown write handle ${id}`);
    if (entry.canceled || entry.closePromise) throw new Error("Export file is closing or cancelled");
    if (!Number.isSafeInteger(size) || size < 0) throw new TypeError("Invalid file size");
    await entry.handle.truncate(size);
  }

  async close(id: string): Promise<void> {
    const entry = this.handles.get(id);
    if (!entry) return;
    if (entry.closePromise) return entry.closePromise;
    entry.closePromise = (async () => {
      try {
        await entry.handle.close();
        if (entry.canceled) {
          const error = new Error("File export was cancelled");
          error.name = "AbortError";
          throw error;
        }
        // Publication is a single synchronous metadata operation, so an abort
        // cannot interleave between the cancellation check and the rename.
        renameSync(entry.temporaryPath, entry.targetPath);
      } catch (error) {
        await fs.rm(entry.temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      } finally {
        this.handles.delete(id);
      }
    })();
    return entry.closePromise;
  }

  async abort(id: string): Promise<void> {
    const entry = this.handles.get(id);
    if (!entry) return;
    entry.canceled = true;
    if (entry.closePromise) {
      await entry.closePromise.catch(() => undefined);
      return;
    }
    this.handles.delete(id);
    try {
      await entry.handle.close();
    } finally {
      await fs.rm(entry.temporaryPath, { force: true });
    }
  }
}

export const fileWriters = new FileWriterRegistry();

export async function showSaveDialog(args: {
  defaultPath: string;
  filters: { name: string; extensions: string[] }[];
}): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? undefined;
  const res = await dialog.showSaveDialog(win!, {
    defaultPath: args.defaultPath,
    filters: args.filters,
  });
  return res.canceled || !res.filePath ? null : res.filePath;
}

export async function showOpenDialog(args: {
  filters: { name: string; extensions: string[] }[];
}): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? undefined;
  const res = await dialog.showOpenDialog(win!, {
    filters: args.filters,
    properties: ["openFile"],
  });
  return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
}

export async function readTextFile(args: { path: string }): Promise<string> {
  return fs.readFile(args.path, "utf8");
}

export async function readFileBytes(args: { path: string }): Promise<ArrayBuffer> {
  const buf = await fs.readFile(args.path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

export async function writeTextFile(args: { path: string; data: string }): Promise<void> {
  await fs.writeFile(args.path, args.data, "utf8");
}

export async function revealInFolder(args: { path: string }): Promise<void> {
  shell.showItemInFolder(args.path);
}

export async function tempFilePath(args: { ext: string }): Promise<string> {
  const safeExt = args.ext.replace(/[^a-zA-Z0-9]/g, "") || "bin";
  return path.join(os.tmpdir(), `kove-advanced-mat-${randomUUID()}.${safeExt}`);
}
