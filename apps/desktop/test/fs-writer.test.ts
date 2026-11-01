import { describe, it, expect, afterAll, vi } from "vitest";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import { FileWriterRegistry } from "../src/main/ipc/fs";

const target = path.join(tmpdir(), `kove-advanced-test-${Date.now()}.bin`);

describe("FileWriterRegistry", () => {
  afterAll(() => rm(target, { force: true }));

  it("writes positioned chunks then finalizes to disk", async () => {
    const reg = new FileWriterRegistry();
    const id = await reg.open(target);
    await reg.writeChunk(id, new TextEncoder().encode("world").buffer, 5);
    await reg.writeChunk(id, new TextEncoder().encode("hello").buffer, 0);
    await reg.close(id);
    expect(await readFile(target, "utf8")).toBe("helloworld");
  });

  it("writes Uint8Array chunks without requiring an ArrayBuffer copy", async () => {
    const reg = new FileWriterRegistry();
    const id = await reg.open(target);
    const chunk = new TextEncoder().encode("typed-array");
    await reg.writeChunk(id, chunk, 0);
    await reg.close(id);
    expect(await readFile(target, "utf8")).toBe("typed-array");
  });

  it("preserves an existing target when an export is aborted", async () => {
    await writeFile(target, "original user file");
    const reg = new FileWriterRegistry();
    const id = await reg.open(target);
    await reg.writeChunk(id, new TextEncoder().encode("partial").buffer, 0);
    expect(await readFile(target, "utf8")).toBe("original user file");
    await reg.abort(id);
    expect(await readFile(target, "utf8")).toBe("original user file");
  });

  it("removes a cancelled new export without creating the target", async () => {
    await rm(target, { force: true });
    const reg = new FileWriterRegistry();
    const id = await reg.open(target);
    await reg.writeChunk(id, new TextEncoder().encode("partial"), 0);
    await reg.abort(id);
    await expect(readFile(target)).rejects.toBeDefined();
  });

  it("preserves the existing destination when abort races a pending close", async () => {
    await writeFile(target, "original user file");
    const reg = new FileWriterRegistry();
    const id = await reg.open(target);
    await reg.writeChunk(id, new TextEncoder().encode("new video"), 0);
    const handles = (reg as unknown as { handles: Map<string, { handle: { close(): Promise<void> } }> }).handles;
    const handle = handles.get(id)!.handle;
    const actualClose = handle.close.bind(handle);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(handle, "close").mockImplementation(async () => { await gate; await actualClose(); });
    const closing = reg.close(id);
    const closeFailure = expect(closing).rejects.toMatchObject({ name: "AbortError" });
    const aborting = reg.abort(id);
    release();
    await Promise.all([closeFailure, aborting]);
    expect(await readFile(target, "utf8")).toBe("original user file");
  });

  it("supports truncation before committing the file", async () => {
    const reg = new FileWriterRegistry();
    const id = await reg.open(target);
    await reg.writeChunk(id, new TextEncoder().encode("abcdef"), 0);
    await reg.truncate(id, 3);
    await reg.close(id);
    expect(await readFile(target, "utf8")).toBe("abc");
  });

  it("retries partial writes instead of silently losing bytes", async () => {
    const reg = new FileWriterRegistry();
    const write = vi.fn(async (_bytes: Uint8Array, _offset: number, length: number, _position: number) => ({ bytesWritten: Math.min(2, length) }));
    const handles = (reg as unknown as { handles: Map<string, unknown> }).handles;
    handles.set("fake", { handle: { write }, targetPath: "", temporaryPath: "" });
    await reg.writeChunk("fake", new Uint8Array([1, 2, 3, 4, 5]), 10);
    expect(write.mock.calls.map((call) => call.slice(1))).toEqual([[0, 5, 10], [2, 3, 12], [4, 1, 14]]);
  });

  it("fails instead of looping forever when a write makes no progress", async () => {
    const reg = new FileWriterRegistry();
    const handles = (reg as unknown as { handles: Map<string, unknown> }).handles;
    handles.set("fake", { handle: { write: vi.fn().mockResolvedValue({ bytesWritten: 0 }) }, targetPath: "", temporaryPath: "" });
    await expect(reg.writeChunk("fake", new Uint8Array([1]), 0)).rejects.toThrow(/complete export/);
  });
});
