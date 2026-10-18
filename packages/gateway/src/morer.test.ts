import { describe, expect, it } from "vitest";
import {
  handleMoRWebhook,
  lemonSqueezyMapper,
  lemonSqueezyCustomer,
  lemonSqueezySubscription,
  type EntitlementWriter,
} from "./morer";

const SECRET = "whsec_test_secret";

function writer(): { ent: EntitlementWriter; writes: Array<{ user: string; tier: string }> } {
  const writes: Array<{ user: string; tier: string }> = [];
  const ent: EntitlementWriter = {
    setEntitlement: async (user, tier, _refs) => {
      writes.push({ user, tier });
    },
  };
  return { ent, writes };
}

/** Real HMAC-SHA256 (base64) via WebCrypto — same primitive the handler uses. */
async function sign(message: string, secret: string): Promise<string> {
  const subtle = globalThis.crypto.subtle;
  const enc = new TextEncoder();
  const key = await subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await subtle.sign("HMAC", key, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

const base = { secret: SECRET };

describe("handleMoRWebhook", () => {
  it("sets tier to pro on an active subscription_created", async () => {
    const { ent, writes } = writer();
    const body = JSON.stringify({
      event: "subscription_created",
      data: { attributes: { customer_id: "user_1", id: "sub_1", status: "active" } },
    });
    const res = await handleMoRWebhook({
      ...base,
      signature: await sign(body, SECRET),
      rawBody: body,
      mapper: lemonSqueezyMapper,
      entitlements: ent,
      customerId: lemonSqueezyCustomer,
      subscriptionId: lemonSqueezySubscription,
    });
    expect(res).toEqual({ ok: true, action: "tier-set", tier: "pro" });
    expect(writes).toEqual([{ user: "user_1", tier: "pro" }]);
  });

  it("sets tier to free on subscription_cancelled", async () => {
    const { ent, writes } = writer();
    const body = JSON.stringify({
      event: "subscription_cancelled",
      data: { attributes: { customer_id: "user_1", id: "sub_1", status: "cancelled" } },
    });
    const res = await handleMoRWebhook({
      ...base,
      signature: await sign(body, SECRET),
      rawBody: body,
      mapper: lemonSqueezyMapper,
      entitlements: ent,
      customerId: lemonSqueezyCustomer,
      subscriptionId: lemonSqueezySubscription,
    });
    expect(res).toEqual({ ok: true, action: "tier-set", tier: "free" });
    expect(writes).toEqual([{ user: "user_1", tier: "free" }]);
  });

  it("ignores events that map to no tier change", async () => {
    const { ent, writes } = writer();
    const body = JSON.stringify({
      event: "some_unknown_event",
      data: { attributes: { customer_id: "user_1" } },
    });
    const res = await handleMoRWebhook({
      ...base,
      signature: await sign(body, SECRET),
      rawBody: body,
      mapper: lemonSqueezyMapper,
      entitlements: ent,
      customerId: lemonSqueezyCustomer,
      subscriptionId: lemonSqueezySubscription,
    });
    expect(res).toEqual({ ok: true, action: "ignored" });
    expect(writes).toEqual([]);
  });

  it("rejects a BAD_SIGNATURE (401) and never writes", async () => {
    const { ent, writes } = writer();
    const body = JSON.stringify({
      event: "subscription_created",
      data: { attributes: { customer_id: "user_1", status: "active" } },
    });
    const res = await handleMoRWebhook({
      ...base,
      signature: await sign(body, "WRONG_SECRET"),
      rawBody: body,
      mapper: lemonSqueezyMapper,
      entitlements: ent,
      customerId: lemonSqueezyCustomer,
      subscriptionId: lemonSqueezySubscription,
    });
    expect(res).toEqual({ ok: false, code: "BAD_SIGNATURE", status: 401 });
    expect(writes).toEqual([]);
  });

  it("rejects a tampered body (signature no longer matches)", async () => {
    const { ent, writes } = writer();
    const legit = JSON.stringify({
      event: "subscription_created",
      data: { attributes: { customer_id: "user_1", status: "active" } },
    });
    const sig = await sign(legit, SECRET);
    const tampered = JSON.stringify({
      event: "subscription_created",
      data: { attributes: { customer_id: "ATTACKER", status: "active" } },
    });
    const res = await handleMoRWebhook({
      ...base,
      signature: sig,
      rawBody: tampered,
      mapper: lemonSqueezyMapper,
      entitlements: ent,
      customerId: lemonSqueezyCustomer,
      subscriptionId: lemonSqueezySubscription,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("BAD_SIGNATURE");
    expect(writes).toEqual([]);
  });

  it("rejects a BAD_PAYLOAD (400) for non-JSON or missing shape", async () => {
    const { ent } = writer();
    const res = await handleMoRWebhook({
      ...base,
      signature: await sign("{bad json", SECRET),
      rawBody: "{bad json",
      mapper: lemonSqueezyMapper,
      entitlements: ent,
      customerId: lemonSqueezyCustomer,
      subscriptionId: lemonSqueezySubscription,
    });
    expect(res).toEqual({ ok: false, code: "BAD_PAYLOAD", status: 400 });
  });

  it("ignores a valid event with no attributable customer", async () => {
    const { ent, writes } = writer();
    const body = JSON.stringify({
      event: "subscription_created",
      data: { attributes: { status: "active" } }, // no customer_id
    });
    const res = await handleMoRWebhook({
      ...base,
      signature: await sign(body, SECRET),
      rawBody: body,
      mapper: lemonSqueezyMapper,
      entitlements: ent,
      customerId: lemonSqueezyCustomer,
      subscriptionId: lemonSqueezySubscription,
    });
    expect(res).toEqual({ ok: true, action: "ignored" });
    expect(writes).toEqual([]);
  });
});

describe("lemonSqueezyMapper", () => {
  it("activates pro only when the subscription is active/trialing", () => {
    expect(
      lemonSqueezyMapper({ event: "customer_subscriptions_updated", data: { attributes: { status: "active" } } }),
    ).toBe("pro");
    expect(
      lemonSqueezyMapper({ event: "customer_subscriptions_updated", data: { attributes: { status: "past_due" } } }),
    ).toBeUndefined();
  });
});
