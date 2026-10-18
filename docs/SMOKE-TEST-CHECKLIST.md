# §2 Smoke-Test Checklist (OWNER-RUN)

The sandbox has no live Clerk / Supabase / Lemon Squeezy / Workers AI access,
so the **live** paths below must be run by the owner. Everything the sandbox
COULD run (signature verification against a local JWKS, quota, model gating,
replay dedup, error mapping, dev-server wiring) is covered by unit/integration
tests:

- `packages/metering` — 25 tests (policy, replay, quota, budget, cost)
- `packages/gateway` — 37 tests (Clerk JWT verify, PostgREST stores, MoR webhook, orchestrator)
- `apps/web/functions/api/llm` — 18 tests (the HTTP layer: 401/403/429/503, model rewrite, replay headers)
- `apps/web/src/services/agent` — 21 tests (session token, idempotency keys, structured errors)
- Dev-server E2E (run in this sandbox against a local JWKS): unauthenticated → 401; valid locally-signed ES256 token → auth passes through to the provider stage.

## 1. Production deployment (Cloudflare Pages)

Pages secrets (`wrangler pages secret put <KEY>`):

| Secret | Value | Required |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Workers AI token (pre-existing) | yes |
| `CLOUDFLARE_ACCOUNT_ID` | CF account (pre-existing) | yes |
| `CLERK_ISSUER` | e.g. `https://<instance>.clerk.accounts.dev` | yes |
| `CLERK_JWKS_URL` | e.g. `https://<instance>.clerk.com/.well-known/jwks.json` (defaults to the issuer-derived one) | optional |
| `CLERK_AUDIENCE` | only if your Clerk JWTs carry `aud` | optional |
| `SUPABASE_URL` | project URL | yes |
| `SUPABASE_SERVICE_ROLE_KEY` | service-role key (server-only!) | yes |
| `FRONTIER_BASE_URL` / `FRONTIER_API_KEY` | Pro frontier endpoint (OpenAI-compatible) | optional |
| `GATEWAY_FAST_MODEL` / `GATEWAY_FRONTIER_MODEL` | model overrides | optional |

Database: apply `packages/metering/schema/ledger.sql` in the Supabase SQL
editor (creates `usage_ledger`, `user_entitlements`, `daily_billable_usage`).

## 2. One-command live smoke (preferred)

With a signed-in Clerk session JWT (from the deployed app), run:

    pnpm eval:live --token "<jwt>"
    # or: pnpm eval:live --token "<jwt>" --gateway https://kove-advanced-preview.pages.dev

It checks: authenticated `/v1/models`, one billable probe completion,
**replay with the same Idempotency-Key is not billed**, and that an
unauthenticated request 401s. Writes only compact summaries to
`evaluation-files/eval-live-<ts>.{json,md}` (no media/secrets/prompt
content). Exit code 0 = all checks passed.

## 3. Manual smoke tests (production or preview)

1. **401 unauth** — with no sign-in, any AI call returns
   `{"error":{"code":"UNAUTHENTICATED",...}}` 401; no provider call is made.
2. **Model list** — signed in, `GET /api/llm/v1/models` returns the tier's
   models (free: fast model only; pro: + frontier).
3. **Billable turn** — run one plan_edit turn. Verify a NEW row appears in
   `usage_ledger` for the user with token counts, `cost_status='unverified'`.
4. **Replay = zero billable events** — resend the same turn (same
   Idempotency-Key, e.g. from the client network retry or a manual
   `curl` copy). Response is served, response headers show
   `X-Kove-Replayed: 1`, and **no second row** is created.
5. **Quota** — set `max_turns_per_day` exhaustion for a test user (or use the
   placeholder free limit of 10/day): the next turn returns 429
   `QUOTA_EXCEEDED` with an upgrade/tomorrow `suggestedFix`; no provider call.
6. **Model gating** — a free user requesting the frontier model gets 403
   `MODEL_NOT_ALLOWED`.
7. **Frontier slot** — with `FRONTIER_*` unset, a pro user requesting the
   frontier model gets 503 `FRONTIER_NOT_CONFIGURED` (not a fabricated
   success). With it set, the call reaches the frontier endpoint.
8. **MoR webhook** — in Lemon Squeezy's sandbox, fire
   `subscription_created` (active) → `user_entitlements` flips the user to
   `pro`; fire `subscription_cancelled` → back to `free`. A request with a
   bad `x-ls-signature` is rejected 401 and changes nothing.

## 4. Local development

`.dev.vars` (repo root, read by both `apps/web` vite and the desktop main):

- `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` — Workers AI (required for
  any LLM call).
- `CLERK_ISSUER` — **when present, the dev server enforces the FULL gateway**
  (auth/quota/metering with an in-memory ledger) and the legacy passthrough
  proxy is disabled. When absent, the dev server logs a loud
  "LEGACY passthrough" warning and serves unauthenticated (local-only).
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — optional in dev; without
  them the tier resolves to `free` (fail-closed).
- `FRONTIER_BASE_URL` / `FRONTIER_API_KEY` — optional.

Dev note: the client only sends a session token once the app registers a
Clerk session (`setGatewaySession` in
`apps/web/src/services/agent/gateway-session.ts`). Until Clerk sign-in is
wired into the app UI, dev calls are unsigned → full-gateway dev mode returns
401, which is the correct contract (and is how the dev E2E above was
verified).

## 5. Open owner items (desktop + billing)

- **Desktop relay**: `apps/desktop` still relays Cloudflare calls with
  local env/.dev.vars credentials (unchanged from before §2). The client now
  also sends the session token + Idempotency-Key; the relay safely strips the
  renderer's `Authorization` before attaching the CF token. To make desktop a
  full SaaS client it should be pointed at the production gateway
  (e.g. `KOVE_GATEWAY_URL=https://kove-advanced.pages.dev/api/llm`) — decision
  for the owner (it affects how desktop users are metered).
- **Billing unit**: the ledger bills per **LLM call** (one plan_edit turn
  makes several LLM calls). If "turns/day" should mean plan_edit turns
  instead, the quota needs distinct-turn counting (turn-key column) — flagged
  in the PR description.
- **Price list**: `cost_usd` is 0 + `unverified` until the owner configures a
  real price list (`configurePricing` in `packages/metering/src/cost.ts`). No
  fabricated numbers.
