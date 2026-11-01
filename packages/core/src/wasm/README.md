# Audio WASM safety

The FFT, beat-detection, and WAV modules are currently compiled as raw
AssemblyScript WebAssembly exports. Their typed-array parameters are numeric
pointers, not JavaScript typed arrays. Until a binding layer marshals arrays
and copies output back correctly, the loaders reject that ABI and use the
existing JavaScript implementations. This sacrifices WASM acceleration but
prevents silent audio/analysis corruption.

`typed-array-bindings.test.ts` compiles the actual AssemblyScript sources and
checks the fallbacks. The Chromium test `e2e/wasm-audio-safety.spec.ts` runs
against the built binaries after `pnpm build:wasm`. Any future binding must also
manage AssemblyScript memory safely; the current `--runtime stub` allocations
are not garbage collected.
