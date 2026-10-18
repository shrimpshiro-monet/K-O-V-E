/**
 * Merchant-of-record (MoR) webhook handler.
 *
 * The owner chose MoR billing (e.g. Lemon Squeezy / Paddle): the MoR holds
 * the customer/payment relationship and handles sales tax; WE only maintain
 * the entitlement (tier) per user. So this handler does two things:
 *
 *   1. VERIFY the webhook (HMAC signature over the raw body) — never trust
 *      an unverified body.
 *   2. MAP subscription lifecycle events to a tier upsert.
 *
 * Default implementation targets Lemon Squeezy (`x-ls-signature` =
 * base64(HMAC-SHA256(rawBody, secret))); the verifier and event mapper are
 * injectable so Paddle (or a future provider) plugs in without touching the
 * entitlement flow. All crypto goes through an injectable `hmac` so CI needs
 * no live provider.
 */
import type { PlanTier } from "@kove-advanced/metering";

export interface MorWebhookEvent {
  /** e.g. "subscription_created" | "customer_subscriptions_updated" | "subscription_presentation_cancelled" */
  readonly event: string;
  readonly data: Record<string, unknown>;
}

/** Resolves which tier an event implies, or undefined to leave it unchanged. */
export type TierMapper = (ev: MorWebhookEvent) => PlanTier | undefined;

export interface EntitlementWriter {
  setEntitlement(
    userId: string,
    tier: PlanTier,
    refs?: { morCustomerId?: string; morSubscriptionId?: string },
  ): Promise<void>;
}

export interface HandleWebhookOptions {
  readonly secret: string;
  readonly signatureHeader?: string; // header name, default "x-ls-signature"
  readonly signature: string; // the raw signature value from the request
  readonly rawBody: string; // EXACT bytes as received (HMAC is over raw body)
  readonly mapper: TierMapper;
  readonly entitlements: EntitlementWriter;
  readonly nowMs?: number;
  /** Injectable HMAC-SHA256(base64) — defaults to WebCrypto. */
  readonly hmac?: (message: string, secret: string) => Promise<string>;
  /** Pulls the customer id out of the event (Lemon Squeezy: data.attributes.customer_id). */
  readonly customerId?: (ev: MorWebhookEvent) => string | undefined;
  /** Pulls the subscription id out of the event. */
  readonly subscriptionId?: (ev: MorWebhookEvent) => string | undefined;
}

export type WebhookResult =
  | { ok: true; action: "tier-set" | "ignored"; tier?: PlanTier }
  | { ok: false; code: "BAD_SIGNATURE" | "BAD_PAYLOAD"; status: number };

const DEFAULT_HEADER = "x-ls-signature";

const defaultHmac = async (message: string, secret: string): Promise<string> => {
  const subtle = globalThis.crypto.subtle;
  const enc = new TextEncoder();
  const key = await subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await subtle.sign("HMAC", key, enc.encode(message));
  // base64
  const bytes = new Uint8Array(sig);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
};

/**
 * Lemon Squeezy default mapper:
 *  - active/paid subscription events  -> "pro"
 *  - cancel/pause/expiry events       -> "free"
 *  - everything else                  -> undefined (no change)
 */
export const lemonSqueezyMapper: TierMapper = (ev) => {
  switch (ev.event) {
    case "subscription_created":
    case "subscription_activated":
    case "customer_subscriptions_updated":
      // Only activate Pro when the updated state is active/paid.
      return isSubscriptionActive(ev) ? "pro" : undefined;
    case "subscription_cancelled":
    case "subscription_presentation_cancelled":
    case "subscription_expired":
      return "free";
    default:
      return undefined;
  }
};

function isSubscriptionActive(ev: MorWebhookEvent): boolean {
  const data = ev.data;
  const attrs = (data.attributes ?? data) as Record<string, unknown>;
  const status = String(attrs.status ?? attrs.subscription_status ?? "");
  const periodStatus = String(attrs.period_status ?? "");
  return (
    status === "active" ||
    status === "trialing" ||
    periodStatus === "active" ||
    periodStatus === "trialing"
  );
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export async function handleMoRWebhook(opts: HandleWebhookOptions): Promise<WebhookResult> {
  const headerName = opts.signatureHeader ?? DEFAULT_HEADER;
  void headerName; // header NAME is used by the router; verification uses the value.
  const hmac = opts.hmac ?? defaultHmac;

  const expected = await hmac(opts.rawBody, opts.secret);
  if (!timingSafeEqual(expected, opts.signature.trim())) {
    return { ok: false, code: "BAD_SIGNATURE", status: 401 };
  }

  let ev: MorWebhookEvent;
  try {
    const parsed = JSON.parse(opts.rawBody) as {
      event?: string;
      data?: Record<string, unknown>;
    };
    if (typeof parsed.event !== "string" || !parsed.data) {
      return { ok: false, code: "BAD_PAYLOAD", status: 400 };
    }
    ev = { event: parsed.event, data: parsed.data };
  } catch {
    return { ok: false, code: "BAD_PAYLOAD", status: 400 };
  }

  const tier = opts.mapper(ev);
  if (tier === undefined) {
    return { ok: true, action: "ignored" };
  }

  const customerId = opts.customerId?.(ev);
  if (!customerId) {
    // Can't attribute the subscription to a user — ignore (and log upstream).
    return { ok: true, action: "ignored" };
  }

  await opts.entitlements.setEntitlement(customerId, tier, {
    morCustomerId: customerId,
    morSubscriptionId: opts.subscriptionId?.(ev),
  });
  return { ok: true, action: "tier-set", tier };
}

/**
 * Default field extractors for Lemon Squeezy payloads. The Clerk user id is
 * stored as the LQ customer id via `custom_javascript`/metadata at checkout
 * (documented in the smoke-test checklist) — owner wiring.
 */
export const lemonSqueezyCustomer = (ev: MorWebhookEvent): string | undefined => {
  const attrs = (ev.data.attributes ?? ev.data) as Record<string, unknown>;
  const cid = attrs.customer_id;
  return typeof cid === "string" && cid ? cid : undefined;
};

export const lemonSqueezySubscription = (ev: MorWebhookEvent): string | undefined => {
  const attrs = (ev.data.attributes ?? ev.data) as Record<string, unknown>;
  const sid = attrs.id ?? attrs.subscription_id;
  return typeof sid === "string" && sid ? sid : undefined;
};
