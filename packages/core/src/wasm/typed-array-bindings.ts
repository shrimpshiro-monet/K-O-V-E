/**
 * AssemblyScript's raw WebAssembly exports use numeric pointers, not JS typed
 * arrays. Calling them with a Float32Array silently passes an invalid pointer
 * and leaves output arrays unchanged. Only enable the accelerated path when a
 * binding layer actually exposes typed arrays; otherwise use the JS fallback.
 */
export function hasTypedArrayBindings(exports: WebAssembly.Exports): boolean {
  const allocate = exports.allocateF32;
  if (typeof allocate !== "function") return false;
  try {
    return allocate(0) instanceof Float32Array;
  } catch {
    return false;
  }
}
