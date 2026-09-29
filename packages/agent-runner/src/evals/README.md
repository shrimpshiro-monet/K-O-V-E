# Director eval inputs and rubric — FROZEN

**Status (2026-09-29): inputs and rubric are frozen. No trustworthy product
baseline is recorded yet.**

## What is frozen

- **Inputs** — `cases.ts` (deterministic scripted cases and their project
  fixtures) and the prompts embedded in them.
- **Rubric** — the per-case `assert` functions in `cases.ts`, the harness
  contract in `harness.ts`, and the five quality-benchmark dimensions in
  `quality-benchmark.ts` (`momentSelection`, `timing`, `rhythm`,
  `visualCoherence`, `effectRestraint`).

Changing a case's prompt/fixture or an assertion/dimension requires a
dedicated rubric-change PR that explains the change; do not edit them
"in passing" alongside product changes.

## Why no product baseline is recorded

A product baseline score is only trustworthy once:

1. **Synthetic quality scoring is gone.** The director pipeline used to
   fabricate a quality percentage when frame sampling failed; it now reports
   `quality: { status: "unavailable" }` (removed in the plan-edit integrity
   PR — see `packages/agent/src/director/`, quality-pipeline deleted).
2. **The analysis path actually works.** Rendered-frame sampling back into
   the analysis pipeline is not implemented; until frames can be sampled
   and scored for real, any "baseline" number would be an artifact of the
   harness, not the product.

Until both hold, `quality-benchmark.ts` scores may be *computed* by passing
values in explicitly, but **no baseline result may be committed as the
product's score**. The deterministic corpus pass-rate in `evals.test.ts` is
a harness-health signal, not a product-quality baseline.
