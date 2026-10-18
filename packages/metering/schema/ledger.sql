-- Supabase/Postgres schema for the usage ledger + entitlements.
--
-- The in-memory reference implementation (packages/metering) mirrors these
-- constraints exactly:
--   * usage_ledger: UNIQUE (user_id, idempotency_key)  => replay safety
--   * usage_ledger: billable rows only are counted for quotas
--   * user_entitlements: one row per user, default 'free'
--
-- Apply in the Supabase SQL editor. RLS: the GATEWAY writes via the
-- service-role key (bypasses RLS). No client should ever write to these
-- tables; select access for the user's own rows is optional for a future
-- "your usage" UI.

create table if not exists public.usage_ledger (
  id text primary key,
  user_id text not null,
  idempotency_key text not null,
  tier text not null check (tier in ('free', 'pro')),
  model text not null,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  -- 0 + 'unverified' until the owner's verified price list is configured
  -- (no fabricated numbers in the ledger).
  cost_usd numeric(14, 6) not null default 0,
  cost_status text not null default 'unverified' check (cost_status in ('unverified', 'listed')),
  latency_ms integer not null default 0,
  replay_of text,
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

-- Quota lookup: rolling-day billable turns for a user.
create index if not exists usage_ledger_user_day_idx
  on public.usage_ledger (user_id, created_at);

-- Optional audit aggregate: daily billable volume per tier.
create or replace function public.daily_billable_usage(day date)
returns table (tier text, turns bigint, input_tokens bigint, output_tokens bigint)
language sql stable
as $$
  select tier,
         count(*) as turns,
         coalesce(sum(input_tokens), 0)::bigint,
         coalesce(sum(output_tokens), 0)::bigint
  from public.usage_ledger
  where created_at::date = day
  group by tier;
$$;

create table if not exists public.user_entitlements (
  user_id text primary key,
  tier text not null default 'free' check (tier in ('free', 'pro')),
  -- Merchant-of-record references (Lemon Squeezy / Paddle), nullable until
  -- the owner wires the store.
  mor_customer_id text,
  mor_subscription_id text,
  updated_at timestamptz not null default now()
);

-- Gateway writes entitlements from MoR webhooks:
--   insert into public.user_entitlements (user_id, tier, mor_customer_id, mor_subscription_id)
--   values ($1, $2, $3, $4)
--   on conflict (user_id) do update
--     set tier = excluded.tier,
--         mor_customer_id = coalesce(excluded.mor_customer_id, user_entitlements.mor_customer_id),
--         mor_subscription_id = coalesce(excluded.mor_subscription_id, user_entitlements.mor_subscription_id),
--         updated_at = now();
