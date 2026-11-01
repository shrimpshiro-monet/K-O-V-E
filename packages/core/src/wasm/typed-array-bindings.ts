/**
 * AssemblyScript's raw WASM ABI passes typed arrays as managed pointers. This
 * bridge allocates and pins real AssemblyScript arrays, copies JS inputs into
 * linear memory, copies changed outputs back, and releases the GC roots.
 *
 * Data addresses come from the compiled module's typed accessors, rather than
 * assuming the compiler's object-header layout. Views are recreated after every
 * allocation/call because WebAssembly memory growth detaches old buffers.
 */
export type BoundArray = Float32Array | Int32Array | Uint8Array;
export interface ArrayArgument {
  readonly array: BoundArray;
  readonly copyBack: boolean;
}
export type BindingArgument = number | ArrayArgument;

export const inputArray = (array: BoundArray): ArrayArgument => ({ array, copyBack: false });
export const outputArray = (array: BoundArray): ArrayArgument => ({ array, copyBack: true });

/** A missing or stalled optional module must not keep an export waiting. */
export async function fetchAudioWasm(url: URL, timeoutMs = 2_500): Promise<ArrayBuffer | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  try {
    const download = (async () => {
      const response = await fetch(url, { signal: controller.signal });
      return response.ok ? await response.arrayBuffer() : null;
    })();
    return await Promise.race([download, timeout]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Aliased inputs/outputs can have order-dependent JS semantics; do not copy them independently. */
export function arraysOverlap(a: BoundArray, b: BoundArray): boolean {
  return a.buffer === b.buffer &&
    a.byteOffset < b.byteOffset + b.byteLength && b.byteOffset < a.byteOffset + a.byteLength;
}

const COLLECT_AFTER_BYTES = 8 * 1024 * 1024;
type WasmFunction = (...args: number[]) => number | undefined;

export class TypedArrayBindings {
  readonly memory: WebAssembly.Memory;
  private readonly functions = new Map<string, WasmFunction>();
  private bytesSinceCollection = 0;

  constructor(exports: WebAssembly.Exports, requiredFunctions: readonly string[]) {
    if (!(exports.memory instanceof WebAssembly.Memory)) {
      throw new Error("The audio WASM module does not export its memory");
    }
    this.memory = exports.memory;
    // Old --runtime stub binaries do not provide pin/unpin/collect and must
    // remain on the safe JS path until the modules are rebuilt.
    for (const name of new Set([
      "__pin", "__unpin", "__collect", "allocateF32", "dataF32", ...requiredFunctions,
    ])) {
      const value = exports[name];
      if (typeof value !== "function") throw new Error(`Missing audio WASM export: ${name}`);
      this.functions.set(name, value as WasmFunction);
    }
  }

  call(name: string, args: readonly BindingArgument[] = []): number | undefined {
    const pinned: Array<{ pointer: number; argument: ArrayArgument; dataFunction: string }> = [];
    const rawArgs: number[] = [];
    let allocatedBytes = 0;
    try {
      for (const argument of args) {
        if (typeof argument === "number") {
          rawArgs.push(argument);
          continue;
        }
        const { array } = argument;
        // AssemblyScript lengths are signed i32; reject values that cannot be
        // represented rather than wrapping into a small or negative allocation.
        if (array.length > 0x7fffffff || array.byteLength > 0x7fffffff) {
          throw new RangeError("Audio WASM array exceeds the supported size");
        }
        const suffix = array instanceof Float32Array ? "F32" : array instanceof Int32Array ? "I32" : "U8";
        const pointer = this.numberResult(`allocate${suffix}`, [array.length]) >>> 0;
        if (!pointer) throw new Error("Audio WASM array allocation failed");
        this.function("__pin")(pointer);
        pinned.push({ pointer, argument, dataFunction: `data${suffix}` });
        rawArgs.push(pointer);
        allocatedBytes += array.byteLength;
      }

      // Allocate/pin every argument before creating any view: an allocation can
      // grow memory and invalidate a view created for an earlier argument.
      for (const entry of pinned) this.copy(entry, "in");
      const result = this.function(name)(...rawArgs);
      for (const entry of pinned) if (entry.argument.copyBack) this.copy(entry, "out");
      return result;
    } finally {
      for (let index = pinned.length - 1; index >= 0; index--) {
        try { this.function("__unpin")(pinned[index].pointer); } catch { /* release the rest */ }
      }
      this.bytesSinceCollection += allocatedBytes;
      if (this.bytesSinceCollection >= COLLECT_AFTER_BYTES) {
        this.bytesSinceCollection = 0;
        // The incremental runtime can reclaim unpinned argument arrays and
        // temporaries; WASM memory is reused even though it cannot shrink.
        this.function("__collect")();
      }
    }
  }

  private function(name: string): WasmFunction {
    const result = this.functions.get(name);
    if (!result) throw new Error(`Missing audio WASM binding: ${name}`);
    return result;
  }

  private numberResult(name: string, args: number[]): number {
    const result = this.function(name)(...args);
    if (typeof result !== "number") throw new Error(`Invalid audio WASM result from ${name}`);
    return result;
  }

  private copy(
    entry: { pointer: number; argument: ArrayArgument; dataFunction: string },
    direction: "in" | "out",
  ): void {
    const { array } = entry.argument;
    const address = this.numberResult(entry.dataFunction, [entry.pointer]) >>> 0;
    const memory = this.memory.buffer;
    if (address + array.byteLength > memory.byteLength) {
      throw new RangeError("Audio WASM returned an invalid array address");
    }
    if (array instanceof Float32Array) {
      const view = new Float32Array(memory, address, array.length);
      if (direction === "in") view.set(array); else array.set(view);
    } else if (array instanceof Int32Array) {
      const view = new Int32Array(memory, address, array.length);
      if (direction === "in") view.set(array); else array.set(view);
    } else {
      const view = new Uint8Array(memory, address, array.length);
      if (direction === "in") view.set(array); else array.set(view);
    }
  }
}
