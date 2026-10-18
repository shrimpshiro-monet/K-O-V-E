/**
 * @kove-advanced/gateway
 *
 * Server-side adapters + orchestrator for the LLM gateway:
 *  - clerk.ts:     Clerk JWT verification (WebCrypto, injectable)
 *  - supabase.ts:  usage-ledger + entitlement stores (PostgREST, injectable)
 *  - morer.ts:     merchant-of-record webhook → entitlement updates
 *  - runner.ts:    authorize() / complete() orchestration (the thing the
 *                  Pages Function calls)
 *
 * Nothing here may be imported from the client bundle — auth and billing
 * logic is server-side only (the bundle gate enforces this).
 */
export * from "./clerk.ts";
export * from "./supabase.ts";
export * from "./morer.ts";
export * from "./runner.ts";
