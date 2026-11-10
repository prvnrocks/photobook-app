-- =============================================================================
-- 20261112001300_payments_review.sql — Milestone 7 review fixes (S1, S3, N2)
--
-- Additive only: 0100–1200 are applied in production and must not be edited.
-- Both RPCs keep their exact signatures and `returns text`, so they are replaced
-- in place (create or replace); grants are re-asserted anyway.
--
-- 1) public.orders status check widened with 'needs_review' (S1): a Checkout
--    Session that Stripe reports as PAID but that fails our validation (amount /
--    currency / reference …) is never fulfilled; the webhook records it so a human
--    can look at it (refund or fulfil manually). Moving the order out of
--    'pending' also frees orders_one_pending_per_book, and the upgrade action
--    refuses to start a new Checkout while a 'needs_review' order exists for the
--    book (no second charge).
--
-- 2) public.record_stripe_order_event accepts p_status 'needs_review'.
--    Transition: needs_review only from pending / expired / failed (a paid,
--    refunded or disputed order is never moved; repeating it → 'unchanged').
--    Everything else is unchanged from 1200.
--
-- 3) public.fulfill_book_checkout (S3, N2):
--      * new result 'already_paid_other_session': the book was already paid AND
--        another order for the book with a DIFFERENT stripe_session_id is
--        'paid' or 'disputed' (money still taken) → the user has paid twice; the
--        webhook logs it for a refund. ('refunded' orders don't count: that
--        money went back.) The order for this session is still recorded 'paid'.
--      * the books UPDATE is skipped when the book is already paid and the
--        entitlement columns already match (max_pages = 100, expires_at null),
--        so a replayed / second event doesn't bump books.updated_at.
--    Results: fulfilled | already_paid | already_paid_other_session |
--             book_missing | duplicate. 22023 on invalid arguments (unchanged).
--
-- Both remain SECURITY INVOKER, search_path '', EXECUTE for service_role only.
--
-- Deploy: apply BEFORE the code that sends 'needs_review' (order 1300 →
-- rls_check → code). Either order is safe: the old function raises 22023 on
-- 'needs_review' and the new webhook answers 200 + logs invalid_argument (only
-- the mark is lost, the paid_but_invalid error log remains); the old webhook
-- doesn't know 'already_paid_other_session' → one 500, and Stripe's retry is
-- then a 'duplicate' (200) — the book is paid either way.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) orders.status + needs_review
-- ---------------------------------------------------------------------------
alter table public.orders drop constraint orders_status_check;
alter table public.orders
  add constraint orders_status_check check (
    status in ('pending', 'paid', 'failed', 'expired', 'refunded', 'disputed', 'needs_review')
  );

-- ---------------------------------------------------------------------------
-- 2) record_stripe_order_event — + needs_review
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
     or p_status not in ('expired', 'failed', 'refunded', 'disputed', 'needs_review') then
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
    when p_status = 'needs_review' and v_status in ('pending', 'expired', 'failed') then 'needs_review'
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

-- ---------------------------------------------------------------------------
-- 3) fulfill_book_checkout — already_paid_other_session, no-op re-assert skipped
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
  v_inserted  text;
  v_book      uuid;
  v_was_paid  boolean;
  v_max_pages integer;
  v_expires   timestamptz;
  v_user      uuid;
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

  select b.id, b.is_paid, b.max_pages, b.expires_at
    into v_book, v_was_paid, v_max_pages, v_expires
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

  if not (v_was_paid and v_max_pages = 100 and v_expires is null) then
    update public.books as b
       set is_paid = true, max_pages = 100, expires_at = null
     where b.id = v_book and b.user_id = p_user_id;
  end if;

  if v_was_paid then
    if exists (select 1 from public.orders as o2
                where o2.book_id = v_book
                  and o2.stripe_session_id is distinct from p_session_id
                  and o2.status in ('paid', 'disputed')) then
      return 'already_paid_other_session';
    end if;
    return 'already_paid';
  end if;
  return 'fulfilled';
end;
$$;

revoke all on function public.fulfill_book_checkout(text, text, text, text, uuid, uuid, integer, text, boolean)
  from public, anon, authenticated;
grant execute on function public.fulfill_book_checkout(text, text, text, text, uuid, uuid, integer, text, boolean)
  to service_role;
