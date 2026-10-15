# Agent tool audit (Phase 0)

> Rewritten from session notes after the original was lost. (It was lost because `.gitignore` had `docs/*`, so new docs were
> never committed; `!docs/AGENT-*.md` now fixes that.) Figures marked *runtime* come from `listTools()`; the textual grep count
> (283 at the time) undercounts.

## Inventory (at audit time, `main`)

- **316 tools in 22 domains** (motion = 190). 61 action-backed, 39 read-only, 216 direct-handler tools. With the 5 history tools,
  `measure_loudness` and `render_timeline_frame` added by this programme: 323 (see generated `docs/AGENT-CAPABILITIES.md`).
  After the reference-clone phase: **335** — the delta over 333 is `analyze_reference_media` and `build_mirror_plan`.
- PR #2 documents 113 core action types and fixed 7 silent action-dispatch failures (`evidence/`).
- The tool router caps at 120 tools per request.

## Findings and status

| # | Finding | Status |
|---|---|---|
| 1 | No generator-freshness gate for the docs | Fixed: `gen-docs.test.ts` regenerate-and-compare |
| 2 | No undo / redo / checkpoint | Fixed: checkpoints, undo/redo, human-edit ledger, 5 `history` tools. Deviation: replay-based, not copies, because the project is mutated in place |
| 3 | `preview_frame` broken in the live host | Fixed: explicit `UNSUPPORTED_HOST`; `get_capabilities` reports host features |
| 4 | Multicam params in ms, inconsistent with the editor | Fixed additively: seconds params, `*Ms` kept as deprecated aliases, conflicts rejected, outputs gain second siblings |
| 5 | ~365 opaque params in 116 tools; schemas unenforced | Shadow validation for legacy, strict for new tools. **Nothing enforced for legacy yet** (`AGENT-SCHEMA-VALIDATION.md`) |
| 6 | `measureLoudness` was a placeholder | Fixed: real meter + `measure_loudness` (`AGENT-LOUDNESS.md` for validation limits) |
| 7 | Agent cannot see the timeline | Contract + tool built; **renderer not built** (`AGENT-RENDER.md`) |
| 8 | `batch_actions` is non-atomic | **Open** (needs transactions and `dry_run`) |
| 9 | Helper-spreading handlers forward unvalidated args (`set_creation_object_geometry`, `add_transition`, `add_creation_*`) | **Open**; review before enforcing |
| 10 | Phase 2 candidates mostly exist as core engines, not tools | Not started; no go-ahead for Phases 2–4 |

## Corrections

- OTIO export is **not** absent: `packages/core/src/multicam/otio.ts` (multicam plans only, not an agent tool). FCPXML/EDL not found.
- Not verified: `insert_motion_into_editor` one-way bridging; subtitle export.
- No `ActionType` union exists in core; use PR #2's evidence for the action list.

## Reference-clone tooling (added after the Phase 0 audit)

Two `ai`-domain tools turn a marked reference video into a deterministic EditPlan — no LLM in the
mapping path, because a director re-authors a plan instead of reproducing it.

| Tool | Purpose | Contract |
|---|---|---|
| `analyze_reference_media` | Uploads a marked reference to the local python engine (`POST /analyze-upload`) and measures how it is actually cut: scene cuts, shot durations, pacing, junction and camera-motion evidence. | Requires `analysisVersion >= 1.2.0`; older reports are rejected with `REFERENCE_VERSION_TOO_OLD` because they carry no cut evidence. Returns a **trimmed** envelope (no observations, no per-frame timestamps, no timings) — it is paid for three times over (tool result → `plan_edit` argument → director prompt) and idempotency keys hash it. The full report is stashed in module state, and that stash is the *only* mirror input, which is what keeps eco/`analyze-frames` 1.1.0-class reports out of mirror mode by construction. |
| `build_mirror_plan` | Compiles one `PlannedSegment` per reference shot; maps junctions by fixed rules (`hard-cut` → no entry, `fade-to-black` → `dipToBlack` 0.4s, `unknown-boundary` → `crossfade` 0.4s, motion within 0.8s of a boundary → `whipPan`) and mid-shot motion to named camera moves with `intensity = min(1, meanOpticalFlow / 12)`. | `apply=false` (default) returns `{editPlan, fitPolicy, structuralDiff, applied}`. `apply=true` commits ONE revision through `commitEditPlanRevision` — the same commit tail `plan_edit` uses (normalize → validate → stale/idempotency guards → fingerprint no-op → materialize → cleanup → revision bump), extracted into a shared helper so the two paths cannot drift. Idempotency key hashes (referenceVideoId, analysisVersion, fitPolicy, source ids). |

Supporting changes:

- `packages/python-engine`: `ANALYSIS_VERSION` 1.2.0; `editPattern.cutEvidence`; shot count, shot durations and pacing
  derived from real scene cuts (final shot capped at the media duration) instead of sample gaps; `scene_detector`
  returns `[]` — not `[(0.0, 0.0)]` — when detection fails, so "no evidence" is never read as "one scene";
  `segment_builder` splits on `shot_boundary` even when labels are unchanged; the second audio decode is gone;
  `/analyze-upload` (multipart, job contract identical to `/analyze`, sweeps expired jobs first) with CORS for the
  `app://` renderer.
- `packages/agent/src/engine/client.ts`: one shared engine client (upload + poll). Hardened over the frame-worker's
  loop: `res.ok` is checked before `.json()` (a 500 used to surface as a JSON SyntaxError), non-OK responses carry
  the HTTP status, `unknown` is terminal, and the timeout error names the last observed status.
- `packages/agent/src/replication/mirror.ts`: the compiler, the numeric version gate (`atLeast`), and
  `structuralDiff` — which compares the plan against the **engine report** (shot-count match, max per-shot drift)
  instead of against the plan's own description of itself.

Known limitations, stated rather than faked: `textElements` is always `[]` in v1 (the engine reports
graphic-or-text candidates but no OCR is wired up), and the mirror compiles from the first analyzed
reference only.
