# Agent tool audit (Phase 0)

> Rewritten from session notes after the original was lost. (It was lost because `.gitignore` had `docs/*`, so new docs were
> never committed; `!docs/AGENT-*.md` now fixes that.) Figures marked *runtime* come from `listTools()`; the textual grep count
> (283 at the time) undercounts.

## Inventory (at audit time, `main`)

- **316 tools in 22 domains** (motion = 190). 61 action-backed, 39 read-only, 216 direct-handler tools. With the 5 history tools,
  `measure_loudness` and `render_timeline_frame` added by this programme: 323 (see generated `docs/AGENT-CAPABILITIES.md`).
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
