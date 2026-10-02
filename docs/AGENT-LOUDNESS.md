# Loudness measurement (ITU-R BS.1770-4 / EBU R128)

Status: **implemented and tested against synthetic EBU cases and an ffmpeg oracle. Not a certified
implementation.** Read "What was NOT validated" before relying on it for delivery compliance.

## What exists

| Piece | Where |
|---|---|
| Meter (K-weighting, gating, LRA, true peak) | `packages/core/src/audio/loudness/` |
| `AudioEngine.measureLoudness` (was a placeholder) | `packages/core/src/audio/audio-engine.ts` |
| Agent tool `measure_loudness` (strict, read-only, audio domain) | `packages/agent/src/tools-audio-analysis.ts` |
| Host hook `EditingHost.loadAudioSamples`, feature flag `analyzeAudio` | `host.ts`, `headless-host.ts`, `apps/web/src/services/agent/live-host.ts` |

The old placeholder computed `rmsDb - 0.691` on channel 0, hard-coded `range: 10`, and reported a raw sample
peak as true peak. All three are gone. Unmeasurable values are `-Infinity` (engine) / `null` (tool), never estimated.

## Decision: native TypeScript, not libebur128/WASM

- `ebur128-wasm`: Apache-2.0, bundler-dependent, last release 2022. `libebur128`: MIT, native; would need a WASM build step.
- The algorithm is small, core already runs in node and the browser, and a TS meter is testable in plain vitest with no WASM loader.
  Cost: we own the correctness, which is why the validation below exists.

## Algorithm

- K-weighting: two biquads (shelf + RLB high-pass), float64 TDF2, coefficients derived per sample rate.
- Channel weights: L/R/C/mono 1.0, Ls/Rs 1.41 (+1.5 dB), LFE excluded. Default layout by channel count
  (1 M, 2 LR, 3 LRC, 4 LRLsRs, 5 LRCLsRs, 6 LRCLFELsRs). More than 6 channels: the first 6 are measured and the tool warns.
- Integrated: 400 ms blocks, 75 % overlap, absolute gate −70 LUFS, relative gate −10 LU, incomplete trailing block discarded.
- LRA (Tech 3342): 3 s short-term windows at 10 Hz, absolute gate −70 LUFS, relative gate **−20 LU**, P95 − P10.
- Momentary / short-term maxima tracked on a ~1 ms grid (a 100 ms grid cannot pass Tech 3341 case 13).
- True peak: 4× polyphase oversampling (Kaiser, 12 taps/phase), max over channels.
- Speed in the sandbox: ~109× realtime (stereo 48 kHz), about 33 s per hour of audio.

## What was validated

1. **EBU Tech 3341 / 3342 cases regenerated from the spec** (48 kHz): 3341 cases 1–6, 9–14 (all iterations), 15–23, LFE exclusion;
   3342 cases 1–4 and repeated-signal invariance. EBU tolerances (±0.1 LU, +0.2/−0.4 dB TP, ±1 LU LRA). 117 assertions.
2. **Calibration:** 1 kHz in-phase stereo sine at −18 dBFS peak reads −18.0 LUFS.
3. **Analytic tests** pinning what the synthetic EBU cases do not: relative-gate −8 vs −10, absolute gate −50 vs −70 and LRA
   percentiles 20/80 all *survived* the EBU cases alone. They are now caught.
4. **Mutation check:** 10 deliberate mutants (gate levels, percentiles, weights, window length, …); all caught.
5. **ffmpeg `ebur128` oracle** (ffmpeg 7.0.2; `packages/core/scripts/loudness-oracle.py` → `oracle.golden.json`, committed):
   modulated multi-tone signal with an inter-sample click at 44.1/48/96 kHz stereo, 48 kHz mono and 48 kHz 5.1.
   Tolerances: integrated 0.06 LU, LRA 0.15 LU, true peak 0.15 dB. Also agrees with pyloudnorm on integrated loudness (mono/stereo) within 0.06 LU.
   - ffmpeg values: I = −14.204 / −14.207 / −14.229 (stereo 44.1/48/96), −17.218 (mono), −9.568 (5.1); LRA ≈ 16.7.
   - **The tolerance was set by the oracles' disagreement with each other** (ffmpeg vs pyloudnorm ≈ 0.04 LU; ffmpeg varies
     ≈ 0.025 LU across sample rates because it resamples internally), not tuned to this meter's output.
6. `AudioEngine.measureLoudness` and the agent tool are tested end to end (tool: 15 tests; engine: 4).

## What was NOT validated

- The authentic-programme EBU cases (3341 #7/#8, 3342 #5/#6): the binary reference WAVs could not be fetched.
- ITU-R BS.2217 conformance material.
- The browser decode path and worker runtime; `LiveEditorHost.loadAudioSamples` (web package not installed in the sandbox, so web typecheck and tests were not run; it mirrors `silence-cut-bridge.ts`).
- 96 kHz and 5.1 true peak beyond agreement with ffmpeg's own (internally resampled) figure.
- Exact per-case deviations from the oracle were asserted within tolerance but not recorded.

## Tool semantics

- Measures **source audio before clip effects, volume, speed, reverse and transitions.** Clip speed/reverse are not applied and the tool says so in `warnings`. It is not a mix-bus meter.
- Exactly one of `clipId` / `mediaId`. `clipId` measures `inPoint..outPoint`; `startTime`/`endTime` (source seconds) narrow it.
- `targetLufs` adds `gainToTargetDb`, `truePeakAfterGainDbtp`, `exceedsMinus1Dbtp`; it does not change the project.
- Errors: `INVALID_PARAMS`, `NOT_FOUND`, `NO_AUDIO`, `UNSUPPORTED_HOST`, each with `suggestedFix`.
