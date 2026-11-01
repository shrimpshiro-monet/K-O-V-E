# Audio WebAssembly bindings

The FFT, beat-detection and WAV modules use AssemblyScript's managed typed-array
ABI. The exported functions receive numeric pointers, not JavaScript arrays.
`typed-array-bindings.ts` allocates real AssemblyScript arrays, pins them during
the call, copies inputs to linear memory, copies mutated output arrays back,
and unpins them afterwards. Data addresses come from exported accessors, and
views are recreated after allocations and calls because growing WASM memory can
detach an earlier view. The incremental runtime periodically collects unpinned
allocations; long WAV and RMS inputs are transferred in bounded chunks.

Build all three modules from the repository root:

```sh
pnpm build:wasm
```

The root, web, and desktop renderer production builds also build these modules
before bundling, so a clean checkout does not silently ship without them.

The builds require `--runtime incremental --exportRuntime`; old `--runtime
stub` binaries are rejected because their allocations cannot be reclaimed. The
loaders validate the required ABI and run small real round-trip self-tests
before enabling acceleration. Missing, stale, unsupported, or trapping WASM
continues through the JavaScript implementation. WASM downloads are bounded and
aborted on timeout. Invalid modules and runtime traps emit a console warning
rather than silently hiding an acceleration bug.
Input/output aliases or unsupported array shapes also use JavaScript when
independent copies would change the result, without disabling later WASM calls.
`isUsingWasm()` on each processor reports whether that instance is currently
accelerated; module-level availability alone does not prove a particular
operation succeeded.

The AssemblyScript hot loops use direct linear-memory loads and stores to avoid
per-sample managed-array overhead. These routines are internal ABI entry points:
call them through the adapters, which validate lengths and overlapping arrays,
pin the allocations, and chunk large transfers. Raw callers must provide the
same invariants; WASM linear-memory bounds alone do not protect individual
arrays from out-of-bounds writes. Median inputs containing NaN or negative zero
use JavaScript to preserve its stable sorting semantics.

`typed-array-bindings.test.ts` compiles the actual sources and compares WASM
with JavaScript for FFT, WAV PCM and beat analysis, including memory reuse,
chunk boundaries and fallback. The Chromium test
`apps/web/e2e/wasm-audio-safety.spec.ts` exercises the built modules in a real
browser. The WAV export browser test additionally checks that the editor's
actual encoder instance used WASM when a current build is available. Run
`pnpm build:wasm` before the browser tests; the direct module test is skipped if
the binaries are absent.
