# Tool-argument schema validation

Implementation: `packages/agent/src/schema-validate.ts` (the header comment there is the authoritative policy text).
Wired in `executor.ts`: `resolveRefs` → `gateToolArgs` → handler. Handler-level checks stay as defense in depth.

## Stages

1. **Shadow (default for the 316 legacy tools):** validate and record mismatches (`getSchemaMismatches()`); never mutate, never reject.
2. **Fix** what shadow logging and `schema-conformance.test.ts` surface.
3. **Enforce per tool:** `KOVE_SCHEMA_ENFORCE=tool_a,tool_b` or `setSchemaPolicy({enforceTools})`; `KOVE_SCHEMA_MODE=off|shadow|enforce`.
   **Nothing is enforced for legacy tools yet.** Evidence says 51 tools are ready, 10 need review (`add_clip`, `add_track`,
   `set_clip_chroma_key`, `set_clip_pitch_correction`, `set_clip_reverse`, `set_clip_stabilization`, `set_clip_keyframes`,
   `update_project_settings`, `update_transition`, `duplicate_track`); the 255 direct-handler tools are not covered by the evidence.
   Real-usage shadow logs are needed first: suite-driven logs show schema shape, not agent traffic.
4. **New tools are `strict: true` from day one** (rejects unknown keys and wrong types). `schema-legacy-tools.json` is a snapshot of the 316 legacy names; it only shrinks, never add to it.

## Coercion (enforce/strict only; each reported as a warning)

Coerced: decimal strings → numbers, `"true"`/`"false"` → booleans, `null` on an optional property → dropped.
Never coerced: `""`, `" 5"`, `"0x10"`, `"1e3"`, number → string, fractional → integer. No clamping.

## Unknown keys

Legacy enforced tools: strip and warn. Strict tools: reject with a did-you-mean. `freeform` tools (`execute_action`) skip unknown-key handling.
Implicit root keys `clipIndex`, `atSec`, `trackIndex` are always allowed. Global strip is unsafe because legacy schemas understate
their params (`additionalProperties: true`) and `actionTool` forwards all args, hence per-tool enforcement.

## Rejections

`{ok:false, error:{code:"INVALID_PARAMS", message, suggestedFix}}`, at most 5 issues listed.
