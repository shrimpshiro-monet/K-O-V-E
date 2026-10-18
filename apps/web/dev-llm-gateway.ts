/**
 * DEV-ONLY authenticated LLM gateway for the Vite dev server.
 *
 * It reuses the EXACT production HTTP handler
 * (functions/api/llm/[[catchall]].ts → handleLlmGateway) so local dev
 * enforces the same contract as prod: Clerk auth (401), tier resolution,
 * quota (429), budget (504), model routing, idempotent metering.
 *
 * Dev differences (documented + intentional):
 *   - The ledger is IN-MEMORY (dev convenience; billing state does not
 *     persist across dev-server restarts). Production uses Supabase Postgres.
 *   - When Supabase dev vars are absent, the tier resolves to "free"
 *     (fail-closed, same as the production store-error path).
 *
 * The middleware is mounted ONLY when CLERK_ISSUER is present in .dev.vars;
 * otherwise the legacy credential-injecting passthrough proxy is used and a
 * loud warning is logged (local development only — see
 * docs/SMOKE-TEST-CHECKLIST.md).
 */
import { EntitlementStore, Gateway } from "@kove-advanced/gateway";
import {
  DEFAULT_FAST_MODEL,
  DEFAULT_FRONTIER_MODEL,
  InMemoryLedger,
  Ledger,
  type PlanTier,
} from "@kove-advanced/metering";
import {
  handleLlmGateway,
  type GatewayEnv,
  type LlmGatewayDeps,
} from "./functions/api/llm/[[catchall]]";

export type { GatewayEnv as DevLlmGatewayEnv };

const DEV_UPSTREAM_TIMEOUT_MS = 120_000;

const freeOnlyEntitlements: EntitlementStore = {
  getTier: async (): Promise<PlanTier> => "free",
  setEntitlement: async (): Promise<void> => {
    /* dev: no persistence */
  },
} as unknown as EntitlementStore;

export function buildDevDeps(env: GatewayEnv): LlmGatewayDeps {
  const fastModel = env.GATEWAY_FAST_MODEL?.trim() || DEFAULT_FAST_MODEL;
  const frontierModel = env.GATEWAY_FRONTIER_MODEL?.trim() || DEFAULT_FRONTIER_MODEL;
  const hasFrontier = Boolean(env.FRONTIER_BASE_URL?.trim() && env.FRONTIER_API_KEY?.trim());

  const gateway = new Gateway({
    clerk: {
      issuer: env.CLERK_ISSUER as string,
      jwksUrl:
        env.CLERK_JWKS_URL?.trim() ||
        `${(env.CLERK_ISSUER as string).replace(".accounts.dev", ".com")}/.well-known/jwks.json`,
      audience: env.CLERK_AUDIENCE?.trim() || undefined,
    },
    entitlements:
      env.SUPABASE_URL?.trim() && env.SUPABASE_SERVICE_ROLE_KEY?.trim()
        ? new EntitlementStore({
            url: env.SUPABASE_URL.trim(),
            serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY.trim(),
          })
        : freeOnlyEntitlements,
    ledger: new Ledger(new InMemoryLedger()),
    isFrontierModel: (m) => m === frontierModel,
  });

  return {
    gateway,
    fetchProvider: (url, init) =>
      fetch(url, { ...init, signal: AbortSignal.timeout(DEV_UPSTREAM_TIMEOUT_MS) }),
    fastModel,
    frontierModel,
    hasFrontier,
  };
}

/** The dev-server equivalent of the Pages Function entrypoint. */
export async function handleDevLlmRequest(
  request: Request,
  env: GatewayEnv,
  path: string,
): Promise<Response> {
  return handleLlmGateway(request, env, path, buildDevDeps(env));
}

/** True when the dev server should enforce the full gateway (auth on). */
export function devAuthConfigured(env: GatewayEnv): boolean {
  return Boolean(env.CLERK_ISSUER?.trim());
}
