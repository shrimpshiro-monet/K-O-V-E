# Security & Credential Rotation

Status: **ACTION REQUIRED** — one credential class must be rotated before the
next production deploy. Everything else is verified clean or not applicable.

## 1. MUST rotate

### Cloudflare API token (`CLOUDFLARE_API_TOKEN`)

**Why.** The previous web build configuration injected the build-time
`VITE_CLOUDFLARE_API_TOKEN` environment variable into the client bundle, and
the production transport called `api.cloudflare.com` directly with
`Authorization: Bearer <token>` from the browser. Any token value that was
present in a build/deploy environment is therefore assumed to have been
shipped to every visitor of the deployed site.

**Verify before rotating.** In this clone, `scripts/check-bundle-secrets.mjs`
against a freshly built `apps/web/dist` passes (no credential-looking values,
no `api.cloudflare.com`). It was also verified against the pre-fix bundle
built with a sentinel token: the sentinel value appeared in
`dist/assets/ChatPanel-*.js`, proving the leak path. For bundles already
deployed *before* the fix, assume the value is public — do not re-check, just
rotate.

**Also note.** This clone's git history was scanned (all objects, secret
patterns + `VITE_` secret-named variables): no live credentials were found in
committed source. The exposure vector was the build environment, not git. The
upstream repository's full history is not auditable from this environment,
which is an additional reason to rotate regardless of scan results.

**How to rotate.**
1. In the Cloudflare dashboard (or API), revoke the exposed token and issue a
   new one scoped to **AI: Read** (the gateway only calls Workers AI
   `chat/completions`).
2. Redeploy the web app with the new value as a Pages secret:
   ```bash
   pnpm --filter @kove-advanced/web exec wrangler pages secret put CLOUDFLARE_API_TOKEN
   pnpm --filter @kove-advanced/web exec wrangler pages secret put CLOUDFLARE_ACCOUNT_ID
   ```
3. Update `.dev.vars` (repo root) for local dev.

`CLOUDFLARE_ACCOUNT_ID` is not a secret (it authenticates nothing) and does
not need to change; it is kept out of the client bundle anyway.

## 2. Verify / optional

| Credential | Status | Action |
|---|---|---|
| Cloudflare API token | **exposed via old prod bundle** | Rotate (above) |
| Cloudflare account id | Not a secret; was bundled with the token | No action; now server-side only |
| PostHog project key (`phc_…`) | Public by design (ships to browsers by definition); no `phc_` value found committed in this clone | None, unless a different (personal) PostHog key was ever set in a build env — check deploy env history |
| BYOK keys (ElevenLabs/OpenAI/Anthropic) entered by users | User-side by design (encrypted in the user's browser storage or OS keychain on desktop); never server-side, never logged | No owner action; communicate to users only if their storage is ever exposed |
| `$KOVE_ADVANCED` contract address (old README) | Public token address, not a secret | Removed from README as stale; no rotation concept applies |

## 3. What the fix changed (recurrence prevention)

- The web client no longer reads any `VITE_CLOUDFLARE_*` variable and no
  longer references `api.cloudflare.com`. It calls same-origin `/api/llm/*`
  unauthenticated.
- Production: `apps/web/functions/api/llm` (Pages Function) attaches the
  Pages secrets. Dev: the Vite dev proxy attaches credentials from `.dev.vars`
  in the Node process only. Desktop: the Electron main process attaches
  credentials from its runtime env (renderer relays via local IPC).
- `VITE_PUBLIC_POSTHOG_KEY` was renamed to `VITE_POSTHOG_CLIENT_ID` so the
  name no longer reads as a secret (the value remains public by design).
- CI `Secret gates` job: `scripts/check-vite-secrets.mjs` fails on any `VITE_*`
  name matching `/KEY|TOKEN|SECRET|PASSWORD/i`; `gitleaks` scans history.
- CI build job: `scripts/check-bundle-secrets.mjs` fails if the compiled
  bundle contains credential-looking values, a literal `Bearer` token, or the
  direct provider host.

## 4. Ongoing rules

1. **No provider secret may ever be a `VITE_*` variable.** Server-side
   secrets live in Pages secrets (prod), `.dev.vars` (dev, gitignored), or the
   desktop main-process env.
2. New third-party integrations must ship behind the same-origin gateway
   pattern (or an equivalent server-side relay) with a CI check proving the
   client bundle cannot reach the provider directly.
3. If a secret is ever suspected leaked: rotate first, forensics second.
   Assume public the moment a value has been in a build environment that
   produces a public bundle.
