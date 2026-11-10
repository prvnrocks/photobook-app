-- =============================================================================
-- 20261112001200_payments.sql — Milestone 7: Stripe payments (D-002, D-011)
--
-- Additive only: 0100–1100 are applied in production and must not be edited.
--
-- 1) public.orders
--      + stripe_payment_intent_id text unique  (refund / dispute events carry
--                                               only the payment intent)
--      + paid_at     timestamptz
--      + refunded_at timestamptz
--      + livemode    boolean                   (Stripe test vs live)
--    status check widened to pending | paid | failed | expired | refunded |
--    disputed. Partial unique index orders_one_pending_per_book: at most ONE
--    'pending' order per book (the upgrade action reuses the open session).
--    Grants are unchanged: owner may SELECT (orders_select_own), only the
--    service role writes.
--
-- 2) private.stripe_events (id text pk, type, created_at, processed_at) —
--    webhook idempotency ledger. Schema private is not exposed by PostgREST;
--    RLS on, NO policies, nothing granted to public / anon / authenticated;
--    service_role gets select/insert/update (it already has USAGE on private,
--    0500).
--
-- 3) public.fulfill_book_checkout(p_event_id text, p_event_type text,
--      p_session_id text, p_payment_intent text, p_book_id uuid, p_user_id uuid,
--      p_amount integer, p_currency text, p_livemode boolean) returns text
--    Called by the Stripe webhook (after signature verification) for
--    checkout.session.completed / async_payment_succeeded with payment_status
--    'paid'. One transaction:
--      * record the event in private.stripe_events (on conflict do nothing);
--        already seen → 'duplicate' and NOTHING else happens;
--      * lock the book row if it exists AND belongs to p_user_id;
--      * upsert the order on stripe_session_id: type 'digital', status 'paid'
--        (a 'refunded' / 'disputed' order is never moved back), paid_at (first
--        value kept), payment intent, amount, currency (lower-cased), livemode,
--        user_id (null if the user's profile / auth user no longer exists), book_id (null when
--        the book is missing or belongs to someone else);
--      * matched book → is_paid = true, max_pages = 100, expires_at = null.
--    Returns 'fulfilled' (book flipped now) | 'already_paid' (book was already
--    paid; entitlement columns re-asserted) | 'book_missing' (book missing or
--    user/book mismatch: order kept with book_id null, book untouched) |
--    'duplicate'. Required args null / empty, amount < 0 → 'invalid_argument'
--    (22023). p_payment_intent may be null.
--
-- 4) public.record_stripe_order_event(p_event_id text, p_event_type text,
--      p_session_id text, p_payment_intent text, p_status text,
--      p_livemode boolean) returns text
--    For checkout.session.expired / async_payment_failed / charge.refunded /
--    charge.dispute.created. Deduped through private.stripe_events. Finds the
--    order by p_session_id (if given) else by p_payment_intent; NEVER touches
--    public.books (refunds / disputes are logged, not revoked). Transitions:
--      expired / failed : only from 'pending'
--      refunded         : from anything but 'refunded'; sets refunded_at
--      disputed         : from anything but 'refunded' / 'disputed'
--    Also back-fills stripe_payment_intent_id and livemode when they are null.
--    Returns 'updated' | 'unchanged' (transition not allowed / already there) |
--    'order_missing' (event still recorded) | 'duplicate'. Invalid args (null
--    ids, both lookup keys null, unknown status) → 22023.
--
-- 5) Column guard: the INVOKER RPCs run as service_role when called with the
--    secret key, so private.protect_book_columns (current_user check, 1000)
--    lets the entitlement update through; for anon / authenticated EXECUTE is
--    revoked anyway. Both RPCs are SECURITY INVOKER with search_path ''.
--
-- Deploy: safe to apply BEFORE the M7 code (nothing calls the RPCs yet; the
-- orders changes are new nullable columns + a wider check).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) orders
-- ---------------------------------------------------------------------------
alter table public.orders
  add column stripe_payment_intent_id text,
  add column paid_at                  timestamptz,
  add column refunded_at              timestamptz,
  add column livemode                 boolean;

alter table public.orders
  add constraint orders_stripe_payment_intent_id_key unique (stripe_payment_intent_id);

alter table public.orders drop constraint orders_status_check;
alter table public.orders
  add constraint orders_status_check check (
    status in ('pending', 'paid', 'failed', 'expired', 'refunded', 'disputed')
  );

create unique index orders_one_pending_per_book
  on public.orders (book_id)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- 2) private.stripe_events — webhook idempotency (service role only)
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.stripe_events (
  id           text primary key,
  type         text not null,
  created_at   timestamptz not null default now(),
  processed_at timestamptz,
  constraint stripe_events_id_length check (char_length(id) between 1 and 255),
  constraint stripe_events_type_length check (char_length(type) between 1 and 100)
);

alter table private.stripe_events enable row level security;
-- No policies on purpose: clients have no grants; the service role bypasses RLS.

revoke all on table private.stripe_events from public, anon, authenticated;
grant usage on schema private to service_role;
grant select, insert, update on table private.stripe_events to service_role;

-- ---------------------------------------------------------------------------
-- 3) fulfill_book_checkout — webhook fulfilment (semantics in header)
-- ---------------------------------------------------------------------------
create or replace function public.fulfill_book_checkout(
  p_event_id       text,
  p_event_type     text,
  p_session_id     text,
  p_payment_intent text,
  p_book_id        uuid,
  p_user_id        uuid,
  p_amount         integer,
  p_currency       text,
  p_livemode       boolean
)
returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_inserted text;
  v_book     uuid;
  v_was_paid boolean;
  v_user     uuid;
begin
  if p_event_id is null or p_event_type is null or p_session_id is null
     or p_book_id is null or p_user_id is null or p_amount is null
     or p_currency is null or p_livemode is null
     or char_length(p_event_id) = 0 or char_length(p_event_type) = 0
     or char_length(p_session_id) = 0 or char_length(p_currency) = 0
     or p_amount < 0
     or (p_payment_intent is not null and char_length(p_payment_intent) = 0) then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  insert into private.stripe_events (id, type)
  values (p_event_id, p_event_type)
  on conflict (id) do nothing
  returning id into v_inserted;
  if v_inserted is null then
    return 'duplicate';
  end if;

  select b.id, b.is_paid into v_book, v_was_paid
    from public.books as b
   where b.id = p_book_id and b.user_id = p_user_id
     for update;

  -- profiles row exists for every auth user (handle_new_user) and cascades with it
  select pr.id into v_user from public.profiles as pr where pr.id = p_user_id;

  insert into public.orders as o
    (user_id, book_id, type, amount, currency, status, stripe_session_id,
     stripe_payment_intent_id, paid_at, livemode)
  values
    (v_user, v_book, 'digital', p_amount, lower(p_currency), 'paid', p_session_id,
     p_payment_intent, now(), p_livemode)
  on conflict (stripe_session_id) do update
     set status = case when o.status in ('refunded', 'disputed') then o.status else 'paid' end,
         paid_at = coalesce(o.paid_at, excluded.paid_at),
         stripe_payment_intent_id = coalesce(excluded.stripe_payment_intent_id, o.stripe_payment_intent_id),
         amount = excluded.amount,
         currency = excluded.currency,
         livemode = excluded.livemode,
         user_id = excluded.user_id,
         book_id = excluded.book_id;

  update private.stripe_events as e set processed_at = now() where e.id = p_event_id;

  if v_book is null then
    return 'book_missing';
  end if;

  update public.books as b
     set is_paid = true, max_pages = 100, expires_at = null
   where b.id = v_book and b.user_id = p_user_id;

  if v_was_paid then
    return 'already_paid';
  end if;
  return 'fulfilled';
end;
$$;

revoke all on function public.fulfill_book_checkout(text, text, text, text, uuid, uuid, integer, text, boolean)
  from public, anon, authenticated;
grant execute on function public.fulfill_book_checkout(text, text, text, text, uuid, uuid, integer, text, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4) record_stripe_order_event — expired / failed / refunded / disputed
-- ---------------------------------------------------------------------------
create or replace function public.record_stripe_order_event(
  p_event_id       text,
  p_event_type     text,
  p_session_id     text,
  p_payment_intent text,
  p_status         text,
  p_livemode       boolean
)
returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_inserted text;
  v_order    uuid;
  v_status   text;
  v_new      text;
begin
  if p_event_id is null or p_event_type is null or p_status is null or p_livemode is null
     or char_length(p_event_id) = 0 or char_length(p_event_type) = 0
     or (p_session_id is null and p_payment_intent is null)
     or (p_session_id is not null and char_length(p_session_id) = 0)
     or (p_payment_intent is not null and char_length(p_payment_intent) = 0)
     or p_status not in ('expired', 'failed', 'refunded', 'disputed') then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  insert into private.stripe_events (id, type)
  values (p_event_id, p_event_type)
  on conflict (id) do nothing
  returning id into v_inserted;
  if v_inserted is null then
    return 'duplicate';
  end if;

  if p_session_id is not null then
    select o.id, o.status into v_order, v_status
      from public.orders as o
     where o.stripe_session_id = p_session_id
       for update;
  else
    select o.id, o.status into v_order, v_status
      from public.orders as o
     where o.stripe_payment_intent_id = p_payment_intent
       for update;
  end if;

  update private.stripe_events as e set processed_at = now() where e.id = p_event_id;

  if v_order is null then
    return 'order_missing';
  end if;

  v_new := case
    when p_status in ('expired', 'failed') and v_status = 'pending' then p_status
    when p_status = 'refunded' and v_status <> 'refunded' then 'refunded'
    when p_status = 'disputed' and v_status not in ('refunded', 'disputed') then 'disputed'
    else null
  end;

  update public.orders as o
     set status = coalesce(v_new, o.status),
         refunded_at = case when v_new = 'refunded' then coalesce(o.refunded_at, now()) else o.refunded_at end,
         stripe_payment_intent_id = coalesce(o.stripe_payment_intent_id, p_payment_intent),
         livemode = coalesce(o.livemode, p_livemode)
   where o.id = v_order;

  if v_new is null then
    return 'unchanged';
  end if;
  return 'updated';
end;
$$;

revoke all on function public.record_stripe_order_event(text, text, text, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.record_stripe_order_event(text, text, text, text, text, boolean)
  to service_role;
